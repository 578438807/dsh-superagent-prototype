/**
 * Host-side acceptance for a rule's ticket: the checks the platform runs itself before a `ready` report counts as
 * done. Hard checks are deterministic and parsed from short strings; the soft check asks a model to read the worker's
 * report against the rule's subjective criteria. The host — not the worker — decides, so a report cannot skip them.
 *
 * A hard check is one of five forms: `cmd:` (exit 0), `file:` (exists, non-empty), `json: <path>#<dotted>=<value>`,
 * `date: <path>#<dotted>` (today in Asia/Shanghai), and `edge:` — a relation between two artifacts, which the other
 * four cannot express: they say something about one file, never that A's products actually reached B's input.
 *
 *   edge: <left-path>#<left-selector> -> <right-path>#<right-selector> [>= | == | <= <n>] [allow-empty]
 *
 * A selector takes a set out of a parsed document in one of three ways: a field (`combos[].factor` maps every item),
 * a filtered array (`factors[status=admitted].name` keeps the items whose field matches), or `keys()` (an object's
 * keys, for a catalog keyed by name). A plain field whose value is an array contributes its items, so a scalar on the
 * left and a list of names on the right is a well-formed relation. Members are compared as text (numbers by
 * `String()`); any other type is a type error rather than an invented match.
 * ponytail: steps split on `.` and a filter matches by text, so a filter value may not contain a dot; extend the
 * grammar when a real artifact needs one.
 *
 * With no comparator the check is `left ⊆ right`: every left member must appear on the right. A comparator counts the
 * left members that do appear: `>= 3` needs at least three, `== 3` exactly three, `<= 1` at most one. An empty left set
 * always fails — a subset relation over nothing is vacuously true and nearly always means a wrong selector or an upstream
 * artifact that produced nothing — and `allow-empty` is the only thing that excuses it, with or without a comparator.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Rule } from '../policy.ts'
import type { Commands } from '../infra/commands.ts'

export interface Verdict {
  passed: boolean
  reasons: string[]
  /** Check expressions that could not be understood; a typo must fail loudly rather than silently pass. */
  invalid: string[]
}

/**
 * Whether a ready report that claims `no_new_work` also names the artifact it checked. The flag stops a loop window
 * asking, so a bare "no new work" must not be enough: the summary has to point at a file with an extension, which is
 * something a person can open and compare. Any other report keeps the ordinary acceptance verdict, so the flag can never
 * stand in for the checks.
 * ponytail: an artifact path is the whole test; a rule whose honest idle reason is pure prose falls back to acceptance.
 * Extend this when a real rule needs such a reason (a date, a count) to count.
 */
export function idleReason(summary: string): boolean {
  return /[\w~.-]*[\\/][\w./\\-]*\.[\w-]+/.test(summary)
}

/** Reads a dotted path (`a.b.0.c`) out of parsed JSON; `undefined` when any step is missing. */
function at(value: unknown, path: string): unknown {
  let cursor: unknown = value
  for (const step of path.split('.').filter(Boolean)) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[step]
  }
  return cursor
}

/** One step of an `edge:` selector: a field, whether it is an array field, and the `[field=value]` filter it keeps. */
interface SelectorStep {
  name: string
  items: boolean
  filter?: { field: string; value: string }
}

/** How an `edge:` selector takes a set out of one parsed artifact: an object's keys, or a walk of field steps. */
type Selector = { kind: 'keys' } | { kind: 'steps'; steps: SelectorStep[] }

/** One step: `name`, `name[]`, `name[field=value]`, or `name[][field=value]`. */
const SELECTOR_STEP = /^([A-Za-z_$][\w$-]*)(\[\])?(?:\[([^[\]=]+)=([^[\]]*)\])?$/

/**
 * A member both sides can compare: text as writ, a number by its text form. Anything else is a type the relation
 * cannot mean, so it is an error rather than an invented match — `true` must never equal the text `"true"`.
 * ponytail: only text and numbers compare; a catalog keyed by booleans needs a selector that names its text field.
 */
function member(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  const shown = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  throw new Error(`${label} selects a ${shown} member, which cannot compare; select text or numbers`)
}

/** Parse one `edge:` selector; throws on a shape the host cannot read, so a typo never passes. */
function parseSelector(text: string): Selector {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty selector')
  if (trimmed === 'keys()') return { kind: 'keys' }
  if (trimmed.includes('(') || trimmed.includes(')')) throw new Error(`the only call a selector takes is keys(), got "${trimmed}"`)
  const steps = trimmed.split('.').map(part => {
    const match = SELECTOR_STEP.exec(part.trim())
    if (!match) throw new Error(`unreadable selector step "${part}"`)
    const [, name, items, field, value] = match
    return { name: name!, items: Boolean(items), ...(field ? { filter: { field, value: value! } } : {}) }
  })
  return { kind: 'steps', steps }
}

/** Take the set a selector names out of one parsed artifact; throws when the shape is not the one it names. */
function selectSet(document: unknown, selector: Selector): unknown[] {
  if (selector.kind === 'keys') {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('keys() needs an object')
    return Object.keys(document as Record<string, unknown>)
  }
  let cursor: unknown[] = [document]
  for (const step of selector.steps) {
    const next: unknown[] = []
    for (const node of cursor) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        const shown = node === null ? 'null' : Array.isArray(node) ? 'an array' : `a ${typeof node}`
        throw new Error(`"${step.name}" is read off ${shown}, not an object`)
      }
      const value = (node as Record<string, unknown>)[step.name]
      if (value === undefined) throw new Error(`no field "${step.name}"`)
      if (step.filter) {
        if (!Array.isArray(value)) throw new Error(`"${step.name}" is filtered but is not an array`)
        const { field, value: wanted } = step.filter
        next.push(...value.filter(item => item !== null && typeof item === 'object' && String((item as Record<string, unknown>)[field]) === wanted))
      } else if (step.items) {
        if (!Array.isArray(value)) throw new Error(`"${step.name}[]" is not an array`)
        next.push(...value)
      } else next.push(value)
    }
    cursor = next
  }
  // A field that holds an array contributes its items, so `tags` and `tags[]` mean the same set.
  return cursor.flatMap(value => Array.isArray(value) ? value : [value])
}

/** One `edge:` expression: the two sides, the comparator, and whether an empty left set was declared expected. */
interface EdgeExpression {
  leftPath: string
  leftSelector: Selector
  rightPath: string
  rightSelector: Selector
  compare?: { op: '>=' | '<=' | '=='; count: number }
  allowEmpty: boolean
}

/** Parse one `edge:` body; throws with a message naming what it could not read. */
function parseEdge(body: string): EdgeExpression {
  const arrow = body.indexOf('->')
  if (arrow < 0) throw new Error('missing "->"')
  const split = (text: string, side: string): { path: string; selector: string } => {
    const hash = text.lastIndexOf('#')
    if (hash < 0) throw new Error(`the ${side} side has no "#<selector>"`)
    const path = text.slice(0, hash).trim()
    if (!path) throw new Error(`the ${side} side has no path`)
    return { path, selector: text.slice(hash + 1).trim() }
  }
  const left = split(body.slice(0, arrow).trim(), 'left')
  if (!left.selector || /\s/.test(left.selector)) throw new Error(`unreadable left selector "${left.selector}"`)
  const right = split(body.slice(arrow + 2).trim(), 'right')
  const [rightSelector, ...flags] = right.selector.split(/\s+/).filter(Boolean)
  if (!rightSelector) throw new Error('the right side has no selector')
  let compare: EdgeExpression['compare']
  let allowEmpty = false
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === 'allow-empty') { allowEmpty = true; continue }
    const joined = /^(>=|<=|==)$/.test(flag) ? `${flag}${flags[++index] ?? ''}` : flag
    const counted = /^(>=|<=|==)(\d+)$/.exec(joined)
    if (!counted) throw new Error(`unreadable edge flag "${flag}"`)
    if (compare) throw new Error('only one comparator per edge check')
    compare = { op: counted[1] as '>=' | '<=' | '==', count: Number(counted[2]) }
  }
  return { leftPath: left.path, leftSelector: parseSelector(left.selector), rightPath: right.path,
    rightSelector: parseSelector(rightSelector), ...(compare ? { compare } : {}), allowEmpty }
}

/** Lists at most a dozen members in a reason, so one failure stays readable. */
function listed(values: readonly string[]): string {
  const shown = values.slice(0, 12).join(', ')
  return values.length > 12 ? `${shown} (+${values.length - 12} more)` : shown
}

/**
 * Judge one `edge:` check: read both artifacts, take each side's set, and compare them as sets — never as text, and
 * never by merely asking whether both files exist. `understood: false` marks a selector the host cannot apply, a
 * missing file or a type it cannot compare: that goes to `invalid` and fails loudly, with the detail in `reasons`.
 * A well-formed comparison that comes out false is a plain reason.
 */
function checkEdge(body: string, cwd: string): { reasons: string[]; understood: boolean } {
  let expression: EdgeExpression
  try {
    expression = parseEdge(body)
  } catch (error) {
    return { reasons: [`hard edge unusable: ${body} — ${(error as Error).message}`], understood: false }
  }
  const read = (path: string, side: string): unknown => {
    const full = absolute(path, cwd)
    if (!existsSync(full)) throw new Error(`${side} file missing: ${path}`)
    try {
      return JSON.parse(readFileSync(full, 'utf8'))
    } catch (error) {
      throw new Error(`${side} unreadable JSON: ${path} — ${(error as Error).message}`)
    }
  }
  let left: string[]
  let right: Set<string>
  try {
    left = selectSet(read(expression.leftPath, 'left'), expression.leftSelector).map(value => member(value, 'left side'))
    right = new Set(selectSet(read(expression.rightPath, 'right'), expression.rightSelector).map(value => member(value, 'right side')))
  } catch (error) {
    return { reasons: [`hard edge unusable: ${body} — ${(error as Error).message}`], understood: false }
  }
  const distinct = [...new Set(left)]
  const present = distinct.filter(value => right.has(value))
  const missing = distinct.filter(value => !right.has(value))
  // An empty left set is the suspect case, so it fails before either comparison — a comparator must not turn `0 of 0`
  // into a pass. `allow-empty` is what says such a left side is expected; a comparator beside it still counts.
  if (distinct.length === 0 && !expression.allowEmpty) {
    return { reasons: [`hard edge empty left set: ${body} — ${expression.leftPath} selected nothing; write allow-empty if that is expected`], understood: true }
  }
  if (expression.compare) {
    const { op, count } = expression.compare
    const ok = op === '>=' ? present.length >= count : op === '<=' ? present.length <= count : present.length === count
    if (!ok) return { reasons: [`hard edge ${op} ${count} failed: ${body} — ${present.length} of ${distinct.length} left member(s) appear on the right`], understood: true }
    return { reasons: [], understood: true }
  }
  if (missing.length === 0) return { reasons: [], understood: true }
  return { reasons: [`hard edge missing ${missing.length} of ${distinct.length}: ${body} — on the left but not the right: ${listed(missing)}`], understood: true }
}

/** Today's wall-clock date in Asia/Shanghai, the zone the cron Source schedules in. */
export function today(at: Date = new Date()): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

/**
 * The shell used for `cmd:` checks on Windows. Prefer PowerShell 7 when it is installed, but fall back to the
 * Windows PowerShell that ships with every supported Windows build: the host runs on minimal images where `pwsh`
 * (and even `PATH` entries for it) may be absent, and a missing shell must not fail every acceptance check.
 */
function windowsShell(): string {
  const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'].find(candidate => existsSync(candidate))
  return pwsh ?? 'powershell.exe'
}

/**
 * Elapsed minutes of the latest assignment: the budget and the recorded duration describe the run being judged, not the
 * ticket's whole history, so a retried ticket measures from the assignment that produced the report.
 */
export function elapsedMinutes(assignments: readonly { createdAt: string; startedAt?: string }[], at: number = Date.now()): number {
  const latest = assignments[assignments.length - 1]
  const startedAt = latest?.startedAt ?? latest?.createdAt
  return startedAt ? Math.max(0, (at - Date.parse(startedAt)) / 60000) : 0
}

/**
 * Runs the hard checks of `rule` in `cwd`. Supported forms, one per string:
 * `cmd: <command>` (exit 0), `file: <path>` (exists, non-empty), `json: <path>#<dotted.path>=<value>`,
 * `date: <path>#<dotted.path>` (equals today in Asia/Shanghai), and `edge:` (the relation the module docstring
 * describes). Anything the host cannot parse fails loudly through `invalid`.
 */
export async function checkHard(commands: Commands, rule: Rule, cwd: string, signal: AbortSignal): Promise<Verdict> {
  const reasons: string[] = []
  const invalid: string[] = []
  for (const check of rule.acceptance?.hard ?? []) {
    const colon = check.indexOf(':')
    const kind = colon > 0 ? check.slice(0, colon).trim() : ''
    const body = check.slice(colon + 1).trim()
    if (kind === 'cmd') {
      const shell = process.platform === 'win32' ? windowsShell() : 'sh'
      const argv = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', body] : ['-c', body]
      try {
        await commands.withSignal(signal).run(shell, argv, cwd)
      } catch (error) {
        reasons.push(`hard cmd failed: ${body} — ${(error as Error).message}`)
      }
      continue
    }
    if (kind === 'file') {
      const path = absolute(body, cwd)
      if (!existsSync(path)) reasons.push(`hard file missing: ${body}`)
      else if (statSync(path).size === 0) reasons.push(`hard file empty: ${body}`)
      continue
    }
    if (kind === 'json' || kind === 'date') {
      const hash = body.indexOf('#')
      if (hash < 0) { invalid.push(check); continue }
      const path = absolute(body.slice(0, hash).trim(), cwd)
      const pointer = body.slice(hash + 1).trim()
      if (!existsSync(path)) { reasons.push(`hard ${kind} file missing: ${body.slice(0, hash).trim()}`); continue }
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        reasons.push(`hard ${kind} unreadable JSON: ${body} — ${(error as Error).message}`)
        continue
      }
      if (kind === 'date') {
        const got = String(at(parsed, pointer) ?? '')
        const want = today()
        if (got.slice(0, 10) !== want) reasons.push(`hard date stale: ${body} is ${got || '(missing)'}, expected ${want}`)
        continue
      }
      const [left, expected] = pointer.split('=')
      const got = at(parsed, left?.trim() ?? '')
      if (JSON.stringify(got) !== JSON.stringify(expected?.trim())) {
        reasons.push(`hard json mismatch: ${body} is ${JSON.stringify(got) ?? '(missing)'}`)
      }
      continue
    }
    if (kind === 'edge') {
      const verdict = checkEdge(body, cwd)
      reasons.push(...verdict.reasons)
      // A selector the host could not apply keeps `invalid.push(check)`: the expression itself is unusable, so the
      // verdict says so in the same field a typo lands in.
      if (!verdict.understood) invalid.push(check)
      continue
    }
    invalid.push(check)
  }
  return { passed: reasons.length === 0 && invalid.length === 0, reasons, invalid }
}

/** One action a plan declares: what it does and which approval class it belongs to. */
interface PlannedAction { step?: string; class?: string }
interface Plan { plan?: PlannedAction[] }
interface Approval { ticket?: string; class?: string }

/** Parse one JSON line, or undefined when the line is not JSON. */
function parseLine(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** Read a text artifact the soft reviewer may judge against, or '' when it is absent or unreadable. */
function readEvidence(path: string): string {
  try { return readFileSync(path, 'utf8').slice(0, 12000) } catch { return '' }
}

/** Read one JSON file, or undefined when it is absent or unreadable. */
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/**
 * Check a ticket's declared plan against its rule's approval classes. A class the rule never allows fails outright; a class
 * that needs a person fails until `catalog/approvals.jsonl` holds that ticket's approval for it. No plan means nothing was
 * declared, which the audit catches as an undeclared change rather than failing every report.
 */
export function checkApprovals(rule: Rule, cwd: string, ticketId: string): Verdict {
  const reasons: string[] = []
  const plan = readJson(absolute(`outputs/plans/${ticketId}.json`, cwd)) as Plan | undefined
  const classes = new Set((plan?.plan ?? []).map(action => action.class).filter((name): name is string => Boolean(name)))
  if (classes.size === 0) return { passed: true, reasons, invalid: [] }
  const never = new Set(rule.approvals?.never ?? [])
  const ask = new Set(rule.approvals?.ask ?? [])
  const approved = new Set<string>()
  const file = absolute('catalog/approvals.jsonl', cwd)
  const log = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  for (const line of log) {
    if (!line.trim()) continue
    const entry = parseLine(line) as Approval | undefined
    if (entry?.ticket === ticketId && entry.class) approved.add(entry.class)
  }
  for (const name of classes) {
    if (never.has(name)) reasons.push(`Approval denied: ${name} is never allowed for rule ${rule.id}.`)
    else if (ask.has(name) && !approved.has(name)) reasons.push(`Approval missing: ${name}`)
  }
  return { passed: reasons.length === 0, reasons, invalid: [] }
}

/** The model route to review with: whatever the reporting worker Session was actually configured with. */
export interface ReviewRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Minimal shape of the llm service used here; the real `LlmRuntime` satisfies it. */
export interface Reviewer {
  stream(options: {
    provider: string
    model: string
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
    system?: string
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

/**
 * Asks a model whether the report satisfies the rule's soft criteria. Returns `undefined` when there is nothing to
 * judge or no route to judge with, so the caller can fall back to the hard verdict instead of failing the ticket.
 */
export async function reviewSoft(reviewer: Reviewer, route: ReviewRoute | undefined, rule: Rule, report: string, signal: AbortSignal, cwd?: string): Promise<Verdict | undefined> {
  const soft = rule.acceptance?.soft ?? []
  if (soft.length === 0) return undefined
  if (!route?.provider || !route.model) return undefined
  const evidencePath = rule.acceptance?.evidence
  const evidence = evidencePath && cwd ? readEvidence(absolute(evidencePath, cwd)) : ''
  const prompt = [
    `A work ticket for the rule "${rule.name}" reported:`,
    '',
    report.slice(0, 6000),
    '',
    ...(evidence ? [`The report's evidence file ${evidencePath}:`, '', evidence, ''] : []),
    'Judge whether the report satisfies each subjective acceptance criterion below. Judge from the report text and its evidence file; do not assume unstated work happened.',
    ...soft.map((item, index) => `${index + 1}. ${item}`),
    '',
    'Answer with one JSON object and nothing else: {"pass": true|false, "reasons": ["..."]}',
  ].join('\n')
  let text = ''
  let failed = ''
  try {
    for await (const chunk of reviewer.stream({ provider: route.provider, model: route.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal })) {
      if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
    }
  } catch (error) {
    failed = (error as Error).message
  }
  if (failed) return { passed: false, reasons: [`soft reviewer unavailable: ${failed}`], invalid: [] }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { passed: false, reasons: ['soft reviewer answered without JSON'], invalid: [] }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { pass?: unknown; reasons?: unknown }
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
    return { passed: parsed.pass === true, reasons: parsed.pass === true ? [] : reasons.length ? reasons : ['soft reviewer rejected the report'], invalid: [] }
  } catch {
    return { passed: false, reasons: ['soft reviewer answered with unparsable JSON'], invalid: [] }
  }
}
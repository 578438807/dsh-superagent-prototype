/**
 * Host-side acceptance for a rule's ticket: the checks the platform runs itself before a `ready` report counts as
 * done. Hard checks are deterministic and parsed from short strings; the soft check asks a model to read the worker's
 * report against the rule's subjective criteria. The host — not the worker — decides, so a report cannot skip them.
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

/** Reads a dotted path (`a.b.0.c`) out of parsed JSON; `undefined` when any step is missing. */
function at(value: unknown, path: string): unknown {
  let cursor: unknown = value
  for (const step of path.split('.').filter(Boolean)) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[step]
  }
  return cursor
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
 * Runs the hard checks of `rule` in `cwd`. Supported forms, one per string:
 * `cmd: <command>` (exit 0), `file: <path>` (exists, non-empty), `json: <path>#<dotted.path>=<value>`,
 * `date: <path>#<dotted.path>` (equals today in Asia/Shanghai).
 */
/**
 * Elapsed minutes of the latest assignment: the budget and the recorded duration describe the run being judged, not the
 * ticket's whole history, so a retried ticket measures from the assignment that produced the report.
 */
export function elapsedMinutes(assignments: readonly { createdAt: string; startedAt?: string }[], at: number = Date.now()): number {
  const latest = assignments[assignments.length - 1]
  const startedAt = latest?.startedAt ?? latest?.createdAt
  return startedAt ? Math.max(0, (at - Date.parse(startedAt)) / 60000) : 0
}

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
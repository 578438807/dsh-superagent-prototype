/** Cron Source: turns a five-field schedule into one Trigger per fire, so recurring work needs no external scheduler. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { key } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { pause } from './poll.ts'
import type { SourceKind } from './kind.ts'
import { z } from 'zod'

const SOURCE = 'cron'
/** Asia/Shanghai has no DST, so a fixed offset keeps the schedule independent of the machine's time zone. */
const OFFSET = 8 * 3600_000
/** Longest a schedule may wait for its next fire before it is reported as unusable. */
const HORIZON_DAYS = 366

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const LoopWindowSchema = z.object({
  start: z.string().regex(HHMM).default('23:00'),
  cutoff: z.string().regex(HHMM).default('17:50'),
  hardStop: z.string().regex(HHMM).default('18:40'),
}).strict()
const JobSchema = z.object({
  job: z.string().trim().min(1).max(40),
  cron: z.string().trim().min(1).max(80),
  title: z.string().trim().max(200).default(''),
  // The panel writes every row cell as a string, while hand-written JSON may use a boolean.
  onlyTradingDays: z.union([z.boolean(), z.enum(['true', 'false'])]).default(true).transform(value => value === true || value === 'true'),
  loop: z.boolean().optional(),
  window: LoopWindowSchema.optional(),
}).strict()
export type CronJob = z.infer<typeof JobSchema>

const CronConfigSchema = z.object({
  repo: z.string().trim().max(400).default(''),
  jobs: z.array(JobSchema).min(1).default(() => [{ job: 'daily', cron: '30 19 * * 1-5', title: '', onlyTradingDays: true }]),
}).strict()
export type CronConfig = z.infer<typeof CronConfigSchema>

export const cronKind: SourceKind<CronConfig> = {
  kind: SOURCE,
  title: { zh: '定时任务', en: 'Schedule' },
  description: { zh: '按 cron 表达式定时产生一次工作请求；交易日判断与去重都在这一处完成。', en: 'Produces one work request per cron fire; trading-day checks and de-duplication live here.' },
  schema: CronConfigSchema,
  fields: [
    { key: 'jobs', type: 'rows', label: { zh: '定时任务', en: 'Jobs' },
      hint: { zh: '每行一个任务：标识、五段 cron（分 时 日 月 周，支持 *、a-b、a,b、*/n）、显示名、是否只在交易日触发。同一天同一个任务只产生一次 Trigger。', en: 'One job per row: name, five-field cron (minute hour day month weekday; supports *, a-b, a,b and */n), display title, trading-day check. One Trigger per job per day.' },
      columns: [
        { key: 'job', type: 'text', label: { zh: '任务标识', en: 'Job name' } },
        { key: 'cron', type: 'text', label: { zh: 'cron 表达式', en: 'Cron expression' } },
        { key: 'title', type: 'text', optional: true, label: { zh: '显示名', en: 'Display title' } },
        { key: 'onlyTradingDays', type: 'select', label: { zh: '只在交易日', en: 'Trading days only' },
          options: [{ value: 'true', label: { zh: '是', en: 'Yes' } }, { value: 'false', label: { zh: '否', en: 'No' } }] },
      ] },
    { key: 'repo', type: 'text', advanced: true, label: { zh: '交易日历所在目录', en: 'Repository holding the trading calendar' },
      hint: { zh: '读取该目录下 .cache/trade_days_baostock.json；读不到时按周一至周五判断。', en: 'Reads .cache/trade_days_baostock.json under this directory; falls back to Monday-Friday when unreadable.' } },
  ],
  // A cron fire is a machine request; `row` names the admission-table row that admits it.
  scope: () => ({ listened: true, observed: false, row: 'cron' }),
  health: [SOURCE],
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).default([{ id: 'cron' }]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的来源', en: 'Sources that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '标识', en: 'ID' } }] }],
    explicit: { zh: '定时器到点是机器的明确请求，不是人的消息。', en: 'A schedule firing is an explicit request from the machine, not a message from a person.' },
  },
  facts: () => ({}),
}

export const name = 'dsh-superagent-cron'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(cronKind), 'cron: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, cronKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the scheduling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

interface Field { values: Set<number>; wild: boolean }

/** Parses one cron field; returns undefined when any item is malformed or out of range. */
function parseField(text: string, min: number, max: number): Field | undefined {
  const values = new Set<number>()
  let wild = false
  for (const part of text.split(',')) {
    if (part === '*') {
      wild = true
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }
    const step = /^\*\/(\d+)$/.exec(part)
    if (step) {
      const n = Number(step[1])
      if (n < 1) return undefined
      for (let i = min; i <= max; i += n) values.add(i)
      continue
    }
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (a < min || b > max || a > b) return undefined
      for (let i = a; i <= b; i++) values.add(i)
      continue
    }
    if (!/^\d+$/.test(part)) return undefined
    const one = Number(part)
    if (one < min || one > max) return undefined
    values.add(one)
  }
  return values.size ? { values, wild } : undefined
}

/** Next fire strictly after `from`, in Asia/Shanghai; null when the expression is invalid or never fires within a year. */
export function nextFire(expr: string, from: Date): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseField(parts[0]!, 0, 59)
  const hour = parseField(parts[1]!, 0, 23)
  const dom = parseField(parts[2]!, 1, 31)
  const month = parseField(parts[3]!, 1, 12)
  const dow = parseField(parts[4]!, 0, 6)
  if (!minute || !hour || !dom || !month || !dow) return null
  const hours = [...hour.values].sort((a, b) => a - b)
  const minutes = [...minute.values].sort((a, b) => a - b)
  // Work in "shifted" epoch space: the UTC fields of a shifted Date are the wall-clock fields in Shanghai.
  let day = Math.floor((from.getTime() + OFFSET) / 86_400_000) * 86_400_000
  const limit = day + HORIZON_DAYS * 86_400_000
  while (day < limit) {
    const d = new Date(day)
    const domOk = dom.values.has(d.getUTCDate())
    const dowOk = dow.values.has(d.getUTCDay())
    // Vixie semantics: when both day fields are restricted, either one matching is enough.
    const dayOk = dom.wild && dow.wild ? true : dom.wild ? dowOk : dow.wild ? domOk : domOk || dowOk
    if (month.values.has(d.getUTCMonth() + 1) && dayOk) {
      const floor = Math.floor((from.getTime() + OFFSET) / 60_000) * 60_000 + 60_000
      for (const hh of hours) {
        const hourStart = day + hh * 3600_000
        for (const mm of minutes) {
          const at = hourStart + mm * 60_000
          if (at >= floor) return new Date(at - OFFSET)
        }
      }
    }
    day += 86_400_000
  }
  return null
}

/** Wall-clock date (YYYY-MM-DD) of an instant in Asia/Shanghai. */
export function localDate(at: Date): string {
  const d = new Date(at.getTime() + OFFSET)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** True when `day` is a trading day: the calendar wins when it knows the date, otherwise Monday-Friday. */
export function tradeDay(calendar: Record<string, boolean>, day: string): boolean {
  const known = calendar[day]
  if (typeof known === 'boolean') return known
  const [y, m, d] = day.split('-').map(Number)
  const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

async function isTradeDay(repo: string, day: string): Promise<boolean> {
  if (!repo) return tradeDay({}, day)
  try {
    const raw = await readFile(join(repo, '.cache', 'trade_days_baostock.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const calendar = parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {}
    return tradeDay(calendar, day)
  } catch {
    return tradeDay({}, day)
  }
}

function renderText(job: CronJob, day: string): string {
  return `【${job.title || job.job}】${day} 定时任务到点，请处理。job=${job.job}`
}

function renderLoopText(job: CronJob, day: string, round: number): string {
  return `【${job.title || job.job}】${day} 第 ${round} 轮，窗口内循环请处理。job=${job.job} round=${round}
动手前先把计划写到 outputs/plans/<ticketId>.json（ticket/round/why_now/plan[{step,class}]/expected_output/eta_minutes），class 取 read/own-output/data-refresh/script-edit/policy-edit/delete/external-write/caliber 之一；caliber 只指「切换生产主口径」这一件事，复核/校验/断言/对比口径一律算 read 或 own-output，标成 caliber 会让整票被宿主判失败；同时在 outputs/state/<ruleId>.json 维护状态板（standing objective / facts 带日期与证据 / open threads / ruled out / last round）。先写计划再动手，转向要在报告里说明理由。`
}

const wallMinutes = (at: Date) => {
  const local = new Date(at.getTime() + OFFSET)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

const minutesOf = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))

/** True from the loop window start until its cutoff; a start later than the cutoff crosses midnight. */
export function loopActive(window: { start: string; cutoff: string }, at: Date): boolean {
  const now = wallMinutes(at)
  const start = minutesOf(window.start)
  const stop = minutesOf(window.cutoff)
  return start > stop ? now >= start || now < stop : now >= start && now < stop
}

/** Open tickets a cron job opened, so a loop can wait for the previous round to finish before starting the next. */
function openFor(ctx: SourceContext, job: string): string[] {
  return ctx.tickets
    .open()
    .filter(ticket => ticket.origin.triggerIds.some(id => (ctx.triggers.get(id)?.meta as { job?: string } | undefined)?.job === job))
    .map(ticket => ticket.id)
}

/**
 * Whether a ticket already reported failed or blocked: it is waiting for triage rather than for work, so it must not
 * hold the loop. A retried ticket starts a fresh assignment and is live again.
 */
function concluded(ctx: SourceContext, id: string): boolean {
  const ticket = ctx.tickets.get(id)
  const report = ticket?.assignments[ticket.assignments.length - 1]?.report
  return report?.state === 'failed' || report?.state === 'blocked'
}

/** Whether a round is still waiting for its verdict: the thread holds its trigger or its evaluation. */
function roundPending(ctx: SourceContext, job: string, day: string, round: number): boolean {
  const thread = ctx.threads.get(`${SOURCE}:${job}:${day}:${round}`)
  return thread !== undefined && (thread.evaluating !== undefined || thread.pending.length > 0)
}

/**
 * Whether the last round reported that it found nothing new: the window then stops asking this job rather than repeat
 * the same deliverable, and the next window starts fresh.
 */
function lastRoundIdle(ctx: SourceContext, job: string, day: string, last: number): boolean {
  const decisions = ctx.decisions.byThread(`${SOURCE}:${job}:${day}:${last}`)
  const ticketId = decisions[decisions.length - 1]?.ticketId
  if (ticketId === undefined) return false
  const ticket = ctx.tickets.get(ticketId)
  const report = ticket?.assignments[ticket.assignments.length - 1]?.report
  return report?.no_new_work === true
}

/**
 * How many reports in a row the last rounds of this window burned without a ready verdict: two in a row means the job
 * is not making progress and the window should stop asking until it closes and the next window starts fresh.
 */
function failureStreak(ctx: SourceContext, job: string, day: string, last: number): number {
  const states: string[] = []
  for (let round = last; round > 0 && round > last - 8; round -= 1) {
    const decisions = ctx.decisions.byThread(`${SOURCE}:${job}:${day}:${round}`)
    const ticketId = decisions[decisions.length - 1]?.ticketId
    if (ticketId === undefined) break
    const ticket = ctx.tickets.get(ticketId)
    const reports: string[] = []
    for (const assignment of ticket?.assignments ?? []) {
      const state = assignment.report?.state
      if (state !== undefined) reports.push(state)
    }
    states.unshift(...reports)
  }
  let streak = 0
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const state = states[index]
    if (state !== 'failed' && state !== 'blocked') break
    streak += 1
  }
  return streak
}

/** Never open rounds faster than this, so a job that keeps producing nothing cannot spin. */
const ROUND_FLOOR_MS = 60_000

/** Wait this long after the assessor ignored a round before asking the job for work again. */
const IGNORE_BACKOFF_MS = 15 * 60_000

/** A job that keeps having nothing to do is woken at most this seldom, so an idle window costs a few assessments rather than one per quarter hour. */
const IGNORE_BACKOFF_MAX_MS = 4 * 60 * 60_000

/** How long to wait before the next round after consecutive rounds the assessor ignored for having nothing to do. */
function ignoreBackoff(ctx: SourceContext, job: string, day: string, last: number): { since: string; wait: number } | undefined {
  if (last <= 0) return undefined
  let count = 0
  let since: string | undefined
  for (let round = last; round > 0 && count < 8; round -= 1) {
    const decisions = ctx.decisions.byThread(`${SOURCE}:${job}:${day}:${round}`)
    const decision = decisions[decisions.length - 1]
    if (decision === undefined || decision.kind !== 'ignore') break
    if (since === undefined) since = decision.at
    count += 1
  }
  if (since === undefined) return undefined
  return { since, wait: Math.min(IGNORE_BACKOFF_MS * 2 ** (count - 1), IGNORE_BACKOFF_MAX_MS) }
}

/** The session day a loop round belongs to: after midnight the window belongs to the evening it opened. */
export function loopDay(window: { start: string }, at: Date): string {
  const shifted = wallMinutes(at) < minutesOf(window.start) ? new Date(at.getTime() - 86_400_000) : at
  return localDate(shifted)
}

/** One loop decision: stop overrunning tickets past the hard stop, otherwise open the next round once the previous finished. */
export async function loopStep(ctx: SourceContext, repo: string, job: CronJob, at: Date): Promise<void> {
  const window = job.window
  if (!window || !job.loop) return
  const day = loopDay(window, at)
  if (job.onlyTradingDays && !await isTradeDay(repo, day)) return
  const now = wallMinutes(at)
  const open = openFor(ctx, job.job)
  const live = open.filter(id => !concluded(ctx, id))
  // The hard stop sits after the window's end, so it is checked before the window gate: anything still running at
  // 18:40 is overrun and must be ended rather than silently left behind.
  if (now >= minutesOf(window.hardStop) && now < minutesOf(window.start)) {
    for (const id of open) ctx.tickets.stop(id, 'overrun')
    if (open.length > 0) ctx.report(SOURCE, { state: 'ready', detail: `hard stop ${job.job} ${day}: stopped ${open.length}` })
    return
  }
  if (!loopActive(window, at)) return
  if (live.length > 0) return
  const last = ctx.state.get(KV.cron.round(job.job, day)) ?? 0
  // A round's trigger reaches a ticket about a minute later; without this the next round fires before that verdict exists.
  if (last > 0 && roundPending(ctx, job.job, day, last)) return
  if (last > 0 && lastRoundIdle(ctx, job.job, day, last)) return
  if (last > 0 && failureStreak(ctx, job.job, day, last) >= 2) return
  const backoff = ignoreBackoff(ctx, job.job, day, last)
  if (backoff !== undefined && at.getTime() - new Date(backoff.since).getTime() < backoff.wait) return
  const previous = last > 0 ? ctx.triggers.get(key('loop', job.job, day, String(last))) : undefined
  if (previous && at.getTime() - new Date(previous.at).getTime() < ROUND_FLOOR_MS) return
  const round = last + 1
  if (ctx.triggers.get(key('loop', job.job, day, String(round))) !== undefined) return
  await fire(ctx, repo, job, at, round)
}

export async function fire(ctx: SourceContext, repo: string, job: CronJob, at: Date, round = 0): Promise<void> {
  // A loop round opened before midnight keeps the evening's date as its key even when it fires after midnight.
  const day = job.loop && job.window ? loopDay(job.window, at) : localDate(at)
  if (job.onlyTradingDays && !await isTradeDay(repo, day)) {
    ctx.report(SOURCE, health('ready', 'skipHoliday', { day }))
    return
  }
  const loop = job.loop && job.window !== undefined
  const id = loop ? key('loop', job.job, day, String(round)) : key('cron', job.job, day)
  const thread = loop ? `${job.job}:${day}:${round}` : `${job.job}:${day}`
  if (loop ? ctx.triggers.get(id) !== undefined : ctx.state.get(KV.cron.fired(job.job, day))) {
    ctx.report(SOURCE, health('ready', 'dup', { day }))
    return
  }
  // Write the cursor after receive so a crash mid-fire re-delivers rather than drops the work (at-least-once), and only when
  // the Engine actually stored the Trigger: a 'duplicate' or 'filtered' result must not burn the day's slot.
  const result = await ctx.receive({ id, source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: '' }, human: false, at: at.toISOString(),
    text: loop ? renderLoopText(job, day, round) : renderText(job, day),
    addressed: 'direct', meta: loop ? { job: job.job, day, cron: job.cron, round } : { job: job.job, day, cron: job.cron } })
  if (result !== 'stored') {
    ctx.report(SOURCE, health('ready', 'dup', { day }))
    return
  }
  ctx.threads.describe(`${SOURCE}:${thread}`, { label: job.title || job.job })
  if (loop) ctx.state.set(KV.cron.round(job.job, day), round)
  else ctx.state.set(KV.cron.fired(job.job, day), true)
  ctx.report(SOURCE, { state: 'ready', detail: loop ? `fired ${job.job} ${day} round ${round}` : `fired ${job.job} ${day}`, at: at.toISOString() })
}

/** Earliest upcoming fire across the configured jobs; a job whose expression is unusable never becomes due. */
/** Every job due at the earliest upcoming instant; jobs sharing a slot are returned together so each one fires. */
export function nextDue(config: CronConfig, from: Date): { at: Date; jobs: CronJob[] } | null {
  let at: Date | null = null
  for (const job of config.jobs) {
    const one = nextFire(job.cron, from)
    if (one && (!at || one.getTime() < at.getTime())) at = one
  }
  if (!at) return null
  const jobs = config.jobs.filter(job => nextFire(job.cron, from)?.getTime() === at.getTime())
  return { at, jobs }
}

/** Longest single wait; setTimeout overflows above 2^31-1 ms, so long gaps are re-checked hourly. */
const MAX_PAUSE_MS = 3_600_000

const LOOP_TICK_MS = 15_000

/** Cron fires; only jobs without a loop window take this path. */
async function watchCron(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = ctx.config<CronConfig>(SOURCE)
    if (!config) { await pause(60_000, signal); continue }
    const now = new Date()
    const plain = { repo: config.repo, jobs: config.jobs.filter(job => !job.loop) }
    const bad = plain.jobs.filter(job => nextFire(job.cron, now) === null)
    const due = nextDue(plain, now)
    if (!due) {
      if (bad.length) ctx.report(SOURCE, health('error', 'badCron', { cron: bad.map(job => job.cron).join(', ') }))
      await pause(60_000, signal)
      continue
    }
    if (bad.length) ctx.report(SOURCE, health('error', 'badCron', { cron: bad.map(job => job.cron).join(', ') }))
    await pause(Math.min(MAX_PAUSE_MS, Math.max(0, due.at.getTime() - Date.now())), signal)
    if (signal.aborted) return
    if (due.at.getTime() > Date.now()) continue
    // A capped pause wakes before the slot: recompute instead of firing early, or a long gap burns the day's slot.
    for (const job of due.jobs) {
      try { await fire(ctx, config.repo, job, due.at) } catch (error) {
        // A failed fire must not end the loop, or one transient error would silence the whole schedule.
        ctx.report(SOURCE, { state: 'error', detail: `fire ${job.job} failed: ${String(error)}` })
      }
      if (signal.aborted) return
    }
  }
}

/** Loop jobs: every tick decides whether to open the next round or stop an overrunning ticket at the hard stop. */
async function watchLoops(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = ctx.config<CronConfig>(SOURCE)
    if (config) {
      const now = new Date()
      for (const job of config.jobs) {
        if (!job.loop) continue
        try { await loopStep(ctx, config.repo, job, now) } catch (error) {
          ctx.report(SOURCE, { state: 'error', detail: `loop ${job.job} failed: ${String(error)}` })
        }
        if (signal.aborted) return
      }
    }
    await pause(LOOP_TICK_MS, signal)
  }
}

export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  const starting = ctx.config<CronConfig>(SOURCE)
  if (!starting) { ctx.report(SOURCE, health('paused', 'sourceOff')); await pause(60_000, signal) }
  else {
    const due = nextDue(starting, new Date())
    ctx.report(SOURCE, { state: 'ready', detail: due ? `next ${due.jobs.map(job => job.job).join(', ')} ${due.at.toISOString()}` : 'no job scheduled', at: new Date().toISOString() })
  }
  await Promise.all([watchCron(ctx, signal), watchLoops(ctx, signal)])
}

/** Local directory Source: turns task files in a local folder into work, so the agent can act on this machine without GitHub. */
import type { Context } from '@deepseek-ai/cordis'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { key } from '../core/index.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { pause } from './poll.ts'
import type { SourceKind } from './kind.ts'
import { z } from 'zod'

const SOURCE = 'local'
/** A file whose name ends with this suffix is a task; its text becomes the Trigger text. */
const TASK_SUFFIX = '.task.md'
const DEFAULT_INTERVAL = 60

const LocalConfigSchema = z.object({ root: z.string().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3) }).strict()
export type LocalConfig = z.infer<typeof LocalConfigSchema>

export const localKind: SourceKind<LocalConfig> = {
  kind: SOURCE,
  title: { zh: '本地目录', en: 'Local directory' },
  description: { zh: '把本地目录里的任务文件变成工作；每个 *.task.md 都是一次明确请求，Executor 直接在该目录里运行。', en: 'Task files in a local directory; each *.task.md is an explicit request, and the Executor runs directly in that directory.' },
  schema: LocalConfigSchema,
  fields: [
    { key: 'root', type: 'text', label: { zh: '任务目录', en: 'Task directory' },
      hint: { zh: '一个绝对本地路径；目录内每个 *.task.md 都会被读取一次作为本地任务。Executor 也会在此目录运行，因此会落在当前 HARNESS 工作区。', en: 'An absolute local path; every *.task.md in it is read once as a local task. The Executor runs in this directory too, so it lands in the current HARNESS workspace.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: '多久扫描一次目录找新任务。', en: 'How often the directory is scanned for new tasks.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '报错前的失败轮询次数', en: 'Failed polls before reporting an error' }, hint: { zh: '单次扫描失败会在下一次轮询重试，无需上报。', en: 'A single failed scan is retried on the next poll and need not be reported.' } }],
  health: [SOURCE],
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).default([{ id: 'local' }]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许发起工作的来源', en: 'Sources that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '标识', en: 'ID' } }] }],
    explicit: { zh: '本地目录里的任务文件是明确请求。', en: 'A task file in the local directory is an explicit request.' },
  },
  facts: () => ({}),
}

export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localKind), 'local: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, localKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single read error stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<LocalConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report(SOURCE, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause(Math.max(DEFAULT_INTERVAL, ctx.config<LocalConfig>(SOURCE)?.pollSeconds ?? DEFAULT_INTERVAL) * 1000, signal)
  }
}
/** Reads the task directory once; each new or changed *.task.md becomes one Trigger, deduplicated by content hash in KV. */
async function pollRound(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const started = new Date().toISOString()
  const root = ctx.config<LocalConfig>(SOURCE)?.root.trim() ?? ''
  if (!root) return
  const names = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(TASK_SUFFIX))
    .map(entry => entry.name).sort()
  for (const file of names) {
    if (signal.aborted) return
    const text = await readFile(join(root, file), 'utf8')
    const hash = key(text)
    if (ctx.state.get(KV.local.seen(file))?.hash === hash) continue
    // Write the cursor after receive so a crash mid-round re-delivers rather than drops the task (at-least-once).
    await ctx.receive({ id: key('local-task', file, hash), source: SOURCE, threads: [{ source: SOURCE, id: file }],
      actor: { source: SOURCE, id: 'local' }, human: true, at: started, text, addressed: 'direct', meta: {} })
    ctx.threads.describe(`${SOURCE}:${file}`, { label: file })
    ctx.state.set(KV.local.seen(file), { hash })
  }
  ctx.report(SOURCE, { state: 'ready', detail: `${names.length} task files; next poll in ${DEFAULT_INTERVAL}s`, at: started })
}


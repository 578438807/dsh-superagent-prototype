import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fire, localDate, nextDue, nextFire, productsFingerprint, productsIdle, stampFree, tradeDay } from '../src/sources/cron.ts'
import type { SourceContext } from '../src/sources/host.ts'

const iso = (at: Date | null) => at?.toISOString()

it('computes the next fire for a weekday schedule', () => {
  // 2026-11-06 is a Friday; 20:00 is past the 19:30 slot, so the next fire is Monday.
  const from = new Date('2026-11-06T20:00:00+08:00')
  expect(iso(nextFire('30 19 * * 1-5', from))).toBe('2026-11-09T11:30:00.000Z')
})

it('handles step, list and range fields', () => {
  const from = new Date('2026-11-04T10:07:00+08:00')
  expect(iso(nextFire('*/15 * * * *', from))).toBe('2026-11-04T02:15:00.000Z')
  expect(iso(nextFire('0 9,18 * * *', from))).toBe('2026-11-04T10:00:00.000Z')
  expect(iso(nextFire('0 8-10 * * *', from))).toBe('2026-11-05T00:00:00.000Z')
})

it('rolls over to the next day at midnight', () => {
  const from = new Date('2026-11-04T23:30:00+08:00')
  expect(iso(nextFire('0 0 * * *', from))).toBe('2026-11-04T16:00:00.000Z')
  expect(localDate(new Date('2026-11-04T16:00:00.000Z'))).toBe('2026-11-05')
})

it('treats a restricted day-of-month and weekday as either-or', () => {
  // 2026-11-04 is a Wednesday; the next Monday (11-09) comes before the next 1st (12-01).
  expect(iso(nextFire('0 12 1 * 1', new Date('2026-11-04T00:00:00+08:00')))).toBe('2026-11-09T04:00:00.000Z')
})

it('returns null for impossible expressions', () => {
  expect(nextFire('0 25 * * *', new Date())).toBeNull()
  expect(nextFire('nope', new Date())).toBeNull()
  expect(nextFire('0 0 31 2 *', new Date())).toBeNull()
})

it('prefers the trading calendar and falls back to weekdays', () => {
  expect(tradeDay({ '2026-11-02': false }, '2026-11-02')).toBe(false)
  expect(tradeDay({ '2026-11-07': true }, '2026-11-07')).toBe(true)
  expect(tradeDay({}, '2026-11-02')).toBe(true)
  expect(tradeDay({}, '2026-11-07')).toBe(false)
})

it('picks the earliest due job across the configured jobs', () => {
  const config = {
    repo: '',
    jobs: [
      { job: 'daily-data', cron: '30 19 * * 1-5', title: '', onlyTradingDays: true },
      { job: 'daily-rest', cron: '0 20 * * 1-5', title: '', onlyTradingDays: true },
      { job: 'daily-weekly', cron: '0 10 * * 6', title: '', onlyTradingDays: false },
    ],
  }
  // 2026-11-05 is a Thursday: 19:30 comes before 20:00.
  const first = nextDue(config, new Date('2026-11-05T08:00:00+08:00'))
  expect(first?.jobs[0]?.job).toBe('daily-data')
  expect(iso(first?.at ?? null)).toBe('2026-11-05T11:30:00.000Z')
  // Right after 19:30 the rest batch is next.
  const second = nextDue(config, new Date('2026-11-05T19:31:00+08:00'))
  expect(second?.jobs[0]?.job).toBe('daily-rest')
  expect(iso(second?.at ?? null)).toBe('2026-11-05T12:00:00.000Z')
})

it('ignores jobs whose expression cannot fire', () => {
  const config = {
    repo: '',
    jobs: [
      { job: 'broken', cron: '0 25 * * *', title: '', onlyTradingDays: true },
      { job: 'ok', cron: '0 20 * * 1-5', title: '', onlyTradingDays: true },
    ],
  }
  expect(nextDue(config, new Date('2026-11-05T08:00:00+08:00'))?.jobs[0]?.job).toBe('ok')
  expect(nextDue({ repo: '', jobs: [config.jobs[0]!] }, new Date('2026-11-05T08:00:00+08:00'))).toBeNull()
})

// fire() must not burn the day's slot unless the Engine actually stored the Trigger.
const context = (result: 'stored' | 'duplicate' | 'filtered') => {
  const stores: string[] = []
  const reports: { entry: string; health: { state: string; code?: string } }[] = []
  const describes: string[] = []
  const ctx = {
    receive: async () => result,
    threads: { describe: (key: string) => { describes.push(key) } },
    state: { get: () => undefined, set: (key: string) => { stores.push(key) } },
    report: (entry: string, health: { state: string; code?: string }) => { reports.push({ entry, health }) },
  } as unknown as SourceContext
  return { ctx, stores, reports, describes }
}
const job = { job: 'daily-data', cron: '30 19 * * 1-5', title: '数据底座', onlyTradingDays: false }

it('records the fired cursor when the trigger is stored', async () => {
  const h = context('stored')
  await fire(h.ctx, '', job, new Date('2026-11-04T11:30:00.000Z'))
  expect(h.stores).toEqual(['cron-fired:daily-data:2026-11-04'])
  expect(h.describes).toEqual(['cron:daily-data:2026-11-04'])
  expect(h.reports.at(-1)?.health).toMatchObject({ state: 'ready', detail: 'fired daily-data 2026-11-04' })
})

it('leaves the day open when the trigger is a duplicate or filtered', async () => {
  for (const result of ['duplicate', 'filtered'] as const) {
    const h = context(result)
    await fire(h.ctx, '', job, new Date('2026-11-04T11:30:00.000Z'))
    expect(h.stores).toEqual([])
    expect(h.describes).toEqual([])
    expect(h.reports.at(-1)?.health).toMatchObject({ state: 'ready', code: 'dup' })
  }
})

// The host must be able to see for itself that a completed round added nothing: a worker dropping `no_new_work` must not
// turn every round into another full pass over the same sources.
it('drops timestamp keys so a rebuild with the same findings hashes the same', () => {
  const before = { hypotheses: [{ id: 'LH-1', calmar: 1.2 }], generated_at: '2026-11-07T07:00:00+08:00', source_discovered_built_at: 'a' }
  const after = { hypotheses: [{ id: 'LH-1', calmar: 1.2 }], generated_at: '2026-11-07T15:00:00+08:00', source_discovered_built_at: 'b' }
  expect(stampFree(before)).toEqual(stampFree(after))
  expect(stampFree({ ...before, hypotheses: [{ id: 'LH-1', calmar: 1.9 }] })).not.toEqual(stampFree(before))
  // A key that merely ends in "at" stays a finding: only timestamp keys are dropped.
  expect(stampFree({ format: 'x', at: 1 })).toEqual({ format: 'x' })
})

const loopJob = (products: string) => ({ job: 'daily-learn', cron: '0 20 * * 1-5', title: '', onlyTradingDays: false, products })

it('fingerprints the declared products, ignoring timestamps and retaining a missing one', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cron-products-'))
  try {
    const products = 'hypotheses.json,gone.json'
    await writeFile(join(repo, 'hypotheses.json'), JSON.stringify({ hypotheses: [{ id: 'LH-1' }], generated_at: 'r1' }))
    const first = await productsFingerprint(repo, loopJob(products))
    expect(first).toBeTypeOf('string')
    // Only the rebuild timestamp moved, so the round added nothing and the fingerprint must not move.
    await writeFile(join(repo, 'hypotheses.json'), JSON.stringify({ hypotheses: [{ id: 'LH-1' }], generated_at: 'r2' }))
    expect(await productsFingerprint(repo, loopJob(products))).toBe(first)
    // A real finding moves it, and so does a product that starts existing.
    await writeFile(join(repo, 'hypotheses.json'), JSON.stringify({ hypotheses: [{ id: 'LH-2' }], generated_at: 'r3' }))
    const found = await productsFingerprint(repo, loopJob(products))
    expect(found).not.toBe(first)
    await writeFile(join(repo, 'gone.json'), '{}')
    expect(await productsFingerprint(repo, loopJob(products))).not.toBe(found)
    expect(await productsFingerprint(repo, loopJob(''))).toBeUndefined()
  } finally { await rm(repo, { recursive: true, force: true }) }
})

it('judges a finished round idle only when its products are unchanged', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cron-idle-'))
  try {
    // One seam drives the verdict: the last decision on the round's thread, and the ticket it opened.
    const thread = (round: number) => `cron:daily-learn:2026-11-09:${round}`
    let opened = 1
    const records = new Map<string, unknown>()
    const ctx = {
      state: { get: (k: string) => records.get(k), set: (k: string, v: unknown) => { records.set(k, v) }, keys: () => [] },
      decisions: { byThread: (k: string) => k === thread(opened) ? [{ ticketId: 't1' }] : [] },
      tickets: { get: () => ({ ended: undefined, assignments: [{ report: { state: 'ready' } }] }) },
    } as unknown as SourceContext
    const job = loopJob('hypotheses.json')
    const open = async (round: number) => {
      opened = round
      records.set(`cron-product:daily-learn:2026-11-09:${round}`, { fingerprint: await productsFingerprint(repo, job) })
    }
    await writeFile(join(repo, 'hypotheses.json'), JSON.stringify({ hypotheses: [{ id: 'LH-1' }], generated_at: 'r1' }))
    await open(1)
    // Rebuilt with the same findings: the window stops asking even though the worker never said so.
    await writeFile(join(repo, 'hypotheses.json'), JSON.stringify({ hypotheses: [{ id: 'LH-1' }], generated_at: 'r2' }))
    expect(await productsIdle(ctx, repo, job, '2026-11-09', 1)).toBe(true)
    // A round that wrote a new finding is progress.
    await open(2)
    await writeFile(join(repo, 'hypotheses.json'), JSON.stringify({ hypotheses: [{ id: 'LH-2' }], generated_at: 'r3' }))
    expect(await productsIdle(ctx, repo, job, '2026-11-09', 2)).toBe(false)
    // A round with no recorded baseline, or a job with no products, is not judged here.
    expect(await productsIdle(ctx, repo, job, '2026-11-09', 9)).toBe(false)
    expect(await productsIdle(ctx, repo, loopJob(''), '2026-11-09', 2)).toBe(false)
  } finally { await rm(repo, { recursive: true, force: true }) }
})
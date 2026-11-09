import { expect, it } from 'vitest'
import { fire, localDate, nextDue, nextFire, tradeDay } from '../src/sources/cron.ts'
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
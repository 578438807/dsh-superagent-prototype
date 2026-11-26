import { expect, it } from 'vitest'
import { DEFAULT_SCHEDULE, inWindow, minutesUntilClosed, schedulePaused, type ScheduleConfig } from '../src/schedule.ts'

/** A weekday 23:00 -> 18:00 window, the default the deployment ships with. */
const nights: ScheduleConfig = { mode: 'auto', windows: [{ days: [1, 2, 3, 4, 5], start: '23:00', end: '18:00' }] }
// Wednesday 2026-11-04 10:00 Asia/Shanghai, inside the window.
const wedMorning = new Date('2026-11-04T02:00:00Z')
// Wednesday 20:00 Asia/Shanghai, outside it.
const wedEvening = new Date('2026-11-04T12:00:00Z')

it('treats an always-on schedule as open and an off one as paused', () => {
  expect(schedulePaused({ mode: 'on', windows: [] }, wedEvening)).toBe(false)
  expect(schedulePaused({ mode: 'off', windows: [] }, wedMorning)).toBe(true)
  // Auto with no windows means always on.
  expect(schedulePaused({ mode: 'auto', windows: [] }, wedEvening)).toBe(false)
})

it('keeps a cross-midnight window open on both sides of midnight and shut on rest days', () => {
  expect(inWindow(nights.windows, wedMorning)).toBe(true)
  expect(inWindow(nights.windows, wedEvening)).toBe(false)
  // Thursday 01:00 is still the Wednesday-start window.
  expect(inWindow(nights.windows, new Date('2026-11-04T17:00:00Z'))).toBe(true)
  // Saturday 10:00 is a rest day: fully shut, as the user asked for weekends off.
  expect(inWindow(nights.windows, new Date('2026-11-07T02:00:00Z'))).toBe(false)
})

it('reports the minutes until the window closes, or null when it never does', () => {
  // Wednesday 17:00 Shanghai -> closes at 18:00, an hour away.
  expect(minutesUntilClosed(nights, new Date('2026-11-04T09:00:00Z'))).toBe(60)
  expect(minutesUntilClosed({ mode: 'on', windows: [] }, wedMorning)).toBeNull()
  expect(minutesUntilClosed(nights, wedEvening)).toBeNull()
})

it('ships a default that is auto and weekday-nights', () => {
  expect(DEFAULT_SCHEDULE.mode).toBe('auto')
  expect(DEFAULT_SCHEDULE.windows).toEqual([{ days: [1, 2, 3, 4, 5], start: '23:00', end: '18:00' }])
})

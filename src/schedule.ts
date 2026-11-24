/** Day-of-week run windows that decide when processing is allowed. */
import { z } from 'zod'
import { LIMITS } from './limits.ts'

const Offset = 8 * 3600_000
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export const ScheduleWindowSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1),
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
  })
  .strict()

export const ScheduleConfigSchema = z
  .object({
    mode: z.enum(['auto', 'on', 'off']).default('auto'),
    windows: z.array(ScheduleWindowSchema).max(LIMITS.scheduleWindows.max).default([]),
  })
  .strict()

export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>

/** Default: weekdays 23:00 -> next day 18:00 (Asia/Shanghai). */
export const DEFAULT_SCHEDULE: ScheduleConfig = {
  mode: 'auto',
  windows: [{ days: [1, 2, 3, 4, 5], start: '23:00', end: '18:00' }],
}

const minutes = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))

/** ISO weekday, Monday=1 .. Sunday=7. */
const weekday = (at: Date): number => {
  const day = new Date(at.getTime() + Offset).getUTCDay()
  return day === 0 ? 7 : day
}

const wallMinutes = (at: Date): number => {
  const local = new Date(at.getTime() + Offset)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

export function inWindow(windows: readonly ScheduleWindow[], at: Date): boolean {
  const day = weekday(at)
  const now = wallMinutes(at)
  // A cross-midnight window keeps the same weekdays on both sides: a weekday
  // 23:00 -> 18:00 window runs early and late on weekdays, never on a rest day.
  return windows.some(window => {
    const start = minutes(window.start)
    const end = minutes(window.end)
    if (start <= end) return window.days.includes(day) && now >= start && now < end
    return window.days.includes(day) && (now >= start || now < end)
  })
}

/** Whether the schedule holds processing right now. No windows in auto mode means always on. */
export function schedulePaused(schedule: ScheduleConfig, at: Date): boolean {
  if (schedule.mode === 'off') return true
  if (schedule.mode === 'on') return false
  return schedule.windows.length > 0 && !inWindow(schedule.windows, at)
}

/** Whole minutes until the schedule pauses, or null when it never does or is already paused. */
export function minutesUntilClosed(schedule: ScheduleConfig, at: Date): number | null {
  if (schedulePaused(schedule, at)) return null
  const step = 60_000
  for (let index = 1; index <= 60 * 24 * 8; index += 1) {
    if (schedulePaused(schedule, new Date(at.getTime() + index * step))) return index
  }
  return null
}

/** The next moment processing becomes allowed, for reporting. */
export function nextOpen(schedule: ScheduleConfig, at: Date): Date | null {
  if (schedule.mode === 'on') return null
  const step = 60_000
  for (let index = 0; index <= 60 * 24 * 8; index += 1) {
    const candidate = new Date(at.getTime() + index * step)
    if (!schedulePaused(schedule, candidate)) return candidate
  }
  return null
}

// @vitest-environment jsdom
// The Run windows settings group: mode, day-of-week windows and their bounds.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { LIMITS } from '../src/limits.ts'
import { usePanel, mount, all, find, tab, click, type, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const open = async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.schedule'], '.dt-settings-link'))
}
it('shows the run windows as a settings group of its own, saving the mode and each window against the schedule revision', async () => {
  await open()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.schedule'])
  // The mode is a three-way choice, and the fixture's schedule is Auto with no windows.
  expect(all('[role="tab"][aria-selected="true"]').map(tab => tab.textContent)).toContain(zh['scheduleModeOption.auto'])
  await click(zh['scheduleModeOption.on'])
  await click(find(zh.addScheduleWindow, '.dt-form button'))
  await type(field<HTMLInputElement>(zh.scheduleWindowStart.replace('{index}', '1')), '23:00')
  await type(field<HTMLInputElement>(zh.scheduleWindowEnd.replace('{index}', '1')), '18:00')
  await click(zh['weekday.6'])
  await click(zh.save)
  expect(server.settings.schedule).toEqual({ mode: 'on', windows: [{ days: [1, 2, 3, 4, 5, 7], start: '23:00', end: '18:00' }] })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/schedule'])
})

it('stops adding windows at the count the host schema accepts, and removes one', async () => {
  server.settings = { ...server.settings, schedule: { mode: 'auto', windows: [] } }
  await open()
  for (let index = 0; index < LIMITS.scheduleWindows.max; index += 1) await click(find(zh.addScheduleWindow, '.dt-form button'))
  expect(all('.dt-rows-item')).toHaveLength(LIMITS.scheduleWindows.max)
  expect(find(zh.addScheduleWindow, '.dt-form button').hasAttribute('disabled')).toBe(true)
  await click(all('button[aria-label^="移除"]').at(-1)!)
  expect(all('.dt-rows-item')).toHaveLength(LIMITS.scheduleWindows.max - 1)
  expect(find(zh.addScheduleWindow, '.dt-form button').hasAttribute('disabled')).toBe(false)
})

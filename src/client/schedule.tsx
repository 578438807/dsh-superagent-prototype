/** Run-window settings group: when processing may run (mode plus day-of-week windows). */
import { LIMITS } from '../limits.ts'
import { Button, Icon, Input, SegmentedControl } from './controls.tsx'
import type { Settings } from './api.ts'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { valueLabel } from './text.ts'
import { Section } from './widgets.tsx'

type Schedule = Settings['schedule']
type Window = Schedule['windows'][number]

const MODES = ['auto', 'on', 'off'] as const
/** ISO weekdays, Monday=1, as literals so each one names its locale key. */
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const

export function ScheduleSettings() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.schedule
  const draft = useBlockDraft('schedule', block.value, block.revision)
  const value = draft.value
  const edit = (next: Partial<Schedule>) => draft.edit({ ...value, ...next })
  const setWindow = (index: number, next: Window) => edit({ windows: value.windows.map((window, at) => at === index ? next : window) })
  const toggleDay = (index: number, window: Window, day: number) => setWindow(index,
    { ...window, days: window.days.includes(day) ? window.days.filter(item => item !== day) : [...window.days, day] })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('scheduleTitle')}</h2>
          <Section title={t('scheduleMode')} hint={t('scheduleModeHint')}>
            <SegmentedControl className="dt-segmented" label={t('scheduleMode')} value={value.mode}
              onChange={mode => edit({ mode })} options={MODES.map(mode => ({ value: mode, label: valueLabel(t, 'scheduleModeOption', mode),
                title: t(`scheduleModeOption.${mode}`) }))} />
          </Section>
          <div className="dt-field">
            <div className="dt-subhead">
              <span className="dt-field-head">{t('scheduleWindows')}<span className="dt-count">{value.windows.length || ''}</span></span>
              <Button variant="ghost" size="sm" icon={<Icon name="plus" />} disabled={value.windows.length >= LIMITS.scheduleWindows.max}
                onClick={() => edit({ windows: [...value.windows, { days: [...DAYS], start: '00:00', end: '23:59' }] })}>
                {t('addScheduleWindow')}
              </Button>
            </div>
            <p className="dt-hint">{value.windows.length ? t('scheduleWindowsHint') : t('scheduleWindowsEmpty')}</p>
            {value.windows.length > 0 && <ul className="dt-rows" style={{ ['--dt-columns' as string]: 3 }}>
              {value.windows.map((window, index) => <li key={index} className="dt-rows-item">
                <span className="dt-days" role="group" aria-label={t('scheduleWindowDays', { index: index + 1 })}>
                  {DAYS.map(day => {
                    const picked = window.days.includes(day)
                    // A window needs at least one weekday, so the last selected one cannot be cleared.
                    return <button key={day} type="button" className={`dt-pill${picked ? ' dt-pill-active' : ''}`} aria-pressed={picked}
                      disabled={picked && window.days.length === 1}
                      aria-label={t('scheduleWindowDay', { index: index + 1, day: t(`weekday.${day}`) })}
                      onClick={() => toggleDay(index, window, day)}>{t(`weekday.${day}`)}</button>
                  })}
                </span>
                <Input className="dt-mono" aria-label={t('scheduleWindowStart', { index: index + 1 })} value={window.start}
                  pattern="([01]\d|2[0-3]):[0-5]\d" required placeholder="23:00" spellCheck={false}
                  onChange={event => setWindow(index, { ...window, start: event.target.value })} />
                <Input className="dt-mono" aria-label={t('scheduleWindowEnd', { index: index + 1 })} value={window.end}
                  pattern="([01]\d|2[0-3]):[0-5]\d" required placeholder="18:00" spellCheck={false}
                  onChange={event => setWindow(index, { ...window, end: event.target.value })} />
                <Button variant="ghost" size="sm" icon={<Icon name="trash" />}
                  aria-label={t('removeRow', { name: t('scheduleWindowName', { index: index + 1 }) })}
                  onClick={() => edit({ windows: value.windows.filter((_, at) => at !== index) })} />
              </li>)}
            </ul>}
          </div>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['schedule']} />
  </div>
}

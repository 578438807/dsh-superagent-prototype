import { expect, it } from 'vitest'
import { briefingFor, type LinkHost } from '../src/app/links.ts'
import type { Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { RuleRun } from '../src/app/store.ts'

const settings = (rules: { id: string; objective?: string }[] = []) => SettingsSchema.parse({ policy: { rules: rules.map(rule =>
  ({ ...rule, name: rule.id, enabled: true, instruction: 'i' })) } })
const trigger = (job: string): Trigger => ({ id: 't', source: 'cron', threads: [], actor: { source: 'cron', id: 'clock' }, human: false, at: '', text: '',
  meta: { job } })
const host = (runs: RuleRun[]): LinkHost => ({ store: { ruleRuns: { recent: () => runs } } } as unknown as LinkHost)
const run = (day: string, over: Partial<Pick<RuleRun, 'hardPassed' | 'softPassed' | 'overBudget' | 'noNewWork'>> & { minutes?: number } = {}): RuleRun =>
  ({ ruleId: 'learn', day, ticketId: 't', minutes: 3, retries: 0, hardPassed: true, softPassed: true, overBudget: false, noNewWork: false, ...over })

it('returns no briefing without a job or a matching rule', () => {
  expect(briefingFor(host([]), { ...trigger(''), meta: {} } as Trigger, settings([{ id: 'learn' }]))).toBeUndefined()
  expect(briefingFor(host([]), trigger('daily-unknown'), settings([{ id: 'learn' }]))).toBeUndefined()
})

it('reports no runs yet and says to follow the objective literally on a first run', () => {
  const briefing = briefingFor(host([]), trigger('daily-learn'), settings([{ id: 'learn', objective: 'Learn something verifiable.' }]))
  expect(briefing).toEqual({ rule: 'learn', objective: 'Learn something verifiable.', recent: 'no recorded runs yet',
    advice: 'First run under this rule: follow the objective and acceptance literally.' })
})

it('names a failed hard check ahead of an over-budget run', () => {
  const briefing = briefingFor(host([run('2026-11-04', { hardPassed: false, overBudget: true })]), trigger('daily-learn'), settings([{ id: 'learn' }]))
  expect(briefing?.advice).toBe('Last run failed its hard checks: fix those before anything else.')
})

it('reports the over-budget advice and the run line', () => {
  const briefing = briefingFor(host([run('2026-11-04', { overBudget: true })]), trigger('daily-learn'), settings([{ id: 'learn' }]))
  expect(briefing?.advice).toBe('Last run went over its time budget: cut or parallelise the slow steps.')
  expect(briefing?.recent).toBe('2026-11-04: hard pass, soft pass, over budget, 3 min')
})

it('closes with the passed advice on a clean run', () => {
  const briefing = briefingFor(host([run('2026-11-04')]), trigger('daily-learn'), settings([{ id: 'learn' }]))
  expect(briefing?.advice).toBe('Last run passed; keep the same shape and report anything that changed.')
  expect(briefing?.objective).toBe('(none)')
})

it('names an idle round as such instead of calling its unrun checks a failure', () => {
  const briefing = briefingFor(host([run('2026-11-04', { noNewWork: true, hardPassed: false, softPassed: false })]), trigger('daily-learn'), settings([{ id: 'learn' }]))
  expect(briefing?.recent).toBe('2026-11-04: no new work, 3 min')
  expect(briefing?.advice).toBe('Last run reported nothing new: check whether the job still has work before repeating it.')
})

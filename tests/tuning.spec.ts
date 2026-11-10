import { expect, it } from 'vitest'
import { proposeFor } from '../src/app/tuning.ts'
import type { Rule } from '../src/policy.ts'
import type { RuleRun } from '../src/app/store.ts'

const rule = (minutes: number | undefined, maxExtensions = 2): Rule => ({ id: 'r', name: 'Daily', enabled: true, instruction: 'i',
  ...(minutes === undefined ? {} : { budget: { minutes, maxExtensions } }) })
const run = (minutes: number, over: Partial<Pick<RuleRun, 'overBudget' | 'hardPassed' | 'softPassed'>> = {}): RuleRun => ({
  ruleId: 'r', day: '2026-11-04', ticketId: 't', minutes, retries: 0, hardPassed: true, softPassed: true, overBudget: false, ...over })

it('proposes nothing without a budget or with fewer than three runs', () => {
  expect(proposeFor(rule(undefined), [run(10), run(10), run(10)])).toBeUndefined()
  expect(proposeFor(rule(80), [run(10), run(10)])).toBeUndefined()
})

it('raises the budget when runs keep going over it', () => {
  const proposal = proposeFor(rule(80), [run(90, { overBudget: true }), run(100, { overBudget: true }), run(70)])
  expect(proposal?.kind).toBe('budget-up')
  expect(proposal?.diff).toEqual([{ field: 'budget.minutes', from: 80, to: expect.any(Number) }])
  expect(proposal?.next.budget?.minutes).toBeGreaterThan(80)
  expect(proposal?.next.budget?.maxExtensions).toBe(2)
})

it('lowers the budget when five clean runs stay far under it', () => {
  const runs = [run(10), run(12), run(11), run(9), run(10)]
  const proposal = proposeFor(rule(120), runs)
  expect(proposal?.kind).toBe('budget-down')
  expect(proposal?.next.budget?.minutes).toBeLessThan(120)
  expect(proposal?.next.budget?.maxExtensions).toBe(2)
})

it('clamps a raised budget to the upper bound', () => {
  const proposal = proposeFor(rule(470), [run(600, { overBudget: true }), run(600, { overBudget: true }), run(600, { overBudget: true })])
  expect(proposal?.kind).toBe('budget-up')
  expect(proposal?.next.budget?.minutes).toBe(480)
})

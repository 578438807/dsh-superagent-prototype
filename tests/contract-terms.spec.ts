import { expect, it } from 'vitest'
import { mandateInstructions, ruleTerms } from '../src/executor/dsh.ts'
import type { Rule } from '../src/policy.ts'

const full: Rule = { id: 'gated', name: 'Gated work', enabled: true, instruction: 'do it', objective: 'Improve the dashboard.',
  acceptance: { hard: ['cmd: npm test', 'file: out.json'], soft: ['the report is clear'] },
  redLines: ['never touch production data'], budget: { minutes: 45, maxExtensions: 2 }, autonomy: 'medium' }

it('returns nothing for an explicit request', () => {
  expect(mandateInstructions({ strength: 'explicit' }, full)).toBe('')
})

it('grounds proactive authorization in the rule objective and its terms for an inferred ticket', () => {
  const text = mandateInstructions({ strength: 'inferred' }, full)
  expect(text).toContain('Your authorization is that rule objective plus its red lines')
  expect(text).toContain('The ticket objective and acceptance criteria define done')
  expect(text).toContain('objective: Improve the dashboard.')
  expect(text).not.toContain('limited proactive authorization')
})

it('falls back to limited proactive authorization without a rule objective', () => {
  const text = mandateInstructions({ strength: 'inferred' }, { ...full, objective: undefined })
  expect(text).toContain('limited proactive authorization')
  expect(text).toContain('stop and report dropped')
})

it('renders every contract term of a fully specified rule', () => {
  expect(ruleTerms(full)).toBe([
    'objective: Improve the dashboard.',
    'must pass (checked by the host, not by you):\n1. cmd: npm test\n2. file: out.json',
    'judged by an independent reviewer:\n1. the report is clear',
    'red lines, never cross:\n1. never touch production data',
    'budget: about 45 minutes, up to 2 extension request(s)',
    'autonomy: medium',
  ].join('\n'))
})

it('renders nothing for a bare rule', () => {
  expect(ruleTerms({ id: 'x', name: 'X', enabled: true, instruction: 'i' })).toBe('')
})

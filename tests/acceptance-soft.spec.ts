import { expect, it } from 'vitest'
import { reviewSoft } from '../src/app/acceptance.ts'
import type { Rule } from '../src/policy.ts'

const rule = (soft: string[]): Rule => ({ id: 'r', name: 'reviewed work', enabled: true, instruction: 'i', acceptance: { hard: [], soft } })
const route = { provider: 'p', model: 'm' }
const signal = new AbortController().signal

function reviewer(answer: string | Error) {
  return {
    async *stream() {
      if (answer instanceof Error) throw answer
      yield { type: 'text-delta', text: answer }
    },
  }
}

it('skips the soft check when the rule has no soft criteria or no route', async () => {
  expect(await reviewSoft(reviewer('{"pass":true}'), route, rule([]), 'done', signal)).toBeUndefined()
  expect(await reviewSoft(reviewer('{"pass":true}'), undefined, rule(['clear']), 'done', signal)).toBeUndefined()
})

it('passes when the reviewer answers a JSON object with pass true', async () => {
  expect(await reviewSoft(reviewer('{"pass": true, "reasons": []}'), route, rule(['clear']), 'done', signal)).toEqual({ passed: true, reasons: [], invalid: [] })
})

it('fails with the reviewer reasons when it rejects the report', async () => {
  expect(await reviewSoft(reviewer('{"pass": false, "reasons": ["no evidence"]}'), route, rule(['clear']), 'done', signal))
    .toEqual({ passed: false, reasons: ['no evidence'], invalid: [] })
})

it('fails loudly when the reviewer errors, answers no JSON, or answers unparsable JSON', async () => {
  expect(await reviewSoft(reviewer(new Error('timeout')), route, rule(['clear']), 'done', signal)).toMatchObject({ passed: false, reasons: [expect.stringContaining('soft reviewer unavailable: timeout')] })
  expect(await reviewSoft(reviewer('looks fine to me'), route, rule(['clear']), 'done', signal)).toMatchObject({ passed: false, reasons: ['soft reviewer answered without JSON'] })
  expect(await reviewSoft(reviewer('{not json}'), route, rule(['clear']), 'done', signal)).toMatchObject({ passed: false, reasons: ['soft reviewer answered with unparsable JSON'] })
})
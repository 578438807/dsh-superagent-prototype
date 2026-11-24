import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { failureLine, recordFailure } from '../src/app/failures.ts'

it('appends one JSON line per failure under outputs/failures/<day>.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'failures-'))
  const first = failureLine('t1', 'ui', 'failed', 'boom')
  await recordFailure(dir, first)
  await recordFailure(dir, failureLine('t2', undefined, 'blocked', 'waiting'))
  const path = join(dir, 'outputs', 'failures', `${first.at.slice(0, 10)}.jsonl`)
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[0]!)).toEqual({ at: first.at, ticketId: 't1', ruleId: 'ui', state: 'failed', summary: 'boom' })
  expect(JSON.parse(lines[1]!)).toEqual({ at: expect.any(String), ticketId: 't2', state: 'blocked', summary: 'waiting' })
})

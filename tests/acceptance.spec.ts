import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { checkApprovals, checkHard, today } from '../src/app/acceptance.ts'
import { Commands } from '../src/infra/commands.ts'
import type { Rule } from '../src/policy.ts'

const signal = new AbortController().signal
const commands = new Commands(() => ({}) as never, {}, signal)
const rule = (hard: string[]): Rule => ({ id: 'gated', name: 'Gated', enabled: true, instruction: 'i', acceptance: { hard, soft: [] } })
const dir = () => mkdtempSync(join(tmpdir(), 'acceptance-'))

it('computes today in Asia/Shanghai across the UTC boundary', () => {
  // 2026-11-04T16:30Z is 2026-11-05 00:30 in Shanghai.
  expect(today(new Date('2026-11-04T16:30:00Z'))).toBe('2026-11-05')
  expect(today(new Date('2026-11-04T15:59:59Z'))).toBe('2026-11-04')
})

it('passes a file check only when the file exists and is non-empty', async () => {
  const cwd = dir()
  expect((await checkHard(commands, rule(['file: out.txt']), cwd, signal)).reasons).toEqual(['hard file missing: out.txt'])
  writeFileSync(join(cwd, 'out.txt'), '')
  expect((await checkHard(commands, rule(['file: out.txt']), cwd, signal)).reasons).toEqual(['hard file empty: out.txt'])
  writeFileSync(join(cwd, 'out.txt'), 'ok')
  expect((await checkHard(commands, rule(['file: out.txt']), cwd, signal)).passed).toBe(true)
})

it('reads a json pointer and a date check', async () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'r.json'), JSON.stringify({ stats: { state: 'ok' }, at: `${today()}T01:00:00+08:00`, old: '2026-01-01T00:00:00+08:00' }))
  expect((await checkHard(commands, rule(['json: r.json#stats.state=ok']), cwd, signal)).passed).toBe(true)
  expect((await checkHard(commands, rule(['json: r.json#stats.state=bad']), cwd, signal)).reasons).toEqual(['hard json mismatch: r.json#stats.state=bad is "ok"'])
  expect((await checkHard(commands, rule(['date: r.json#at']), cwd, signal)).passed).toBe(true)
  expect((await checkHard(commands, rule(['date: r.json#old']), cwd, signal)).reasons[0]).toContain('hard date stale: r.json#old is 2026-01-01')
})

it('fails loudly on a check it cannot parse', async () => {
  const verdict = await checkHard(commands, rule(['nonsense']), dir(), signal)
  expect(verdict.passed).toBe(false)
  expect(verdict.invalid).toEqual(['nonsense'])
})

it('runs a cmd check through the shell and fails on a non-zero exit', async () => {
  const ok = vi.spyOn(commands, 'run').mockResolvedValue('')
  expect((await checkHard(commands, rule(['cmd: echo hi']), dir(), signal)).passed).toBe(true)
  ok.mockRestore()
  const failing = { withSignal: () => ({ run: async () => { throw new Error('exit 1') } }) } as unknown as Commands
  expect((await checkHard(failing, rule(['cmd: false']), dir(), signal)).reasons[0]).toContain('hard cmd failed: false')
})

it('accepts an undeclared plan and checks approval classes when one is declared', () => {
  const cwd = dir()
  const gated: Rule = { ...rule([]), approvals: { auto: [], ask: ['policy-edit'], never: ['delete'] } }
  // No plan file: nothing declared, so nothing to reject here.
  expect(checkApprovals(gated, cwd, 't1')).toEqual({ passed: true, reasons: [], invalid: [] })
  mkdirSync(join(cwd, 'outputs', 'plans'), { recursive: true })
  writeFileSync(join(cwd, 'outputs', 'plans', 't1.json'), JSON.stringify({ plan: [{ step: 'a', class: 'delete' }, { step: 'b', class: 'policy-edit' }] }))
  const denied = checkApprovals(gated, cwd, 't1')
  expect(denied.passed).toBe(false)
  expect(denied.reasons).toEqual(['Approval denied: delete is never allowed for rule gated.', 'Approval missing: policy-edit'])
  // A recorded approval for this ticket satisfies the ask class but not the never class.
  mkdirSync(join(cwd, 'catalog'), { recursive: true })
  writeFileSync(join(cwd, 'catalog', 'approvals.jsonl'), JSON.stringify({ ticket: 't1', class: 'policy-edit' }) + '\n')
  const stillDenied = checkApprovals(gated, cwd, 't1')
  expect(stillDenied.reasons).toEqual(['Approval denied: delete is never allowed for rule gated.'])
})

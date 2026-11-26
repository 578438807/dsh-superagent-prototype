/**
 * `edge:` hard checks: the relation between two artifacts, which the other hard forms cannot express. Each case here
 * is one direction the check must hold, including a reverse case that two present files are not enough.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { checkHard } from '../src/app/acceptance.ts'
import { Commands } from '../src/infra/commands.ts'
import type { Rule } from '../src/policy.ts'

const signal = new AbortController().signal
const commands = new Commands(() => ({}) as never, {}, signal)
const rule = (hard: string[]): Rule => ({ id: 'gated', name: 'Gated', enabled: true, instruction: 'i', acceptance: { hard, soft: [] } })
const dir = () => mkdtempSync(join(tmpdir(), 'acceptance-edge-'))
const write = (cwd: string, name: string, value: unknown) => {
  mkdirSync(join(cwd, name, '..'), { recursive: true })
  writeFileSync(join(cwd, name), typeof value === 'string' ? value : JSON.stringify(value))
}
const run = async (cwd: string, check: string) => checkHard(commands, rule([check]), cwd, signal)

it('passes when every left member appears on the right, in any order and as a plain field', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { names: ['a', 'b', 'c'] })
  write(cwd, 'down.json', { rows: [{ name: 'c' }, { name: 'a' }, { name: 'b' }, { name: 'd' }] })
  const verdict = await run(cwd, 'edge: up.json#names -> down.json#rows[].name')
  expect(verdict).toEqual({ passed: true, reasons: [], invalid: [] })
})

it('fails on the one left member the right side lacks, and names it', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { names: ['alpha', 'beta'] })
  write(cwd, 'down.json', { rows: [{ name: 'alpha' }] })
  const verdict = await run(cwd, 'edge: up.json#names -> down.json#rows[].name')
  expect(verdict.passed).toBe(false)
  expect(verdict.invalid).toEqual([])
  expect(verdict.reasons).toEqual(['hard edge missing 1 of 2: up.json#names -> down.json#rows[].name — on the left but not the right: beta'])
})

it('fails an empty left set whatever the comparator, unless the expression says allow-empty', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { rows: [] })
  write(cwd, 'down.json', { names: ['x'] })
  // An empty left set is the suspect case: a comparator must not turn `0 of 0` into a pass.
  for (const check of ['edge: up.json#rows[].name -> down.json#names',
    'edge: up.json#rows[].name -> down.json#names >= 1',
    'edge: up.json#rows[].name -> down.json#names == 0',
    'edge: up.json#rows[].name -> down.json#names <= 0']) {
    const verdict = await run(cwd, check)
    expect(verdict.passed, check).toBe(false)
    expect(verdict.invalid, check).toEqual([])
    expect(verdict.reasons[0], check).toContain('hard edge empty left set')
  }
  const allowed = await run(cwd, 'edge: up.json#rows[].name -> down.json#names allow-empty')
  expect(allowed).toEqual({ passed: true, reasons: [], invalid: [] })
  const allowedCounted = await run(cwd, 'edge: up.json#rows[].name -> down.json#names allow-empty >= 0')
  expect(allowedCounted).toEqual({ passed: true, reasons: [], invalid: [] })
})

it('fails loudly on a selector it cannot parse', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { names: ['a'] })
  write(cwd, 'down.json', { names: ['a'] })
  for (const check of ['edge: up.json#names down.json#names', 'edge: up.json -> down.json#names',
    'edge: up.json#na mes -> down.json#names', 'edge: up.json#names -> down.json#names ?? 2']) {
    const verdict = await run(cwd, check)
    expect(verdict.passed, check).toBe(false)
    expect(verdict.invalid, check).toEqual([check])
    expect(verdict.reasons[0], check).toContain('hard edge unusable')
  }
})

it('fails when a path it names does not exist, or is not JSON', async () => {
  const cwd = dir()
  write(cwd, 'down.json', { names: ['a'] })
  const missing = await run(cwd, 'edge: up.json#names -> down.json#names')
  expect(missing.passed).toBe(false)
  expect(missing.invalid).toHaveLength(1)
  expect(missing.reasons[0]).toContain('left file missing: up.json')
  write(cwd, 'up.json', 'not json')
  const unreadable = await run(cwd, 'edge: up.json#names -> down.json#names')
  expect(unreadable.reasons[0]).toContain('left unreadable JSON: up.json')
  expect(unreadable.invalid).toHaveLength(1)
  const noField = await run(cwd, 'edge: up.json#nope -> down.json#names')
  expect(noField.passed).toBe(false)
  expect(noField.invalid).toHaveLength(1)
})

it('fails keys() against an array, and reads an object\'s keys against a catalog keyed by name', async () => {
  const cwd = dir()
  write(cwd, 'probe.json', { bilibili: {}, douyin: {} })
  write(cwd, 'script.json', { sources: ['bilibili'] })
  const keys = await run(cwd, 'edge: probe.json#keys() -> script.json#sources')
  expect(keys.reasons).toEqual(['hard edge missing 1 of 2: probe.json#keys() -> script.json#sources — on the left but not the right: douyin'])
  write(cwd, 'list.json', ['a', 'b'])
  const onArray = await run(cwd, 'edge: list.json#keys() -> script.json#sources')
  expect(onArray.passed).toBe(false)
  expect(onArray.invalid).toHaveLength(1)
  expect(onArray.reasons[0]).toContain('keys() needs an object')
})

it('treats a filter that matches nothing as an empty left set', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { rows: [{ status: 'rejected', name: 'x' }] })
  write(cwd, 'down.json', { names: ['x'] })
  const verdict = await run(cwd, 'edge: up.json#rows[status=admitted].name -> down.json#names')
  expect(verdict.passed).toBe(false)
  expect(verdict.reasons[0]).toContain('hard edge empty left set')
})

it('counts members with a comparator instead of requiring a subset', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { names: ['a', 'b', 'c'] })
  write(cwd, 'down.json', { names: ['a', 'zzz'] })
  const two = await run(cwd, 'edge: up.json#names -> down.json#names >= 1')
  expect(two.passed).toBe(true)
  const more = await run(cwd, 'edge: up.json#names -> down.json#names >= 2')
  expect(more.passed).toBe(false)
  expect(more.reasons[0]).toContain('1 of 3 left member(s) appear on the right')
  expect((await run(cwd, 'edge: up.json#names -> down.json#names == 1')).passed).toBe(true)
  expect((await run(cwd, 'edge: up.json#names -> down.json#names <= 1')).passed).toBe(true)
  expect((await run(cwd, 'edge: up.json#names -> down.json#names <= 0')).passed).toBe(false)
})

it('does not degrade into a file-existence check: both files present, one left member absent', async () => {
  const cwd = dir()
  // Both artifacts exist and are non-empty JSON: `file:` would pass both.
  write(cwd, 'up.json', { names: ['a', 'b'] })
  write(cwd, 'down.json', { names: ['a'] })
  expect((await checkHard(commands, rule(['file: up.json', 'file: down.json']), cwd, signal)).passed).toBe(true)
  const verdict = await run(cwd, 'edge: up.json#names -> down.json#names')
  expect(verdict.passed).toBe(false)
  expect(verdict.reasons[0]).toContain('on the left but not the right: b')
})

it('compares numbers by their text form and rejects members it cannot compare', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { codes: [1, 2] })
  write(cwd, 'down.json', { codes: ['2', '1'] })
  expect((await run(cwd, 'edge: up.json#codes -> down.json#codes')).passed).toBe(true)
  write(cwd, 'nested.json', { rows: [{ id: { deep: 1 } }] })
  const bad = await run(cwd, 'edge: nested.json#rows[].id -> down.json#codes')
  expect(bad.passed).toBe(false)
  expect(bad.invalid).toHaveLength(1)
  expect(bad.reasons[0]).toContain('cannot compare')
  // A boolean is not the text `"true"`: inventing that match would let a flag pass for a name.
  write(cwd, 'flags.json', { values: [true] })
  write(cwd, 'words.json', { values: ['true'] })
  const bool = await run(cwd, 'edge: flags.json#values -> words.json#values')
  expect(bool.passed).toBe(false)
  expect(bool.invalid).toHaveLength(1)
  expect(bool.reasons[0]).toContain('selects a boolean member')
})

it('leaves the other four forms untouched when a rule mixes them', async () => {
  const cwd = dir()
  write(cwd, 'up.json', { names: ['a'] })
  write(cwd, 'down.json', { names: ['a'] })
  write(cwd, 'plain.txt', 'ok')
  const verdict = await checkHard(commands, rule(['file: plain.txt', 'json: up.json#names.0=a',
    'edge: up.json#names -> down.json#names']), cwd, signal)
  expect(verdict).toEqual({ passed: true, reasons: [], invalid: [] })
})

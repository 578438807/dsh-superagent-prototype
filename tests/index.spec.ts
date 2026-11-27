import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void }[])
const runtimeHook = vi.hoisted(() => ({ current: undefined as undefined | ((machine: { stateDir: string }) => void) }))
vi.mock('../src/app/runtime.ts', () => ({ STATE_LOCK_STALE: 30_000, Runtime: class {
  ready = Promise.resolve()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void) { runtimes.push(this); runtimeHook.current?.(machine) }
  configured() { return true }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

afterEach(() => {
  runtimes.length = 0
  runtimeHook.current = undefined
  vi.useRealTimers()
})

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('does not retry a non-lock construction failure and logs its diagnostic', async () => {
  const { ctx } = context()
  let attempts = 0
  runtimeHook.current = () => { attempts++; throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) }
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state' }))).rejects.toThrow('permission denied')
  expect(attempts).toBe(1)
  expect(ctx.logger.error).toHaveBeenCalledWith(
    'dsh-superagent: Runtime construction failed for state directory %s: %s', '/srv/state', 'Error: permission denied')
})

it('retries a fresh crash-leftover lock and mounts after the existing stale lease expires', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-startup-lock-'))
  const lockDir = `${stateDir}.lock`
  mkdirSync(lockDir) // A crashed holder left a fresh lock; the first acquisition must not remove it.
  let release: (() => void) | undefined
  let attempts = 0
  runtimeHook.current = () => { attempts++; release = lockSync(stateDir, { stale: 30_000 }) }
  const { ctx } = context()
  vi.useFakeTimers()
  try {
    const outcome = apply(ctx as never, Config({ stateDir: '/srv/state' })).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    expect(attempts).toBe(1)
    expect(statSync(lockDir).isDirectory()).toBe(true)
    const old = new Date(Date.now() - 31_000)
    utimesSync(lockDir, old, old)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await outcome
    if (!result.ok) throw result.error
    expect(attempts).toBe(2)
    expect(release).toBeTypeOf('function')
    expect(runtimes).toHaveLength(2)
  } finally {
    release?.()
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(lockDir, { recursive: true, force: true })
  }
})

it('bounds startup retries, preserves a live lock, and logs the final construction failure', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-startup-lock-'))
  const lockDir = `${stateDir}.lock`
  mkdirSync(lockDir)
  let attempts = 0
  runtimeHook.current = () => { attempts++; lockSync(stateDir, { stale: 30_000 }) }
  const { ctx } = context()
  vi.useFakeTimers()
  try {
    const outcome = apply(ctx as never, Config({ stateDir: '/srv/state' })).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    // Keep the lock fresh throughout the whole default budget, as a live holder would.
    for (let retry = 0; retry < 31; retry++) {
      utimesSync(lockDir, new Date(), new Date())
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const result = await outcome
    if (result.ok) throw new Error('A live state-directory lock was stolen')
    expect(String(result.error)).toMatch(/already being held/)
    expect(attempts).toBe(32)
    expect(statSync(lockDir).isDirectory()).toBe(true)
    expect(ctx.logger.warn).toHaveBeenCalledTimes(31)
    expect(ctx.logger.error).toHaveBeenCalledWith(
      'dsh-superagent: state directory %s remained locked after startup retries: %s', '/srv/state', expect.stringContaining('ELOCKED'))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(lockDir, { recursive: true, force: true })
  }
})

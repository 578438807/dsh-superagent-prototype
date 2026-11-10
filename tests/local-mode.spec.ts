/**
 * A local-only deployment (local Source on, no GitHub repository) must not be gated on GitHub setup:
 * the local and cron Sources run from a folder and a clock. GitHub mode must keep reporting the
 * problems it reported before.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Setup } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testMachine } from './fixtures/deployment.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'local-mode-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const settings = (localEnabled: boolean, github: { enabled: boolean; repository: string }) => SettingsSchema.parse({
  sources: {
    local: { enabled: localEnabled, config: { root: dir, pollSeconds: 60, failuresBeforeError: 3 } },
    github: { enabled: github.enabled, config: { repository: github.repository, cli: '' } },
  },
})

const host = () => ({
  context: { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, subprocess: {} } as unknown as Context,
  machine: testMachine({ stateDir: dir }),
  lifetime: new AbortController().signal,
  restart: vi.fn(),
})

describe('local-only deployment', () => {
  it('resolves without a GitHub repository when the local Source is the deployment target', async () => {
    const setup = new Setup(host())
    expect(await setup.run(settings(true, { enabled: false, repository: '' }))).toBe(true)
    expect(setup.configured()).toBe(true)
    expect(setup.deployment.github.cli).toBe('')
    expect(setup.deployment.repository).toBe(dir)
    setup.restore()
  })
  it('still reports repositoryUnset for GitHub mode without a repository', async () => {
    const setup = new Setup(host())
    expect(await setup.run(settings(false, { enabled: true, repository: '' }))).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'github', code: 'repositoryUnset' })
    expect(setup.configured()).toBe(false)
  })
  it('does not verify a GitHub credential helper it never wrote', async () => {
    const setup = new Setup(host())
    await setup.run(settings(true, { enabled: false, repository: '' }))
    // verifyEnvironment returns early for an empty CLI; a non-empty CLI would have probed git here.
    expect(setup.configured()).toBe(true)
    setup.restore()
  })
})

/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime, STATE_LOCK_STALE } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // A crash can leave a lock younger than its 30-second stale lease. Retry asynchronously for the whole lease so the
  // host event loop stays free and a live holder can keep refreshing its lock; never remove a fresh lock ourselves.
  const retryDelay = 1_000
  const maxAttempts = Math.ceil(STATE_LOCK_STALE / retryDelay) + 2 // one initial attempt, a full lease of waits, one final attempt
  let runtime: Runtime
  for (let attempt = 1; ; attempt++) {
    try {
      runtime = new Runtime(ctx, machine, restart)
      break
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code !== 'ELOCKED') {
        ctx.logger.error('dsh-superagent: Runtime construction failed for state directory %s: %s', machine.stateDir, String(error))
        throw error
      }
      if (attempt >= maxAttempts) {
        ctx.logger.error('dsh-superagent: state directory %s remained locked after startup retries: %s', machine.stateDir, `${String(error)} (${code})`)
        throw error
      }
      ctx.logger.warn('dsh-superagent: state directory %s is locked (attempt %d/%d); retrying in %dms', machine.stateDir, attempt, maxAttempts, retryDelay)
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

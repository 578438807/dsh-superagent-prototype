/** Resolves a role's configured model for each Session as it starts, leaving a route the Session already took as is. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Whether `left` and `right` call the same provider and model; effort alone does not change the route. */
const sameRoute = (left: { provider: string; model: string }, right: { provider: string; model: string }): boolean =>
  left.provider === right.provider && left.model === right.model
/**
 * Whether the configured model may replace the selection a Session holds: it is the plugin's own seed for an Assignment that
 * has not started yet, not a pick a person made in the Session's own turn, nor a selection the Session carried into it.
 */
const supersedesRoute = (events: readonly { type: string; data: unknown }[]): boolean => {
  if (events.some(event => event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'user')) return false
  if (events.some(event => event.type === 'request/header')) return true
  // Nothing ran yet: the seed is the first selection, which some other Session's log may have carried along.
  const selection = events.find(event => event.type === 'model/selection')
  const header = events.find(event => event.type === 'session/header')?.data as { parentSession?: string; fork?: string } | undefined
  return !header?.parentSession && !header?.fork && selection === events[0]
}

/**
 * Apply a role's configured model to a Session: seed it on a brand-new one before its first request, and on an existing one
 * append a new selection when `changed` says the configuration moved since the Session ran. A DSH Session keeps the selection
 * it holds, so a changed `executor.model` would otherwise never reach a worker that starts again. A pick a person made in the
 * Session's own turn, and a selection the Session carried into this one, are kept.
 */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null, changed = false): Promise<void> {
  if (!model) return
  const events = agent.session.snapshotEvents()
  const selection = events.find(event => event.type === 'model/selection')
  if (changed && (selection || agent.session.requestHeader()) && supersedesRoute(events)) {
    const current = await resolveRoleModel(ctx, model)
    const running = events.filter(event => event.type === 'model/selection').at(-1)?.data as ModelSelection | undefined
      ?? agent.session.requestHeader()?.config
    if (running && sameRoute(running, current)) return
    // Not the initial request: the seed below leaves a running Session's routing alone.
    agent.session.append('model/selection', current)
    await ctx.sessionPersistence.flush()
    return
  }
  if (agent.session.requestHeader() || selection) return
  const selected = await resolveRoleModel(ctx, model)
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}

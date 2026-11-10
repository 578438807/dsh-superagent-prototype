/** Source message link resolution and candidate card assembly for the main Session. */
import type { Candidate, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { readFeishuLink } from '../sources/feishu-read.ts'
import { feishuRef, feishuSettings } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { triggerMessage } from '../executor/dsh.ts'
import { relatedTickets, ticketCard, triggerCard } from './cards.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

export interface LinkHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'threads' | 'tickets' | 'ruleRuns'>
  readonly links: TextCache
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly lifetime: AbortSignal
}

/** Resolves and caches a trigger's external message URL, falling back to a readable resource path when lookup fails. */
export async function sourceLink(host: LinkHost, trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }> {
  if (trigger.url) return { source_url: trigger.url }
  const ref = feishuRef(trigger)
  if (!ref) return {}
  const cacheKey = `${ref.chatId}:${ref.messageId}`
  const cached = host.links.get(cacheKey)
  if (cached) return { source_url: cached }
  let url: string
  try {
    const timeout = AbortSignal.timeout(feishuSettings(host.sources).linkTimeoutMs)
    url = await readFeishuLink(host.commands.withSignal(AbortSignal.any([signal ?? host.lifetime, timeout])), ref)
  } catch {
    host.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    // Optional link enrichment may fail independently of the retained source message.
    return { source_url_read: `feishu/${trigger.id}/message` }
  }
  host.links.set(cacheKey, url)
  return { source_url: url }
}

export function repliedTo({ store, sources }: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger): Trigger | undefined {
  const parent = sources.repliesTo(trigger)
  return parent === undefined ? undefined : store.triggers.get(parent)
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** Yesterday's rule-run record plus the rule objective, so the main Session writes today's task book from evidence. */
export function briefingFor(host: LinkHost, primary: Trigger, settings: ReturnType<Store['settings']>) {
  const job = typeof primary.meta.job === 'string' ? primary.meta.job : ''
  if (!job) return undefined
  const rule = settings.policy.rules.find(item => item.id === job || `daily-${item.id}` === job)
  if (!rule) return undefined
  const runs = host.store.ruleRuns.recent(rule.id, 5)
  const last = runs[0]
  const recent = runs.length
    ? runs.map(run => `${run.day}: hard ${run.hardPassed ? 'pass' : 'fail'}, soft ${run.softPassed ? 'pass' : 'fail'}${run.overBudget ? ', over budget' : ''}, ${run.minutes} min`).join('; ')
    : 'no recorded runs yet'
  const advice = !last ? 'First run under this rule: follow the objective and acceptance literally.'
    : !last.hardPassed ? 'Last run failed its hard checks: fix those before anything else.'
      : last.overBudget ? 'Last run went over its time budget: cut or parallelise the slow steps.'
        : 'Last run passed; keep the same shape and report anything that changed.'
  return { rule: rule.id, objective: rule.objective ?? '(none)', recent, advice }
}

/** Builds the main Session's candidate card with routing metadata, handback history, and related or referenced tickets. */
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  const primary = candidate.triggers.at(-1)!
  const settings = host.store.settings()
  const briefing = briefingFor(host, primary, settings)
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // Triggers that a worker Session handed back as outside its ticket's scope, with the worker's reason.
  const handedBack = candidate.triggers.flatMap(trigger => (host.store.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // Format the primary trigger like a worker input (including the message it replies to) and summarize earlier batch triggers as cards.
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...briefing ? { briefing } : {}, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action: candidate.strength === 'explicit' ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.' }
}

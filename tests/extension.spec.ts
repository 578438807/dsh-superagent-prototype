/** The self-extension budget: a progress report with need_more earns one more assignment only while the rule allows it. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accept a ticket bound to a rule whose budget allows `maxExtensions`, for the executor to judge its need_more against. */
async function gated(maxExtensions: number) {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, rules: [...policy.rules,
    { id: 'gated', name: 'gated work', enabled: true, instruction: 'do it', budget: { minutes: 60, maxExtensions } }] },
  h.runtime.store.blockRevision('policy'), 'panel')
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix the gate'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...stored, mandate: { ...stored.mandate, basis: { ...stored.mandate.basis, rules: ['gated'] } } })
  return { ticket, sessionId: `worker-${ticket.id}` }
}

it('grants one more assignment for a progress report that asks within the budget', async () => {
  const { ticket, sessionId } = await gated(2)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Halfway.', need_more: true })
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.assignments[0]!.endedReason).toBe('extended')
  expect(after.assignments).toHaveLength(2)
})

it('refuses the extension once the budget is spent and fails the report', async () => {
  const { ticket, sessionId } = await gated(1)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Halfway.', need_more: true })
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'More.', need_more: true })
  const refused = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report!
  expect(refused.state).toBe('failed')
  expect(refused.summary).toContain('Extension refused')
})

it('refuses immediately for a rule that allows no extension', async () => {
  const { ticket, sessionId } = await gated(0)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Halfway.', need_more: true })
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.assignments).toHaveLength(1)
  expect(after.assignments[0]!.report!.state).toBe('failed')
  expect(after.assignments[0]!.report!.summary).toContain('Extension refused')
})

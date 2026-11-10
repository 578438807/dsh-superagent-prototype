/** Host-side acceptance on a worker's ready report: the verdict, the rule_run row it writes, and the extension budget. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accept a ticket whose rule carries the given acceptance terms, so the worker's ready report is judged. */
async function gatedTicket(hard: string[], maxExtensions = 0) {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, rules: [...policy.rules,
    { id: 'gated', name: 'gated work', enabled: true, instruction: 'do it', acceptance: { hard, soft: [] },
      budget: { minutes: 60, maxExtensions }, autonomy: 'medium' }] }, h.runtime.store.blockRevision('policy'), 'panel')
  await h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode: 'auto' }, h.runtime.store.blockRevision('eval'), 'panel')
  const trigger = feishu('1', '@bot fix the gate')
  const { ticket: accepted } = await h.acceptedTicket(trigger)
  // Bind the ticket to the gated rule the way an inferred accept would, so the executor judges its report against it.
  const stored = h.runtime.store.tickets.get(accepted.id)!
  h.runtime.store.tickets.save({ ...stored, mandate: { ...stored.mandate, basis: { ...stored.mandate.basis, rules: ['gated'] } } })
  const ticket = h.runtime.store.tickets.get(accepted.id)!
  return { ticket, sessionId: `worker-${ticket.id}` }
}

it('turns a ready report into failed when a hard check rejects it, records the run, and leaves the ticket open', async () => {
  const { ticket, sessionId } = await gatedTicket(['file: proof.txt'])
  const result = await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' }) as { notification: string }
  expect(result.notification).toBeDefined()
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.ended).toBeUndefined()
  const report = after.assignments.at(-1)!.report!
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('Acceptance failed:')
  expect(report.summary).toContain('hard file missing: proof.txt')
  const runs = h.runtime.store.ruleRuns.recent('gated', 5)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ ruleId: 'gated', ticketId: ticket.id, hardPassed: false, softPassed: false })
})

it('passes a ready report whose hard checks hold, ending the ticket and recording a passing run', async () => {
  const { ticket, sessionId } = await gatedTicket(['file: proof.txt'])
  writeFileSync(join(ticket.execution!.directory, 'proof.txt'), 'evidence')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done, proof attached.' })
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.ended).toBeDefined()
  expect(h.runtime.store.ruleRuns.recent('gated', 5)[0]).toMatchObject({ ruleId: 'gated', hardPassed: true, softPassed: true })
})

it('grants one more assignment for a progress report that asks, then refuses past the budget', async () => {
  const { ticket, sessionId } = await gatedTicket([], 1)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Halfway.', need_more: true })
  const extended = h.runtime.store.tickets.get(ticket.id)!
  // The extension restarts the ticket: the first assignment ended 'extended' and a fresh one began.
  expect(extended.assignments[0]!.endedReason).toBe('extended')
  expect(extended.assignments).toHaveLength(2)
  // The budget allows only one; a second need_more is refused and fails the report.
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'More.', need_more: true })
  const refused = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report!
  expect(refused.state).toBe('failed')
  expect(refused.summary).toContain('Extension refused')
})

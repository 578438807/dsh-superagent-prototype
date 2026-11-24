/** A ready report that says it found nothing new: the reason hook, the forgiven hard check, and the run row it writes. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { idleReason } from '../src/app/acceptance.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accept a ticket whose rule carries the given acceptance terms, so the worker's ready report is judged. */
async function gatedTicket(hard: string[]) {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, rules: [...policy.rules,
    { id: 'gated', name: 'gated work', enabled: true, instruction: 'do it', acceptance: { hard, soft: [] },
      budget: { minutes: 60, maxExtensions: 0 }, autonomy: 'medium' }] }, h.runtime.store.blockRevision('policy'), 'panel')
  await h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode: 'auto' }, h.runtime.store.blockRevision('eval'), 'panel')
  const { ticket: accepted } = await h.acceptedTicket(feishu('1', '@bot fix the gate'))
  const stored = h.runtime.store.tickets.get(accepted.id)!
  h.runtime.store.tickets.save({ ...stored, mandate: { ...stored.mandate, basis: { ...stored.mandate.basis, rules: ['gated'] } } })
  const ticket = h.runtime.store.tickets.get(accepted.id)!
  return { ticket, sessionId: `worker-${ticket.id}` }
}

const lastReport = (ticketId: string) => h.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!

// A summary only counts as a reason when a person can follow it to an artifact they can open and compare.
it('accepts only a summary naming a verifiable artifact as the reason for no new work', () => {
  expect(idleReason('no new work')).toBe(false)
  expect(idleReason('本轮无新工作')).toBe(false)
  expect(idleReason('Ran the learner and found nothing to change')).toBe(false)
  expect(idleReason('两处 [skip]：scripts/a.py 与 runs/combo-zoo.json 未变')).toBe(true)
  expect(idleReason('catalog/learn_hypotheses.json 的 generated_at 仍是上一轮')).toBe(true)
  expect(idleReason('C:\\work\\shop\\runs\\combo-zoo.json 与上轮逐字相同')).toBe(true)
})

it('keeps a ready no_new_work report ready when its hard check would fail, and records it as idle rather than passed', async () => {
  const { ticket, sessionId } = await gatedTicket(['file: proof.txt'])
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', no_new_work: true,
    summary: '本轮无新工作：runs/combo-zoo.json 的 built_at 仍是上一轮，两处脚本都打印 [skip]。' })
  const report = lastReport(ticket.id)
  expect(report.state).toBe('ready')
  expect(report.summary).toContain('No new work this round')
  expect(report.no_new_work).toBe(true)
  // A ready report completes the ticket as any other ready one does: what changed is only that it was not failed.
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  const runs = h.runtime.store.ruleRuns.recent('gated', 5)
  expect(runs).toHaveLength(1)
  // Recorded as what it is: the hard check did fail, and the row says the round was idle rather than passed.
  expect(runs[0]).toMatchObject({ hardPassed: false, softPassed: false, noNewWork: true })
})

it('fails a no_new_work report that gives no verifiable reason, judging it by acceptance as usual', async () => {
  const { ticket, sessionId } = await gatedTicket(['file: proof.txt'])
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', no_new_work: true, summary: 'no new work' })
  const report = lastReport(ticket.id)
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('Acceptance failed:')
  expect(report.summary).toContain('hard file missing: proof.txt')
  expect(report.no_new_work).toBeUndefined()
  expect(h.runtime.store.ruleRuns.recent('gated', 5)[0]).toMatchObject({ hardPassed: false, noNewWork: false })
})

it('still fails a ready report without the flag when its hard check fails, so existing behaviour is untouched', async () => {
  const { ticket, sessionId } = await gatedTicket(['file: proof.txt'])
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done, proof attached.' })
  expect(lastReport(ticket.id).state).toBe('failed')
  expect(h.runtime.store.ruleRuns.recent('gated', 5)[0]).toMatchObject({ hardPassed: false, noNewWork: false })
})

it('records a passing no_new_work report exactly like any other passing round', async () => {
  const { ticket, sessionId } = await gatedTicket(['file: proof.txt'])
  writeFileSync(join(ticket.execution!.directory, 'proof.txt'), 'evidence')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', no_new_work: true,
    summary: '本轮无新工作：`outputs/proof.txt` 与上一版逐字相同。' })
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.ended).toBeDefined()
  expect(lastReport(ticket.id).state).toBe('ready')
  expect(lastReport(ticket.id).summary).not.toContain('No new work this round')
  expect(h.runtime.store.ruleRuns.recent('gated', 5)[0]).toMatchObject({ hardPassed: true, softPassed: true, noNewWork: true })
})

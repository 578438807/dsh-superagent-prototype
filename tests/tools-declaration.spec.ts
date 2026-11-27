/** A ticket declares the tools its work needs beyond the worker baseline, and a worker asks for the rest; asking grants nothing. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketCard } from '../src/app/cards.ts'
import { declaredTools } from '../src/core/capabilities.ts'
import { toolsOf } from '../src/sources/local.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

describe('a task file declares tools', () => {
  it('reads the tools line by capability or tool name', () => {
    expect(toolsOf('do it\nworker-model: a/b\ntools: web-local, browser-skill\n')).toEqual(['web-local', 'browser-skill'])
    expect(toolsOf('tools:   browser ,  \nrest')).toEqual(['browser'])
  })
  it('declares nothing without the line or with an empty one', () => {
    expect(toolsOf('no declaration here')).toBeUndefined()
    expect(toolsOf('tools:')).toBeUndefined()
  })
})

describe('a declaration expands to tools', () => {
  it('expands a capability, keeps a bare tool name, and never repeats a tool', () => {
    expect(declaredTools(['web-local'])).toEqual(['browser'])
    expect(declaredTools(['browser-skill'])).toEqual(['bsk_assist', 'bsk_inspect', 'bsk_interact', 'bsk_page', 'bsk_session', 'bsk_tabs'])
    expect(declaredTools(['browser', 'web-local', 'mcp__srv__tool'])).toEqual(['browser', 'mcp__srv__tool'])
  })
  it('grants nothing when a ticket declares nothing', () => {
    expect(declaredTools(undefined)).toEqual([])
  })
})

describe('a ticket carries its declaration and its workers\' requests', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop() })

  it('fixes the tools a routing decision declares on the ticket and shows them on its card', async () => {
    const trigger = feishu('1', '@bot look at the site')
    h.runtime.receive(trigger)
    await h.runtime.idle()
    const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Check the site', worktree_name: 'check-site',
      acknowledgement: '收到，检查站点。', tools: ['web-local'] })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket.tools).toEqual(['web-local'])
    expect(ticketCard(ticket).tools).toEqual(['web-local'])
  })

  it('inherits the declaration from the trigger that started the ticket', async () => {
    const request = feishu('2', '@bot open the page')
    h.runtime.receive({ ...request, tools: ['browser'] })
    await h.runtime.idle()
    const result = await h.route({ kind: 'accept', trigger_id: request.id, title: 'Open the page', worktree_name: 'open-page',
      acknowledgement: '收到，打开页面。' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket.tools).toEqual(['browser'])
  })

  it('records a worker\'s tool request on the ticket, which grants nothing', async () => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('3', '@bot do the work'))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Need a browser for the page.',
      tool_request: [{ tool: 'browser', capability: 'web-local', reason: 'read the page it must fix' }] })
    const after = h.runtime.store.tickets.get(ticket.id)!
    expect(after.toolRequests).toHaveLength(1)
    expect(after.toolRequests![0]).toMatchObject({ tool: 'browser', capability: 'web-local', reason: 'read the page it must fix' })
    // The request is recorded beside the declaration; the ticket still declares nothing, so nothing was granted.
    expect(after.tools).toBeUndefined()
    expect(ticketCard(after).tool_requests).toHaveLength(1)
  })
})
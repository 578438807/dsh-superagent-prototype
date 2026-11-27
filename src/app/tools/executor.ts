/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Commands } from '../../infra/commands.ts'
import { IM_WORDS } from '../../infra/text.ts'
import type { Rule } from '../../policy.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { checkApprovals, checkHard, reviewSoft, today, idleReason, type ReviewRoute, type Reviewer, type Verdict, elapsedMinutes } from '../acceptance.ts'
import { failureLine, recordFailure } from '../failures.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'settings' | 'ruleRuns'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** Runs the deterministic acceptance commands a rule declares. */
  readonly commands: Commands
  /** Working directory acceptance commands run in; each ticket keeps its own, which a tool cannot see, so the shared work root stands in. */
  readonly stateDir: string
  /** Model route for the soft reviewer, when one is configured. */
  reviewRoute(): ReviewRoute | undefined
  /** One-shot model stream used by the soft reviewer; absent means soft criteria are skipped. */
  readonly reviewer: Reviewer | undefined
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        need_more: z.boolean().optional().describe('With state=progress: ask the host for one more assignment when the rule budget allows it; the host decides.'),
        no_new_work: z.boolean().optional().describe('With state=ready: this round found nothing new to do, so a cron loop window stops asking this job until the next window. The summary must name the artifact that did not change; without it the report is judged by acceptance as usual.'),
        tool_request: z.array(z.object({ tool: z.string().trim().min(1).max(60),
          capability: z.string().trim().min(1).max(60).optional(),
          reason: z.string().trim().min(1).max(200) }).strict()).max(6).optional()
          .describe('Tools you need and this ticket did not declare, each with the reason it was needed: recorded on the ticket for the main Session, which decides whether to grant it. A request grants nothing by itself, and you cannot install, unmask or approve a tool.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        let state: 'progress' | 'ready' | 'blocked' | 'failed' | 'dropped' = args.state
        let summary = args.summary
        const ruleId = current.mandate.basis.rules?.[0]
        const rule: Rule | undefined = ruleId ? host.store.settings().policy.rules.find(item => item.id === ruleId) : undefined
        // `no_new_work` ends a loop window, so it only counts when the summary names what was checked: a bare "nothing new"
        // is neither a reason nor a way past acceptance, and is recorded as an ordinary report.
        const idle = args.state === 'ready' && args.no_new_work === true && idleReason(summary)
        // Approval classes are the host's own guard on what the work may touch: the plan's declared actions are checked
        // before anything else, so a ticket cannot carry a never-allowed or unapproved action into a ready report.
        if (rule) {
          const approval = checkApprovals(rule, current.execution?.directory || host.stateDir, ticketId)
          if (!approval.passed) {
            state = 'failed'
            summary = `${summary}\n\n${approval.reasons.join(' | ')}`
          }
        }
        // Acceptance is the host's own verdict on "done": it runs before the report is recorded, so a worker cannot call
        // something ready that its rule's acceptance rejects. Only a ready report is judged; any other state stands as sent.
        // A report that says this round found nothing new is an honest stop, not a failure: the hard checks still run, so the
        // record says what they said, but a failure that only restates "nothing new today" is forgiven. A report without a
        // verifiable reason keeps the ordinary verdict, so the flag can never skip acceptance.
        if (rule && state === 'ready' && ((rule.acceptance?.hard.length ?? 0) > 0 || (rule.acceptance?.soft.length ?? 0) > 0)) {
          const hard: Verdict = await checkHard(host.commands.withSignal(signal), rule, current.execution?.directory || host.stateDir, signal)
          let soft: Verdict | undefined
          if (hard.passed) {
            const route = host.reviewRoute()
            if (route && host.reviewer) soft = await reviewSoft(host.reviewer, route, rule, summary, signal, current.execution?.directory || host.stateDir)
          }
          const reasons = [...hard.reasons, ...(soft?.reasons ?? []), ...(hard.invalid.length ? [`unusable acceptance rules: ${hard.invalid.join('; ')}`] : [])]
          const rejected = !hard.passed || (soft !== undefined && !soft.passed)
          if (rejected && idle) {
            // Kept as ready, and said plainly, so the recorded run is never read as a round that passed its checks.
            summary = `${summary}\n\nNo new work this round: acceptance was not enforced (${reasons.join(' | ')}), and the run is recorded as idle rather than passed.`
          } else if (rejected) {
            state = 'failed'
            summary = `${summary}\n\nAcceptance failed: ${reasons.join(' | ')}`
          }
          const assignments = current.assignments
          const minutes = elapsedMinutes(assignments)
          host.store.ruleRuns.save({ ruleId: rule.id, day: today(), ticketId, minutes: Math.round(minutes * 10) / 10,
            retries: Math.max(0, assignments.length - 1), hardPassed: hard.passed,
            softPassed: soft === undefined ? hard.passed : soft.passed,
            overBudget: rule.budget?.minutes !== undefined && minutes > rule.budget.minutes,
            noNewWork: idle })
        }
        // A worker may ask for one more assignment, but only the rule's budget decides whether it gets one.
        const extensions = current.assignments.filter(item => item.endedReason === 'extended').length
        const allowed = rule?.budget?.maxExtensions ?? 0
        let needMore = false
        if (args.need_more && state === 'progress') {
          if (extensions < allowed) needMore = true
          else {
            state = 'failed'
            summary = `${summary}\n\nExtension refused: rule ${rule?.id ?? '(none)'} allows ${allowed} extension(s) and ${extensions} were already used.`
          }
        }
        // Only an unfinished report belongs in the ledger: progress and ready are the normal path.
        if (state === 'blocked' || state === 'failed' || state === 'dropped') {
          await recordFailure(current.execution?.directory || host.stateDir, failureLine(ticketId, rule?.id, state, summary))
        }
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          // Asking is recorded on the ticket, next to what it declared, so the main Session reads the request where it reads the
          // ticket; nothing here grants, installs or unmasks a tool, which keeps asking from becoming self-authorization.
          if (args.tool_request?.length) {
            const asked = host.store.tickets.get(ticketId)!
            const at = new Date().toISOString()
            asked.toolRequests = [...asked.toolRequests ?? [], ...args.tool_request.map(item => ({ ...item, at }))]
            asked.updatedAt = at
            host.store.tickets.save(asked)
          }
          const report = { state, summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}), ...(needMore ? { need_more: true } : {}),
            // Recorded only when the host accepted it as an idle round, so a report that bypassed nothing, or was failed on
            // the way, never carries the flag that stops a loop window.
            ...(idle && state === 'ready' ? { no_new_work: true } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}),
            ...(args.tool_request?.length ? { tool_request: 'recorded for the main Session; a request grants nothing' } : {}) }
        })
      },
    }),
  ]
}
/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import type { ReactNode } from 'react'
import { usePoll, type Problem } from './api.ts'
import { Button, Icon, StateDot } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, KeyValues, LoadState, Section, SetupMessage } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

/** Format a token count the way the proxy's own panel does, so both read the same at a glance. */
function compact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const size = Math.abs(value)
  return size >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : size >= 10_000 ? `${Math.round(value / 1000)}k` : `${value}`
}

/**
 * How long this Session's context lasts under the long-lived context mechanism: what it holds now, the window bili allows,
 * the line the over-alert script mails at, and the requests left at the measured growth. The numbers come from
 * `GET context`, which reads them from the running proxy rather than restating any threshold here.
 */
function ContextLifespan() {
  const { t, call } = usePanel()
  // The window changes only when the proxy restarts, and the usage on each model request; ten seconds is close enough.
  const { data, error } = usePoll(() => call('GET context'), [], 10_000)
  // A Host that has not loaded the route yet answers 404, which is not something to show as an error: the poll retries,
  // and the Section fills itself in once the Host serves it.
  if (!data) return <Section title={t('ctxTitle')}><Hint>{error ? t('ctxUnavailable') : t('loading')}</Hint></Section>
  if (!data.ok) return <Section title={t('ctxTitle')}>
    <Hint>{t(data.problem === 'proxyOffline' ? 'ctxProxyOffline' : 'ctxNoSession')}</Hint>
  </Section>
  const used = data.sessionTokens ?? 0
  const pct = data.window > 0 ? Math.min(100, Math.round(used / data.window * 100)) : 0
  const lineAt = data.window > 0 ? Math.min(100, Math.round(data.warnLine / data.window * 100)) : 0
  const state = used >= data.warnLine ? 'error' : used >= data.warnLine * 0.9 ? 'warning' : undefined
  const rounds = data.roundsToWarn === null ? t('ctxRoundsUnknown') : t('ctxRounds', { count: String(data.roundsToWarn) })
  return <Section title={t('ctxTitle')} hint={t('ctxHint')} badge={state && <StateDot state={state} />}>
    {/* The bar fills to the usage and its marker sits on the over-alert line, so the gap between them is the room left. */}
    <div className="dt-meter" data-state={state} role="img" aria-label={t('ctxBarLabel', { used: `${pct}%`, line: `${lineAt}%` })}>
      <span className="dt-meter-fill" style={{ width: `${pct}%` }} />
      <span className="dt-meter-line" style={{ left: `${lineAt}%` }} />
    </div>
    <div className="dt-stats">
      <span className="dt-stat"><span className="dt-stat-label">{t('ctxUsed')}</span>
        <span className="dt-stat-value">{compact(used)} / {compact(data.window)}</span></span>
      <span className="dt-stat"><span className="dt-stat-label">{t('ctxLine')}</span>
        <span className="dt-stat-value">{compact(data.warnLine)}</span></span>
      <span className="dt-stat"><span className="dt-stat-label">{t('ctxRoomToLine')}</span>
        <span className="dt-stat-value">{compact(data.roomToWarn)}</span></span>
      <span className="dt-stat"><span className="dt-stat-label">{t('ctxRoundsLabel')}</span>
        <span className="dt-stat-value">{rounds}</span></span>
    </div>
    <KeyValues rows={[
      [t('ctxSent'), `${compact(data.sentTokens)}${data.sentTokens === null ? '' : ` · ${t('ctxSentHint')}`}`],
      [t('ctxGrowth'), compact(data.growth)],
      [t('ctxFoldStep'), data.foldStep === null ? '—' : compact(data.foldStep)],
      ...data.perRequest === null ? [] : [[t('ctxPerRequest'), `${compact(Math.round(data.perRequest))} × ${data.samples}`] as [string, string]],
    ]} />
    {data.measured === 'estimate' && <Hint>{t('ctxEstimate')}</Hint>}
  </Section>
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  if (!data) return <LoadState error={error} loading />
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  return <>
    {error && <LoadState error={error} loading={false} />}
    <ContextLifespan />
    <Section title={t('pendingTickets')} count={data.person.length}>
      {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}

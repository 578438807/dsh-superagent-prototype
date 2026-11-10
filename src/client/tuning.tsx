/** Tuning view: acceptance history per rule and the config changes it justifies. Applying is a person's click. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import type { TuningProposal, TuningView } from '../app/tuning.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { useSettings } from './settings-kit.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

type PolicyValue = { rules: { id: string }[]; sources: Record<string, unknown> }

function Diff({ diff }: { diff: TuningProposal['diff'] }) {
  return <ul className="dt-kv">{
    diff.map(item => <li key={item.field} className="dt-kv-row">
      <span className="dt-kv-key">{item.field}</span>
      <span className="dt-kv-value">{String(item.from)} → <strong>{String(item.to)}</strong></span>
    </li>)
  }</ul>
}

export function TuningPage() {
  const { t, call } = usePanel()
  const { settings, reload } = useSettings()
  const { data, error } = usePoll(() => call('GET tuning', {}), [])
  const [applying, setApplying] = useState('')
  const { run } = useAction(async (proposal: TuningProposal) => {
    const block = settings.blocks.policy
    const value = block.value as PolicyValue
    const rules = value.rules.map(rule => rule.id === proposal.ruleId ? proposal.next : rule)
    await call('PUT settings/:block', { block: 'policy', body: { value: { ...value, rules }, revision: block.revision } })
    await reload()
  }, { reload })
  const apply = async (proposal: TuningProposal) => {
    setApplying(proposal.ruleId)
    try { await run(proposal) } finally { setApplying('') }
  }
  return <>
    <p className="dt-hint">{t('tuningIntro')}</p>
    <LoadState error={error} loading={!data} />
    {data && <>
      <Section title={t('tuningProposals')} count={data.proposals.length}>
        {data.proposals.length
          ? <ul className="dt-list">{data.proposals.map(proposal => <li key={proposal.ruleId} className="dt-rule">
            <div className="dt-rule-body">
              <h3 className="dt-rule-name">{proposal.ruleName} <Tag tone="info">{t(`tuningKind.${proposal.kind}`)}</Tag></h3>
              <p className="dt-hint">{proposal.reason}</p>
              <Diff diff={proposal.diff} />
              <div className="dt-actions">
                <Button variant="primary" size="sm" icon={<Icon name="decision" />} disabled={applying === proposal.ruleId}
                  onClick={() => { void apply(proposal) }}>{t('tuningApply')}</Button>
              </div>
            </div>
          </li>)}</ul>
          : <Hint>{t('tuningNone')}</Hint>}
      </Section>
      <Section title={t('tuningHistory')} count={data.history.length}>
        <table className="dt-table">
          <thead><tr>
            <th>{t('tuningRule')}</th><th>{t('tuningDay')}</th><th>{t('tuningMinutes')}</th>
            <th>{t('tuningRetries')}</th><th>{t('tuningHard')}</th><th>{t('tuningSoft')}</th><th>{t('tuningOver')}</th>
          </tr></thead>
          <tbody>{data.history.flatMap(item => item.runs.length
            ? item.runs.map(entry => <tr key={`${item.ruleId}:${entry.day}`}>
              <td>{item.name}</td><td>{entry.day}</td><td>{entry.minutes.toFixed(1)}</td>
              <td>{entry.retries}</td><td>{entry.hardPassed ? '✓' : '✗'}</td>
              <td>{entry.softPassed ? '✓' : '✗'}</td><td>{entry.overBudget ? '✓' : ''}</td>
            </tr>)
            : [<tr key={item.ruleId}><td>{item.name}</td><td colSpan={6}>{t('tuningNoRuns')}</td></tr>])}
          </tbody>
        </table>
      </Section>
    </>}
  </>
}

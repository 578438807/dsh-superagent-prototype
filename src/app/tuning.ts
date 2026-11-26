/** Tuning proposals: derive rule-config changes from recorded acceptance history. Read-only; a person applies them. */
import type { Rule } from '../policy.ts'
import type { RuleRun, Store } from './store.ts'

export interface TuningDiff { field: string; from: number | string; to: number | string }

export interface TuningProposal {
  ruleId: string
  ruleName: string
  kind: 'budget-up' | 'budget-down'
  reason: string
  diff: TuningDiff[]
  next: Rule
}

export interface TuningRuleHistory { ruleId: string; name: string; runs: RuleRun[] }

export interface TuningView {
  proposals: TuningProposal[]
  history: TuningRuleHistory[]
  policy: { rules: Rule[]; sources: Record<string, unknown> }
  revision: number
}

const MIN_RUNS = 3
const MAX_RUNS = 20

function p95(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}

/** One rule's proposal, or undefined when the evidence does not justify a change. */
export function proposeFor(rule: Rule, runs: RuleRun[]): TuningProposal | undefined {
  const budget = rule.budget?.minutes
  const maxExtensions = rule.budget?.maxExtensions
  if (budget === undefined || maxExtensions === undefined || runs.length < MIN_RUNS) return undefined
  const recent = runs.slice(0, MAX_RUNS)
  const over = recent.filter(run => run.overBudget).length
  const minutes = recent.map(run => run.minutes)
  const peak = p95(minutes)
  const raising = over * 3 >= recent.length || peak > budget * 0.8
  if (raising) {
    const to = Math.min(480, Math.max(budget + 5, Math.ceil(peak * 1.3)))
    if (to <= budget) return undefined
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      kind: 'budget-up',
      reason: `${recent.length} 次里 ${over} 次超预算，P95 用时 ${peak.toFixed(1)} 分钟，接近或超过 ${budget} 分钟上限。`,
      diff: [{ field: 'budget.minutes', from: budget, to }],
      next: { ...rule, budget: { minutes: to, maxExtensions } },
    }
  }
  // An idle round did no work, so its fast, clean-looking row must not be evidence the budget is too generous.
  const clean = recent.every(run => run.hardPassed && run.softPassed && !run.overBudget && !run.noNewWork)
  if (clean && recent.length >= 5 && peak < budget * 0.5) {
    const to = Math.max(1, Math.ceil(peak * 1.5))
    if (to >= budget) return undefined
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      kind: 'budget-down',
      reason: `${recent.length} 次全部通过，P95 只用 ${peak.toFixed(1)} 分钟，${budget} 分钟上限明显偏高。`,
      diff: [{ field: 'budget.minutes', from: budget, to }],
      next: { ...rule, budget: { minutes: to, maxExtensions } },
    }
  }
  return undefined
}

export function tuningView(store: Store, rules: Rule[], sources: Record<string, unknown>): TuningView {
  const history: TuningRuleHistory[] = rules.map(rule => ({ ruleId: rule.id, name: rule.name,
    runs: store.ruleRuns.recent(rule.id, MAX_RUNS) }))
  const proposals = history.flatMap(item => {
    const rule = rules.find(candidate => candidate.id === item.ruleId)
    if (!rule) return []
    const proposal = proposeFor(rule, item.runs)
    return proposal ? [proposal] : []
  })
  return { proposals, history, policy: { rules, sources }, revision: store.blockRevision('policy') }
}

/** The panel's context-longevity view: the two constants it must share with the over-alert script, and the numbers it shows. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_WINDOW, WARN_RATIO, effectiveWindow, growthRate, requestsUntil, summarize, warnLine } from '../src/app/context-lifespan.ts'

/**
 * The over-alert CLI whose judgement this view must not widen (`context-lifespan-ui.task.md`). It lives outside the plugin,
 * so the check skips on a machine without it rather than failing; when it is there, the script itself answers.
 */
const SCRIPT = [
  process.env.SESSION_OVERFLOW_ALERT,
  join(process.env.USERPROFILE ?? '', '.dsh/state/superagent-desktop/_tools/session_overflow_alert.py'),
  join(process.cwd(), 'scripts/session_overflow_alert.py'),
].find((path): path is string => !!path && existsSync(path))

const CONFIG = { compress: { modelContextLimit: 1_000_000, outputHeadroomMaxPct: 0.1, nudgeGrowthTokens: 30_000 } }

it('shares its window, its over-alert ratio and its fallback with the over-alert script, which answers for itself', () => {
  if (!SCRIPT) return
  const source = readFileSync(SCRIPT, 'utf8')
  const value = (name: string): number => Number(new RegExp(`^${name}\\s*=\\s*([\\d.]+)`, 'm').exec(source)?.[1])
  expect(WARN_RATIO).toBe(value('WARN_RATIO'))
  expect(DEFAULT_WINDOW).toBe(value('DEFAULT_WINDOW'))
  // `effective_window` is called in the script's own process, so the panel's copy is compared against it rather than restated.
  const answer = execFileSync('python', ['-c', [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("alert", r"${SCRIPT}")`,
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'config = json.loads(sys.argv[1])',
    'print(json.dumps([module.effective_window(config), module.effective_window(None), module.WARN_RATIO, module.DEFAULT_WINDOW]))',
  ].join('\n'), JSON.stringify(CONFIG)], { encoding: 'utf8' })
  expect(JSON.parse(answer)).toEqual([effectiveWindow(CONFIG), DEFAULT_WINDOW, WARN_RATIO, DEFAULT_WINDOW])
})

it('measures the window from the proxy configuration, clamping a headroom it cannot use', () => {
  expect(effectiveWindow(CONFIG)).toBe(900_000)
  expect(warnLine(900_000)).toBe(630_000)
  expect(effectiveWindow({ compress: { modelContextLimit: 200_000, outputHeadroomMaxPct: 0.25 } })).toBe(150_000)
  expect(effectiveWindow({ compress: { modelContextLimit: 1_000_000, outputHeadroomMaxPct: 1 } })).toBe(1_000_000)
  expect(effectiveWindow({ compress: { modelContextLimit: 0 } })).toBe(DEFAULT_WINDOW)
  expect(effectiveWindow(undefined)).toBe(DEFAULT_WINDOW)
})

it('shows both calibers of one Session, the room to the over-alert line, and the requests left at the measured slope', () => {
  const config = { compress: { ...CONFIG.compress, nudgeGrowthTokens: 30_000 } }
  const at = 1_000_000
  const first = summarize('s1', { ok: true, model: 'm', contextTokens: 100_000, contextTokensSource: 'usage', requests: 10,
    contextView: { sentTotal: 90_000, growth: 4_000 } }, config, at)
  // One measurement cannot give a slope, so no forecast: the panel must not invent one.
  expect(first).toMatchObject({ ok: true, measured: 'usage', window: 900_000, warnLine: 630_000, foldStep: 30_000, sessionTokens: 100_000,
    sentTokens: 90_000, growth: 4_000, roomToWarn: 530_000, roomToWindow: 800_000, perRequest: null, roundsToWarn: null, samples: 1 })
  const second = summarize('s1', { ok: true, model: 'm', contextTokens: 140_000, contextTokensSource: 'usage', requests: 12,
    contextView: { sentTotal: 130_000 } }, config, at + 30_000)
  expect(second).toMatchObject({ perRequest: 20_000, roundsToWarn: 24, roomToWarn: 490_000, samples: 2 })
  // A fold inside the measured window shrinks the count, and the forecast stays unknown rather than going negative.
  const folded = summarize('s1', { ok: true, contextTokens: 40_000, contextTokensSource: 'estimate', requests: 13 }, config, at + 60_000)
  expect(folded.perRequest).toBeLessThan(0)
  expect(folded.roundsToWarn).toBeNull()
  expect(folded.measured).toBe('estimate')
})

it('says why it has no numbers, and keeps the window it could still read', () => {
  expect(summarize('s2', undefined, CONFIG)).toMatchObject({ ok: false, problem: 'sessionUnknown', sessionTokens: null, window: 900_000,
    samples: 0 })
  expect(summarize('s3', { ok: true, contextTokens: null, contextTokensSource: 'unavailable' }, CONFIG))
    .toMatchObject({ ok: false, problem: 'sessionUnknown', measured: 'unavailable', roundsToWarn: null })
})

it('takes the slope from whole requests only, and never reports a count that cannot fall', () => {
  expect(growthRate([{ at: 0, tokens: 10, requests: 1 }, { at: 1, tokens: 40, requests: 1 }, { at: 2, tokens: 70, requests: 4 }])).toBe(20)
  expect(growthRate([{ at: 0, tokens: 10, requests: 3 }])).toBeNull()
  expect(requestsUntil(700_000, 630_000, 10_000)).toBeNull()
  expect(requestsUntil(600_000, 630_000, null)).toBeNull()
  expect(requestsUntil(600_000, 630_000, 4_000)).toBe(7)
})

/**
 * The orchestrator Session's context longevity: bili's per-Session context measurement against the long-lived context
 * mechanism's effective window (`modelContextLimit × (1 − outputHeadroomMaxPct)`) and its over-alert line.
 *
 * The window, the alert line and the fold step are read from the running proxy, so a configuration change needs no copy
 * of them here; only the two constants the over-alert script also owns live in this module, and
 * `tests/context-lifespan.spec.ts` runs that script's own functions to prove they have not drifted apart.
 */
const PROXY = 'http://127.0.0.1:18788'
/** `DEFAULT_WINDOW` of `_tools/session_overflow_alert.py`: the effective window when the proxy reports no configuration. */
export const DEFAULT_WINDOW = 900_000
/** `WARN_RATIO` of `_tools/session_overflow_alert.py`: the over-alert line as a ratio of the effective window. */
export const WARN_RATIO = 0.7
/** How far back the per-request growth rate is measured; a fold inside it can make the slope negative, which shows as no forecast. */
const HISTORY_MS = 15 * 60_000
const HISTORY_MAX = 60
const CONFIG_MS = 60_000

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/** The parts of `/__bili/config` this view reads. */
export interface ProxyConfig { compress?: Record<string, unknown> | undefined }
/** The parts of `/__bili/plugin/status` this view reads. */
interface ProxyStatus {
  ok?: boolean
  phase?: string
  model?: string | null
  contextTokens?: number | null
  contextTokensSource?: string | null
  contextView?: { sentTotal?: number | null; growth?: number | null; anchor?: { tokens?: number | null } | null } | null
  requests?: number | null
}

/** `effective_window` of `_tools/session_overflow_alert.py`, with the same fallback and the same headroom clamp. */
export function effectiveWindow(config: ProxyConfig | undefined): number {
  const compress = config?.compress ?? {}
  const limit = Number(compress.modelContextLimit ?? 0)
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_WINDOW
  let head = Number(compress.outputHeadroomMaxPct ?? 0)
  if (!Number.isFinite(head) || head < 0 || head >= 1) head = 0
  return Math.trunc(limit * (1 - head))
}
/** The over-alert line for an effective window, rounded the way the over-alert script rounds it. */
export const warnLine = (window: number): number => Math.round(window * WARN_RATIO)

export interface ContextLifespanView {
  /** False when the proxy or the Session's status could not be read; the panel then words `problem` instead of numbers. */
  ok: boolean
  /** `proxyOffline` means nothing answers on the proxy address; `sessionUnknown` means the Session has no request yet. */
  problem?: 'proxyOffline' | 'sessionUnknown'
  session: string
  model: string | null
  /** `usage` is what the model service reported back; `estimate` is bili's own count and can exceed the window. */
  measured: 'usage' | 'estimate' | 'unavailable'
  /** The effective window: what can be sent before the model service refuses the request. */
  window: number
  /** The over-alert line; `roomToWarn` and `roundsToWarn` are measured against it. */
  warnLine: number
  /** How many new tokens since the last fold start the next one. */
  foldStep: number | null
  /** Session accounting, which includes the compressed originals: the over-alert script's caliber. */
  sessionTokens: number | null
  /** What actually goes to the model after compression: the caliber the request fuse counts. */
  sentTokens: number | null
  /** New tokens since the last fold. */
  growth: number | null
  roomToWarn: number | null
  roomToWindow: number | null
  /** Added tokens per model request, measured over the last samples of this Session. */
  perRequest: number | null
  /** Requests left before the over-alert line at `perRequest`; null when the slope is unknown or not growing. */
  roundsToWarn: number | null
  /** How many measurements the growth rate is taken from, so the panel can say when it has too few. */
  samples: number
  at: string
}

interface Sample { at: number; tokens: number; requests: number }
const histories = new Map<string, Sample[]>()
let configCache: { at: number; value: ProxyConfig } | undefined

/** Keep the Session's recent measurements, dropping anything older than `HISTORY_MS` or beyond `HISTORY_MAX`. */
function remember(session: string, sample: Sample): Sample[] {
  const kept = [...(histories.get(session) ?? []).filter(item => item.at > sample.at - HISTORY_MS), sample].slice(-HISTORY_MAX)
  if (histories.size > 200 && !histories.has(session)) histories.clear()
  histories.set(session, kept)
  return kept
}

/** Tokens added per model request since the oldest measurement that saw fewer requests; null without such a baseline. */
export function growthRate(samples: Sample[]): number | null {
  const latest = samples.at(-1)
  const base = samples.find(item => latest !== undefined && item.requests < latest.requests)
  if (!latest || !base) return null
  return (latest.tokens - base.tokens) / (latest.requests - base.requests)
}
/** How many model requests fit before `target`, at `rate` tokens per request; null when the count cannot fall. */
export function requestsUntil(tokens: number, target: number, rate: number | null): number | null {
  return rate === null || rate <= 0 || tokens >= target ? null : Math.floor((target - tokens) / rate)
}

async function read(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return await response.json()
}

/** Read the proxy's configuration, cached for a minute: it changes only when the proxy restarts. */
async function proxyConfig(now: number): Promise<ProxyConfig> {
  if (configCache && now - configCache.at < CONFIG_MS) return configCache.value
  const value = await read(`${PROXY}/__bili/config`) as ProxyConfig
  configCache = { at: now, value }
  return value
}

/** Build the view from the two payloads, so the numbers can be checked without a running proxy. */
export function summarize(session: string, status: ProxyStatus | undefined, config: ProxyConfig | undefined, now = Date.now()):
ContextLifespanView {
  const window = effectiveWindow(config)
  const line = warnLine(window)
  const foldStep = number(config?.compress?.nudgeGrowthTokens)
  const base = { session, window, warnLine: line, foldStep, at: new Date(now).toISOString() }
  if (status?.ok !== true) {
    return { ...base, ok: false, problem: 'sessionUnknown', model: null, measured: 'unavailable', sessionTokens: null, sentTokens: null,
      growth: null, roomToWarn: null, roomToWindow: null, perRequest: null, roundsToWarn: null, samples: 0 }
  }
  const tokens = number(status.contextTokens)
  const requests = number(status.requests)
  // The over-alert script judges `max(contextBest.tokens, contextTokens)`, so the panel measures the line against the same maximum.
  const best = number(status.contextView?.anchor?.tokens)
  const highest = tokens === null ? best : best === null ? tokens : Math.max(best, tokens)
  const source = status.contextTokensSource
  const measured = source === 'usage' || source === 'estimate' ? source : 'unavailable'
  const samples = highest !== null && requests !== null && requests > 0 ? remember(session, { at: now, tokens: highest, requests }) : []
  const perRequest = samples.length > 1 ? growthRate(samples) : null
  // A fold inside the measured window shrinks the count, so a negative or nil slope leaves the forecast unknown.
  const rate = perRequest !== null && perRequest > 0 ? perRequest : null
  return { ...base, ok: highest !== null, ...highest === null ? { problem: 'sessionUnknown' as const } : {}, model: status.model ?? null,
    measured, sessionTokens: highest, sentTokens: number(status.contextView?.sentTotal), growth: number(status.contextView?.growth),
    roomToWarn: highest === null ? null : line - highest, roomToWindow: highest === null ? null : window - highest,
    perRequest, roundsToWarn: highest === null ? null : requestsUntil(highest, line, rate), samples: samples.length }
}

/** The orchestrator Session's longevity, read from the running proxy. */
export async function contextLifespan(session: string, now = Date.now()): Promise<ContextLifespanView> {
  let config: ProxyConfig
  try { config = await proxyConfig(now) } catch {
    return { ...summarize(session, undefined, undefined, now), problem: 'proxyOffline' }
  }
  try {
    const status = await read(`${PROXY}/__bili/plugin/status?conversationId=${encodeURIComponent(session)}`) as ProxyStatus
    return summarize(session, status, config, now)
  } catch {
    return { ...summarize(session, undefined, config, now), problem: 'proxyOffline' }
  }
}

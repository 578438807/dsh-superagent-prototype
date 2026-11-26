/**
 * Where the bili proxy is listening.
 *
 * bili ladders to `port + 1` when its configured port is taken (`port ${p} shared with foreign listener (pid …) —
 * retrying on port ${p + 1}`, billion-context `dist/index.js`), so a fixed address is only right until the next
 * collision. bili records the address it actually settled on, and that record is the source both this plugin and
 * `scripts/session_overflow_alert.py` read — one resolver, so the two can never disagree about where bili is.
 *
 * Priority, highest first:
 *  1. `SUPERAGENT_BILI_ORIGIN` — an explicit override for an operator or a test.
 *  2. `<XDG_STATE_HOME>/billion-context/proxy-origin` — the record bili writes once its instance is healthy
 *     (`{"origin":"http://127.0.0.1:18789",…}`). Ignored when it is unreadable or names something that is not an
 *     address; a stale record fails the same way a dead process does, so it needs no separate check here.
 *  3. `DEFAULT_ORIGIN` — the address everywhere assumed before bili could be found, still right for an instance that
 *     was started on the port its config names.
 *
 * Reads only: nothing here writes the record, so no component can overwrite another's answer.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The address assumed when bili left no record and nothing overrides it (the pre-2026-11 constant). */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:18788'
export const ORIGIN_ENV = 'SUPERAGENT_BILI_ORIGIN'

/**
 * `<XDG_STATE_HOME>/billion-context/proxy-origin`, which bili computes from the same two inputs. Every bili on this
 * machine writes that one record for its startup lane; the script side reads it through `bili_origin()` so the panel
 * and the cron alert answer with the same address.
 */
export function instanceFile(home = homedir(), env: Record<string, string | undefined> = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state')
  return join(stateHome, 'billion-context', 'proxy-origin')
}

/** Just an `http://host:port` address, without a path, so a caller can append `/__bili/…`. */
const isAddress = (value: string): boolean => /^https?:\/\/[^/\s]+\/?$/i.test(value)

/** The origin a candidate names, or null when it names no address. */
function pick(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim().replace(/\/+$/, '')
  return trimmed !== undefined && isAddress(trimmed) ? trimmed : null
}

/**
 * The origin to read bili from, and which of the three sources it came from so a reader can say where it looked.
 * Never throws: a record that cannot be read falls through to the next source.
 */
export function biliOrigin(
  env: Record<string, string | undefined> = process.env,
  file: string = instanceFile(homedir(), env),
): { origin: string; source: 'env' | 'instance' | 'default' } {
  const fromEnv = pick(env[ORIGIN_ENV])
  if (fromEnv !== null) return { origin: fromEnv, source: 'env' }
  try {
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as { origin?: unknown }
    const fromRecord = pick(typeof recorded.origin === 'string' ? recorded.origin : undefined)
    if (fromRecord !== null) return { origin: fromRecord, source: 'instance' }
  } catch {
    // No record yet, or one being written: the default is the answer, exactly as before bili was discovered at all.
  }
  return { origin: DEFAULT_ORIGIN, source: 'default' }
}
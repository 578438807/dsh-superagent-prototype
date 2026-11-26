/** The failure ledger: one JSON line per unfinished report, so the main Session can triage what the posts could not finish. */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One ledger entry: the ticket, its rule, the state it reported, and the reported summary. */
export interface FailureLine {
  at: string
  ticketId: string
  ruleId?: string
  state: string
  summary: string
}

/** Builds a ledger entry; the ledger is joined on the ticket, rule and state so a repeated report stays visible. */
export function failureLine(ticketId: string, ruleId: string | undefined, state: string, summary: string): FailureLine {
  return { at: new Date().toISOString(), ticketId, ...(ruleId ? { ruleId } : {}), state, summary }
}

/** Appends an entry to outputs/failures/<yyyyMMdd>.jsonl under the ticket's working directory. */
export async function recordFailure(directory: string, line: FailureLine): Promise<void> {
  const day = line.at.slice(0, 10)
  const path = join(directory, 'outputs', 'failures', `${day}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8')
}

/**
 * The tools a ticket's declaration grants. A ticket asks for what its work needs, by capability (a name this table knows) or by
 * tool name, and the declaration only names tools the profile has: a worker still runs on the baseline work tools plus these,
 * and nothing else (see `Sessions.workOnly`). A tool it needs beyond them is a request it reports, which the main Session decides.
 */
export const CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // A real browser a worker can drive: the profile's `browser` tool (headless Chromium, no extension a person must install).
  'web-local': ['browser'],
  // BrowserSkill's tools, which drive the person's own logged-in browser through its extension and `bsk` daemon.
  'browser-skill': ['bsk_assist', 'bsk_inspect', 'bsk_interact', 'bsk_page', 'bsk_session', 'bsk_tabs'],
}
/**
 * The tools `declared` names, in declaration order and without duplicates. A name the table does not know is taken as a tool
 * name as it stands, so a declaration may name one tool directly; whether the profile has it is decided where tools are restricted.
 */
export function declaredTools(declared: readonly string[] | undefined): string[] {
  const tools: string[] = []
  for (const name of declared ?? []) for (const tool of CAPABILITY_TOOLS[name] ?? [name]) if (!tools.includes(tool)) tools.push(tool)
  return tools
}

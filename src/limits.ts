/** Validation bounds for the host zod schemas. Each constant is also the input limit of the panel control that sets the same value, so a person meets the bound the API does; the bounds that only a code path may set (approval class names, the length of a class list) live next to the code that sets them. */
export const LIMITS = {
  ruleName: 100,
  /** A rule instruction states an intent in a few sentences; 2000 was an arbitrary guard that forced a job to compress its own mandate into a pipeline. */
  ruleInstruction: 8000,
  ruleObjective: 4000,
  ruleRedLines: 20,
  ruleRedLine: 300,
  acceptanceItems: 20,
  acceptanceItem: 300,
  ruleBudgetMinutes: { min: 1, max: 480 },
  ruleMaxExtensions: { min: 0, max: 5 },
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
  scheduleWindows: { min: 0, max: 12 },
} as const

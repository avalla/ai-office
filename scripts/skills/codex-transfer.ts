import type { TransferCoreFacts } from "./transfer-contract.ts";

/**
 * Codex adapter row for the continuity transfer table. Only the
 * question-mechanism phrase is executor-specific; every fact comes from the
 * shared contract verbatim.
 */
export const codexQuestionPhrase =
  "asks in the session prompt, one key at a time";

export function renderCodexTransferRow(facts: TransferCoreFacts): string {
  return `| Codex | ${codexQuestionPhrase} | ${facts.checkpointsLocation} and ${facts.handoffLocation} | ${facts.agentToPerson} |`;
}

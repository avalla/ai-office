import type { TransferCoreFacts } from "./transfer-contract.ts";

/**
 * Claude Code adapter row for the continuity transfer table. Only the
 * question-mechanism phrase is executor-specific; every fact comes from the
 * shared contract verbatim.
 */
export const claudeQuestionPhrase =
  "asks through its question tool, one key at a time";

export function renderClaudeTransferRow(facts: TransferCoreFacts): string {
  return `| Claude Code | ${claudeQuestionPhrase} | ${facts.checkpointsLocation} and ${facts.handoffLocation} | ${facts.agentToPerson} |`;
}

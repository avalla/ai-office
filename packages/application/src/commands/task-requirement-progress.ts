/**
 * Progress across the requirements a task explicitly links.
 *
 * Its own module because three callers need it — the board, reconciliation, and
 * the completion-record preflight — and importing it from any one of them would
 * make those three depend on each other for a pure calculation.
 *
 * It is progress *beside* a task status, never a substitute for one: nothing
 * here decides what a task's status is.
 */

import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";

export interface RequirementProgress {
  total: number;
  verified: number;
  terminal: number;
  open: number;
}

const terminalRequirementStatuses = new Set<RequirementStatus>([
  "verified",
  "rejected",
]);

export function isTerminalRequirementStatus(status: RequirementStatus): boolean {
  return terminalRequirementStatuses.has(status);
}

export function requirementProgress(
  requirements: readonly { status: RequirementStatus }[],
): RequirementProgress {
  const terminal = requirements.filter((value) =>
    terminalRequirementStatuses.has(value.status),
  ).length;
  return {
    total: requirements.length,
    verified: requirements.filter((value) => value.status === "verified")
      .length,
    terminal,
    open: requirements.length - terminal,
  };
}

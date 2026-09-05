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

export function isTerminalRequirementStatus(
  status: RequirementStatus,
): boolean {
  return terminalRequirementStatuses.has(status);
}

export function requirementProgress(
  requirements: readonly { status: RequirementStatus }[],
): RequirementProgress {
  return requirementProgressFromCounts(
    requirements.map((value) => ({ status: value.status, count: 1 })),
  );
}

/** Exact grouped facts keep read-side memory bounded by status count. */
export function requirementProgressFromCounts(
  counts: readonly { status: RequirementStatus; count: number }[],
): RequirementProgress {
  const total = counts.reduce((sum, value) => sum + value.count, 0);
  const terminal = counts.reduce(
    (sum, value) =>
      sum + (isTerminalRequirementStatus(value.status) ? value.count : 0),
    0,
  );
  return {
    total,
    verified: counts.reduce(
      (sum, value) => sum + (value.status === "verified" ? value.count : 0),
      0,
    ),
    terminal,
    open: total - terminal,
  };
}

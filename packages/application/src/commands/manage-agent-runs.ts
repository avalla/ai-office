import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { normalizeTaskReason } from "@ai-office/domain/task/task.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { ControlledExecutionRepository } from "../ports/controlled-execution-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";
import type { RunExecutionControl } from "../runtime/run-execution-control.ts";

export class ManageAgentRuns {
  constructor(
    private readonly runs: AgentRuntimeRepository,
    private readonly capabilities: CapabilityPolicyRepository,
    private readonly controlled: ControlledExecutionRepository,
    private readonly control: RunExecutionControl,
    private readonly audit: RecordAuditEvent,
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
  ) {}

  async inspect(
    projectId: string,
    runId: string,
    reason = "Inspect interrupted execution",
  ) {
    const run = await this.requireRun(projectId, runId);
    const r = run.snapshot();
    const terminal = ["completed", "failed", "cancelled"].includes(r.status);
    const actions = await Promise.all(
      (await this.capabilities.listActionRequests(projectId))
        .map((value) => value.snapshot())
        .filter((value) => value.agentRunId === runId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(async (value) => ({
          id: value.id,
          status: value.status,
          payloadHash: value.payloadHash,
          executionStatus:
            (
              await this.controlled.findExecutionByAction(value.id, projectId)
            )?.snapshot().status ?? null,
        })),
    );
    const ambiguous = actions.some(
      (value) =>
        ["executing", "execution_unknown"].includes(value.status) ||
        (value.executionStatus !== null &&
          ["executing", "execution_unknown"].includes(value.executionStatus)),
    );
    const ownerId = await this.runs.executionOwner(runId);
    const live = this.control.has(runId);
    const lock = await this.runs.findTaskLock(r.taskId);
    const classification = ambiguous
      ? "ambiguous"
      : live
        ? "live"
        : terminal
          ? lock?.runId === runId
            ? "terminal_cleanup"
            : "terminal"
          : r.status === "queued"
            ? "queued"
            : "orphaned";
    const evidence = {
      schemaVersion: 1,
      projectId,
      runId,
      taskId: r.taskId,
      recordedStatus: r.status,
      updatedAt: r.updatedAt.toISOString(),
      ownerId,
      classification,
      cancellationRequested: this.control.cancellationRequested(runId),
      actions,
      lock:
        lock === null
          ? null
          : { runId: lock.runId, expiresAt: lock.expiresAt.toISOString() },
      reason: normalizeTaskReason(reason, "Recovery reason"),
      available:
        classification === "orphaned" || classification === "terminal_cleanup",
      resultingStatus: terminal ? r.status : "cancelled",
    };
    return {
      ...evidence,
      planHash: createHash("sha256")
        .update(canonicalStringify(evidence))
        .digest("hex"),
    };
  }

  async cancel(input: {
    projectId: string;
    runId: string;
    actorId: string;
    reason: string;
  }) {
    const reason = normalizeTaskReason(input.reason, "Cancellation reason");
    const report = await this.inspect(input.projectId, input.runId, reason);
    if (report.classification === "terminal")
      return { status: "already_terminal" };
    if (report.classification === "ambiguous")
      throw new DomainValidationError(
        "Run has an ambiguous controlled effect; inspect its action before recovery",
      );
    if (this.control.has(input.runId)) {
      await this.audit.execute({
        eventType: "run.cancellation_requested",
        actorType: "cli",
        actorId: input.actorId,
        projectId: input.projectId,
        aggregateType: "agent_run",
        aggregateId: input.runId,
        payload: { reason },
      });
      if (this.control.cancel(input.runId))
        return { status: "cancellation_requested" };
      // The audit records operator intent, not delivery. Execution may have
      // finished and released its handle while that intent was being persisted.
      const current = await this.inspect(input.projectId, input.runId, reason);
      if (current.classification === "terminal")
        return { status: "already_terminal" };
      if (current.classification === "ambiguous")
        throw new DomainValidationError(
          "Run has an ambiguous controlled effect; inspect its action before recovery",
        );
      if (
        current.classification === "orphaned" ||
        current.classification === "terminal_cleanup"
      )
        throw new DomainValidationError(
          "Interrupted run requires run:reconcile with an approved plan",
        );
      throw new DomainValidationError(
        "Run changed without cancellation delivery; inspect before cancelling",
      );
    }
    if (report.classification !== "queued")
      throw new DomainValidationError(
        "Interrupted run requires run:reconcile with an approved plan",
      );
    await this.transactions.run(async () => {
      const current = await this.requireRun(input.projectId, input.runId);
      if (
        current.snapshot().status !== "queued" ||
        this.control.has(input.runId)
      )
        throw new DomainValidationError(
          "Run changed; inspect before cancelling",
        );
      current.transition("cancelled", this.clock.now(), {
        error: {
          code: "OPERATOR_CANCELLED",
          message: "Execution cancelled by operator",
        },
      });
      await this.runs.saveRun(current);
      await this.runs.releaseTaskLock(input.runId);
      await this.audit.execute({
        eventType: "run.cancelled",
        actorType: "cli",
        actorId: input.actorId,
        projectId: input.projectId,
        aggregateType: "agent_run",
        aggregateId: input.runId,
        payload: { reason },
      });
    });
    return { status: "cancelled" };
  }

  async reconcile(input: {
    projectId: string;
    runId: string;
    actorId: string;
    reason: string;
    approve?: string;
  }) {
    const plan = await this.inspect(input.projectId, input.runId, input.reason);
    if (input.approve === undefined) return { ...plan, applied: false };
    await this.transactions.run(async () => {
      const fresh = await this.inspect(
        input.projectId,
        input.runId,
        input.reason,
      );
      if (
        !fresh.available ||
        fresh.planHash !== input.approve ||
        this.control.has(input.runId)
      )
        throw new DomainValidationError(
          "Run recovery plan is stale or unavailable",
        );
      const run = await this.requireRun(input.projectId, input.runId);
      if (fresh.classification !== "terminal_cleanup") {
        run.transition("cancelled", this.clock.now(), {
          error: {
            code: "INTERRUPTED_RUN_RESOLVED",
            message: "Interrupted execution resolved without replay",
          },
        });
        await this.runs.saveRun(run);
      }
      await this.runs.releaseTaskLock(input.runId);
      await this.audit.execute({
        eventType: "run.reconciled",
        actorType: "cli",
        actorId: input.actorId,
        projectId: input.projectId,
        aggregateType: "agent_run",
        aggregateId: input.runId,
        payload: {
          reason: fresh.reason,
          planHash: fresh.planHash,
          from: fresh.recordedStatus,
          to: fresh.resultingStatus,
          ownerId: fresh.ownerId,
        },
      });
    });
    return { ...plan, applied: true };
  }

  async cancelTaskRuns(input: {
    projectId: string;
    taskId: string;
    actorId: string;
    reason: string;
  }): Promise<void> {
    for (const run of await this.runs.listRuns(input.projectId)) {
      const r = run.snapshot();
      if (
        r.taskId !== input.taskId ||
        ["completed", "failed", "cancelled"].includes(r.status)
      )
        continue;
      // Orphaned/ambiguous work remains visible for explicit reconciliation.
      if (r.status === "queued" || this.control.has(r.id))
        await this.cancel({ ...input, runId: r.id });
    }
  }

  private async requireRun(projectId: string, runId: string) {
    const run = await this.runs.findRun(runId);
    if (run === null || run.snapshot().projectId !== projectId)
      throw new DomainValidationError("Agent run not found in project");
    return run;
  }
}

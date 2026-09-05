import { expect, test, vi } from "vitest";
import { join } from "node:path";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import { ManageAgentRuns } from "@ai-office/application/commands/manage-agent-runs.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { RunExecutionControl } from "@ai-office/application/runtime/run-execution-control.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteControlledExecutionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-controlled-execution.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { runRuntime } from "../helpers/run-runtime.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const runtime = await runRuntime();
  const database = openDatabase(
    join(runtime.root, ".ai-office", "project.sqlite"),
  );
  const runs = new SqliteAgentRuntimeRepository(database);
  const capabilities = new SqliteCapabilityPolicyRepository(database);
  const control = new RunExecutionControl("race-test-host");
  const clock = { now: () => new Date("2030-01-01T00:00:00Z") };
  const taskId = await runtime.task();
  const runId = (await runtime.schedule(taskId)).stdout[0]!.replace(
    "Agent run scheduled: ",
    "",
  );
  const run = (await runs.findRun(runId))!;
  for (const status of ["preparing", "running"] as const) {
    run.transition(status, clock.now());
    await runs.saveRun(run);
  }
  const signal = control.reserve(runId, taskId)!;
  let aborts = 0;
  signal.addEventListener("abort", () => {
    aborts++;
  });
  const cancel = vi.spyOn(control, "cancel");
  const entered = gate(),
    resume = gate();
  const persistedAudit = new SqliteAuditEventRepository(database);
  const audit = new RecordAuditEvent(
    {
      append: async (event) => {
        entered.release();
        await resume.promise;
        await persistedAudit.append(event);
      },
    },
    { generate: () => crypto.randomUUID() },
    clock,
  );
  const service = new ManageAgentRuns(
    runs,
    capabilities,
    new SqliteControlledExecutionRepository(database),
    control,
    audit,
    new SqliteTransactionRunner(database),
    clock,
  );
  const input = {
    projectId: runtime.projectId,
    runId,
    actorId: "operator",
    reason: "Stop live work",
  };
  const evidence = async () => ({
    run: (await runs.findRun(runId))!.snapshot(),
    lock: await runs.findTaskLock(taskId),
    events: await runs.listRunEvents(runId),
    actions: (await capabilities.listActionRequests(runtime.projectId)).map(
      (action) => action.snapshot(),
    ),
  });
  return {
    runtime,
    runs,
    run,
    control,
    clock,
    capabilities,
    service,
    input,
    signal,
    cancel,
    entered,
    resume,
    persistedAudit,
    evidence,
    aborts: () => aborts,
    intents: () =>
      database
        .query(
          "SELECT event_type FROM audit_event WHERE aggregate_id = ? AND event_type = ?",
        )
        .all(runId, "run.cancellation_requested"),
    close: async () => {
      resume.release();
      control.release(runId);
      database.close();
      await runtime.close();
    },
  };
}

test.each(["completed", "failed", "cancelled"] as const)(
  "cancellation rechecks %s completion after a gated intent write without claiming delivery",
  async (status) => {
    const f = await fixture();
    try {
      const pending = f.service.cancel(f.input);
      await f.entered.promise;
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.signal.aborted).toBe(false);
      expect(f.intents()).toHaveLength(0);
      // Deterministically model execution persisting a terminal result and
      // finishing cleanup while cancellation is awaiting its audit append.
      f.run.transition(status, f.clock.now());
      await f.runs.saveRun(f.run);
      await f.runs.releaseTaskLock(f.input.runId);
      f.control.release(f.input.runId);
      if (status === "completed") {
        // A different run may legitimately own the task by the time we resume.
        expect(
          (await f.runtime.schedule(f.run.snapshot().taskId)).exitCode,
        ).toBe(0);
        expect((await f.evidence()).lock?.runId).not.toBe(f.input.runId);
      }
      const completed = await f.evidence();
      f.resume.release();
      expect(await pending).toEqual({ status: "already_terminal" });
      expect(f.cancel).toHaveReturnedWith(false);
      expect(f.aborts()).toBe(0);
      expect(await f.evidence()).toEqual(completed);
      expect(f.intents()).toHaveLength(1);
      expect(await f.service.cancel(f.input)).toEqual({
        status: "already_terminal",
      });
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.intents()).toHaveLength(1);
      expect(await f.evidence()).toEqual(completed);
    } finally {
      await f.close();
    }
  },
);

test.each([
  "orphaned",
  "terminal_cleanup",
  "ambiguous",
  "inconsistent",
] as const)(
  "lost cancellation delivery fails closed for %s evidence without repair or replay",
  async (state) => {
    const f = await fixture();
    try {
      // Attach the rejection handler before releasing the audit gate.
      const pending = f.service.cancel(f.input).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      await f.entered.promise;
      if (state === "terminal_cleanup") {
        f.run.transition("completed", f.clock.now());
        await f.runs.saveRun(f.run);
      }
      if (state === "ambiguous") {
        vi.spyOn(f.capabilities, "listActionRequests").mockResolvedValue([
          ActionRequest.restore({
            id: "ambiguous-action",
            projectId: f.input.projectId,
            agentId: f.runtime.agentId,
            agentRunId: f.input.runId,
            resourceId: "resource",
            connector: "filesystem",
            connectorVersion: "2",
            operation: "filesystem.write",
            normalizedArguments: {},
            effectiveConstraints: {},
            payloadHash: "a".repeat(64),
            decision: "allow_with_approval",
            riskLevel: "medium",
            matchedGrantIds: [],
            reasons: [],
            status: "execution_unknown",
            createdAt: f.clock.now(),
            updatedAt: f.clock.now(),
          }),
        ]);
      }
      if (state === "inconsistent") f.cancel.mockReturnValue(false);
      else f.control.release(f.input.runId);
      const before = await f.evidence();
      f.resume.release();
      const outcome = await pending;
      expect(outcome.result).toBeNull();
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain(
        state === "ambiguous"
          ? "ambiguous controlled effect"
          : state === "inconsistent"
            ? "without cancellation delivery"
            : "run:reconcile",
      );
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveReturnedWith(false);
      expect(f.aborts()).toBe(0);
      expect(f.intents()).toHaveLength(1);
      expect(await f.evidence()).toEqual(before);
      expect(before.lock?.runId).toBe(f.input.runId);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

test("live cancellation delivers abort only after intent is durable, without acknowledging terminal cancellation", async () => {
  const f = await fixture();
  try {
    const before = await f.evidence();
    const pending = f.service.cancel(f.input);
    await f.entered.promise;
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.signal.aborted).toBe(false);
    f.signal.addEventListener("abort", () => {
      expect(f.intents()).toHaveLength(1);
    });
    f.resume.release();
    expect(await pending).toEqual({ status: "cancellation_requested" });
    expect(f.cancel).toHaveReturnedWith(true);
    expect(f.aborts()).toBe(1);
    expect(await f.evidence()).toEqual(before);
    expect(before.run.status).toBe("running");
    expect(before.lock?.runId).toBe(f.input.runId);
  } finally {
    await f.close();
  }
});

test("failed intent persistence never signals live execution or changes run evidence", async () => {
  const f = await fixture();
  try {
    vi.spyOn(f.persistedAudit, "append").mockRejectedValue(
      new Error("Audit fault"),
    );
    const before = await f.evidence();
    const pending = expect(f.service.cancel(f.input)).rejects.toThrow(
      "Audit fault",
    );
    await f.entered.promise;
    f.resume.release();
    await pending;
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.aborts()).toBe(0);
    expect(f.intents()).toHaveLength(0);
    expect(await f.evidence()).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

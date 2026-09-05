import { expect, test } from "vitest";
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
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";
import { runRuntime } from "../helpers/run-runtime.ts";

test("recovery preserves ambiguous effects, rolls back on audit failure and restores backup readiness", async () => {
  const r = await runRuntime();
  const database = openDatabase(join(r.root, ".ai-office", "project.sqlite"));
  try {
    const taskId = await r.task();
    const runId = (await r.schedule(taskId)).stdout[0]!.replace(
      "Agent run scheduled: ",
      "",
    );
    const runs = new SqliteAgentRuntimeRepository(database);
    const capabilities = new SqliteCapabilityPolicyRepository(database);
    const control = new RunExecutionControl("current-host");
    const clock = { now: () => new Date() };
    const ids = { generate: () => crypto.randomUUID() };
    let failAudit = true;
    const persistedAudit = new SqliteAuditEventRepository(database);
    const audit = new RecordAuditEvent(
      {
        append: async (event) => {
          if (failAudit) throw new Error("Audit fault");
          await persistedAudit.append(event);
        },
      },
      ids,
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
    const run = (await runs.findRun(runId))!;
    run.transition("preparing", clock.now());
    await runs.saveRun(run);
    const input = {
      projectId: r.projectId,
      runId,
      actorId: "operator",
      reason: "Resolve stopped worker",
    };
    const plan = await service.inspect(r.projectId, runId, input.reason);
    await expect(
      service.reconcile({ ...input, approve: plan.planHash }),
    ).rejects.toThrow("Audit fault");
    expect((await runs.findRun(runId))!.snapshot().status).toBe("preparing");
    expect((await runs.findTaskLock(taskId))?.runId).toBe(runId);
    const originalActions = capabilities.listActionRequests.bind(capabilities);
    capabilities.listActionRequests = async () => [
      ActionRequest.restore({
        id: "ambiguous-action",
        projectId: r.projectId,
        agentId: r.agentId,
        agentRunId: runId,
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
        createdAt: clock.now(),
        updatedAt: clock.now(),
      }),
    ];
    const ambiguous = await service.inspect(r.projectId, runId, input.reason);
    expect(ambiguous).toMatchObject({
      classification: "ambiguous",
      available: false,
    });
    await expect(
      service.reconcile({ ...input, approve: ambiguous.planHash }),
    ).rejects.toThrow("unavailable");
    capabilities.listActionRequests = originalActions;
    failAudit = false;
    const state = new SqliteProjectStateRepository(database);
    expect(
      (await state.findPortabilityBlockers(r.projectId, clock.now())).length,
    ).toBeGreaterThan(0);
    await service.reconcile({ ...input, approve: plan.planHash });
    expect(
      await state.findPortabilityBlockers(r.projectId, clock.now()),
    ).toEqual([]);
    expect(
      (await runs.listRunEvents(runId)).map((value) => value.status),
    ).toEqual(["queued", "preparing", "cancelled"]);
    expect(
      (await r.command(["task:list", "--project", r.projectId])).stdout.join(
        "\n",
      ),
    ).toContain("pending");
    const cleanupRunId = (await r.schedule(taskId)).stdout[0]!.replace(
      "Agent run scheduled: ",
      "",
    );
    const cleanupRun = (await runs.findRun(cleanupRunId))!;
    for (const status of ["preparing", "running", "completed"] as const) {
      cleanupRun.transition(status, clock.now());
      await runs.saveRun(cleanupRun);
    }
    const cleanup = await service.inspect(
      r.projectId,
      cleanupRunId,
      input.reason,
    );
    expect(cleanup).toMatchObject({
      classification: "terminal_cleanup",
      available: true,
      resultingStatus: "completed",
    });
    await service.reconcile({
      ...input,
      runId: cleanupRunId,
      approve: cleanup.planHash,
    });
    expect((await runs.findRun(cleanupRunId))!.snapshot().status).toBe(
      "completed",
    );
    expect(await runs.findTaskLock(taskId)).toBeNull();
  } finally {
    database.close();
    await r.close();
  }
});

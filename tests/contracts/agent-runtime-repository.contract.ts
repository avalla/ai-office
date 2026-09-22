import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { AgentRuntimeRepository } from "@ai-office/application/ports/agent-runtime-repository.port.ts";

export interface AgentRuntimeContractHarness {
  runtime: AgentRuntimeRepository;
  projectId: string;
  taskId: string;
  agentId: string;
  roleId: string;
  idPrefix: string;
  now: Date;
  close(): Promise<void>;
}

export function defineAgentRuntimeRepositoryContracts(
  createHarness: () => Promise<AgentRuntimeContractHarness>,
): void {
  let harness: AgentRuntimeContractHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  describe("AgentRuntimeRepository shared contract", () => {
    test("round-trips a queued run and appends one event per status", async () => {
      const run = AgentRun.create({
        id: `${harness.idPrefix}-run`,
        projectId: harness.projectId,
        taskId: harness.taskId,
        agentId: harness.agentId,
        now: harness.now,
      });
      await harness.runtime.saveRun(run);
      expect(
        (await harness.runtime.findRun(run.snapshot().id))?.snapshot(),
      ).toEqual(run.snapshot());
      run.transition("preparing", harness.now);
      await harness.runtime.saveRun(run);
      expect(
        (await harness.runtime.listRunEvents(run.snapshot().id)).map(
          (event) => event.status,
        ),
      ).toEqual(["queued", "preparing"]);
      await harness.runtime.saveRun(run);
      expect(
        (await harness.runtime.listRunEvents(run.snapshot().id)).map(
          (event) => event.status,
        ),
      ).toEqual(["queued", "preparing"]);
    });

    test("allows only one lock owner and rejects stale ownership operations", async () => {
      const first = AgentRun.create({
        id: `${harness.idPrefix}-run-a`,
        projectId: harness.projectId,
        taskId: harness.taskId,
        agentId: harness.agentId,
        now: harness.now,
      });
      const second = AgentRun.create({
        id: `${harness.idPrefix}-run-b`,
        projectId: harness.projectId,
        taskId: harness.taskId,
        agentId: harness.agentId,
        now: harness.now,
      });
      await harness.runtime.saveRun(first);
      await harness.runtime.saveRun(second);
      const expiresAt = new Date(harness.now.getTime() + 10_000);
      const owners = await Promise.all([
        harness.runtime.acquireTaskLock(
          harness.taskId,
          first.snapshot().id,
          harness.now,
          expiresAt,
        ),
        harness.runtime.acquireTaskLock(
          harness.taskId,
          second.snapshot().id,
          harness.now,
          expiresAt,
        ),
      ]);
      expect(owners.filter(Boolean)).toHaveLength(1);
      const owner = (await harness.runtime.findTaskLock(harness.taskId))?.runId;
      expect(
        await harness.runtime.renewTaskLock(
          owner === first.snapshot().id
            ? second.snapshot().id
            : first.snapshot().id,
          harness.now,
          new Date(harness.now.getTime() + 20_000),
        ),
      ).toBe(false);
      expect(
        await harness.runtime.releaseTaskLock(owner === undefined ? "" : owner),
      ).toBe(true);
    });

    test("admits one queued run and returns null for the losing CAS", async () => {
      const run = AgentRun.create({
        id: `${harness.idPrefix}-admit`,
        projectId: harness.projectId,
        taskId: harness.taskId,
        agentId: harness.agentId,
        now: harness.now,
      });
      await harness.runtime.saveRun(run);
      await harness.runtime.acquireTaskLock(
        harness.taskId,
        run.snapshot().id,
        harness.now,
        new Date(harness.now.getTime() + 10_000),
      );
      const authority = {
        taskStatus: "pending",
        taskUpdatedAt: harness.now,
        agentRoleId: harness.roleId,
        agentUpdatedAt: harness.now,
        pipelineId: null,
        pipelineStageRunId: null,
        pipelineVersion: null,
      };
      const [first, second] = await Promise.all([
        harness.runtime.admitQueuedRun({
          runId: run.snapshot().id,
          now: harness.now,
          authority,
        }),
        harness.runtime.admitQueuedRun({
          runId: run.snapshot().id,
          now: harness.now,
          authority,
        }),
      ]);
      expect([first, second].filter((value) => value !== null)).toHaveLength(1);
      expect(
        [first, second].filter(
          (value) => value?.snapshot().status === "cancelled",
        ),
      ).toHaveLength(0);
    });
  });
}

import { describe, expect, test } from "vitest";
import type { OfficeManifestRepository } from "@ai-office/application/ports/office-manifest-repository.port.ts";
import type { PipelineRunRepository } from "@ai-office/application/ports/pipeline-run-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";

export interface PipelineRunContractFixture {
  projects: ProjectRepository;
  tasks: TaskRepository;
  manifests: OfficeManifestRepository;
  pipelines: PipelineRunRepository;
  transactions: TransactionRunner;
  prepareAgents?(projectId: string): Promise<void>;
  close(): Promise<void>;
}

const now = new Date("2026-09-22T00:00:00.000Z");

function agentId(projectId: string, index: number): string {
  return `${projectId}-agent-${index}`;
}

const definition: OfficePipeline = {
  id: "delivery",
  name: "Delivery",
  description: "Ship safely",
  defaultFor: ["feature"],
  enforcement: "enforced",
  stages: [
    {
      id: "build",
      name: "Build",
      roleId: "developer",
      objective: "Build",
      checks: ["Tests"],
      requiresApproval: false,
      capabilities: ["filesystem.read"],
    },
    {
      id: "review",
      name: "Review",
      roleId: "reviewer",
      objective: "Review",
      checks: ["Approval"],
      requiresApproval: true,
      requiresIndependentApproval: true,
      capabilities: ["filesystem.read"],
    },
  ],
};

const manifest = {
  schemaVersion: 1 as const,
  provenance: {
    host: "codex",
    skill: "ai-office" as const,
    skillVersion: "1.0.0",
  },
  project: {
    mission: "Contract mission",
    goals: ["Ship"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Contract office",
    roles: [
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
      {
        id: "reviewer",
        title: "Reviewer",
        purpose: "Review",
        responsibilities: ["Review"],
      },
    ],
  },
  pipelines: [definition],
};

async function seed(
  fixture: PipelineRunContractFixture,
  projectId: string,
  taskId: string,
  manifestId: string,
): Promise<PipelineRun> {
  await fixture.projects.save(
    Project.create({ id: projectId, name: projectId, now }),
  );
  await fixture.tasks.save(
    Task.create({ id: taskId, projectId, title: "Feature", now }),
  );
  await fixture.prepareAgents?.(projectId);
  await fixture.manifests.save({
    id: manifestId,
    projectId,
    revision: 1,
    manifest,
    appliedAt: now,
  });
  return PipelineRun.create({
    id: `run-${projectId}`,
    projectId,
    taskId,
    manifestRevisionId: manifestId,
    manifestRevision: 1,
    definition,
    startedBy: "operator",
    stageRunIds: [`stage-${projectId}-build`, `stage-${projectId}-review`],
    now,
  });
}

export function definePipelineRunRepositoryContracts(
  create: () => Promise<PipelineRunContractFixture>,
): void {
  describe("PipelineRunRepository contract", () => {
    test("round-trips pinned definition, stage state, and active-by-task", async () => {
      const fixture = await create();
      try {
        const run = await seed(
          fixture,
          "pipeline-project",
          "pipeline-task",
          "manifest-pipeline",
        );
        await fixture.pipelines.insert(run);
        const restored = await fixture.pipelines.findById(
          run.snapshot().id,
          "pipeline-project",
        );
        expect(restored?.snapshot()).toMatchObject({
          projectId: "pipeline-project",
          taskId: "pipeline-task",
          manifestRevisionId: "manifest-pipeline",
          manifestRevision: 1,
          definition,
          status: "active",
          currentStageIndex: 0,
          version: 1,
          stages: [
            { stageId: "build", status: "active" },
            { stageId: "review", status: "pending" },
          ],
        });
        await expect(
          fixture.pipelines.findActiveByTask(
            "pipeline-task",
            "pipeline-project",
          ),
        ).resolves.toMatchObject({ snapshot: expect.any(Function) });
      } finally {
        await fixture.close();
      }
    });

    test("lists deterministically and isolates projects", async () => {
      const fixture = await create();
      try {
        const first = await seed(
          fixture,
          "pipeline-project-a",
          "task-a",
          "manifest-a",
        );
        const second = await seed(
          fixture,
          "pipeline-project-b",
          "task-b",
          "manifest-b",
        );
        await fixture.pipelines.insert(first);
        await fixture.pipelines.insert(second);
        await expect(
          fixture.pipelines.listByProject("pipeline-project-a"),
        ).resolves.toHaveLength(1);
        await expect(
          fixture.pipelines.listActiveByProject("pipeline-project-a"),
        ).resolves.toHaveLength(1);
        await expect(
          fixture.pipelines.findById(first.snapshot().id, "pipeline-project-b"),
        ).resolves.toBeNull();
      } finally {
        await fixture.close();
      }
    });

    test("performs CAS atomically and rejects a stale writer", async () => {
      const fixture = await create();
      try {
        const run = await seed(
          fixture,
          "cas-project",
          "cas-task",
          "manifest-cas",
        );
        await fixture.pipelines.insert(run);
        const first = (await fixture.pipelines.findById(
          run.snapshot().id,
          "cas-project",
        ))!;
        const second = (await fixture.pipelines.findById(
          run.snapshot().id,
          "cas-project",
        ))!;
        first.assign(
          agentId("cas-project", 1),
          "developer",
          new Date(now.getTime() + 1),
        );
        second.assign(
          agentId("cas-project", 2),
          "developer",
          new Date(now.getTime() + 2),
        );
        const [winner, loser] = await Promise.all([
          fixture.pipelines.save(first, 1),
          fixture.pipelines.save(second, 1),
        ]);
        expect([winner, loser].sort()).toEqual([false, true]);
        const restored = (await fixture.pipelines.findById(
          run.snapshot().id,
          "cas-project",
        ))!.snapshot();
        expect(restored.version).toBe(2);
        expect(restored.stages[0]?.assignedAgentId).toMatch(
          /^cas-project-agent-[12]$/,
        );
      } finally {
        await fixture.close();
      }
    });

    test("round-trips approval and terminal timestamps", async () => {
      const fixture = await create();
      try {
        const run = await seed(
          fixture,
          "terminal-project",
          "terminal-task",
          "manifest-terminal",
        );
        await fixture.pipelines.insert(run);
        const stored = (await fixture.pipelines.findById(
          run.snapshot().id,
          "terminal-project",
        ))!;
        stored.assign(
          agentId("terminal-project", 1),
          "developer",
          new Date(now.getTime() + 1),
        );
        expect(await fixture.pipelines.save(stored, 1)).toBe(true);
        stored.completeStage(
          agentId("terminal-project", 1),
          new Date(now.getTime() + 2),
        );
        expect(await fixture.pipelines.save(stored, 2)).toBe(true);
        stored.assign(
          agentId("terminal-project", 2),
          "reviewer",
          new Date(now.getTime() + 3),
        );
        expect(await fixture.pipelines.save(stored, 3)).toBe(true);
        stored.completeStage(
          agentId("terminal-project", 2),
          new Date(now.getTime() + 4),
        );
        expect(await fixture.pipelines.save(stored, 4)).toBe(true);
        stored.approveStage(
          "reviewer",
          "Looks good",
          new Date(now.getTime() + 5),
        );
        expect(await fixture.pipelines.save(stored, 5)).toBe(true);
        const snapshot = (await fixture.pipelines.findById(
          stored.snapshot().id,
          "terminal-project",
        ))!.snapshot();
        expect(snapshot.status).toBe("completed");
        expect(snapshot.completedAt).toEqual(new Date(now.getTime() + 5));
        expect(snapshot.stages[1]).toMatchObject({
          approvedBy: "reviewer",
          approvalDecision: "approved",
          approvalRationale: "Looks good",
          approvedAt: new Date(now.getTime() + 5),
        });
      } finally {
        await fixture.close();
      }
    });

    test("appends exact-stage overrides in createdAt then id order", async () => {
      const fixture = await create();
      try {
        const run = await seed(
          fixture,
          "override-project",
          "override-task",
          "manifest-override",
        );
        await fixture.pipelines.insert(run);
        await fixture.pipelines.appendOverride({
          id: "override-b",
          projectId: "override-project",
          pipelineRunId: run.snapshot().id,
          stageRunId: run.snapshot().stages[0]!.id,
          actorId: "operator",
          reason: "Second",
          previousRule: "rule",
          resultingAuthorization: "stage_completed",
          createdAt: new Date(now.getTime() + 2),
        });
        await fixture.pipelines.appendOverride({
          id: "override-a",
          projectId: "override-project",
          pipelineRunId: run.snapshot().id,
          stageRunId: run.snapshot().stages[0]!.id,
          actorId: "operator",
          reason: "First",
          previousRule: "rule",
          resultingAuthorization: "stage_completed",
          createdAt: new Date(now.getTime() + 2),
        });
        await expect(
          fixture.pipelines.listOverrides(
            run.snapshot().id,
            "override-project",
          ),
        ).resolves.toMatchObject([{ id: "override-a" }, { id: "override-b" }]);
      } finally {
        await fixture.close();
      }
    });
  });
}

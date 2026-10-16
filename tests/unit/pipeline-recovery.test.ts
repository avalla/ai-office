import { describe, expect, test } from "vitest";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import {
  findSuspendedStageCandidates,
  RecoverSuspendedPipelines,
} from "@ai-office/application/pipeline/recover-suspended-pipelines.ts";
import { TaskPrerequisiteIncompleteError } from "@ai-office/application/commands/manage-task-dependencies.ts";
import type { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import {
  ConcurrentPipelineTransitionError,
  PipelineActorUnauthorizedError,
} from "@ai-office/application/pipeline-errors.ts";
import type { AgentRuntimeRepository } from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { PipelineRunRepository } from "@ai-office/application/ports/pipeline-run-repository.port.ts";
import type { TaskDependencyRepository } from "@ai-office/application/ports/task-dependency-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";

const now = new Date("2026-10-15T00:00:00.000Z");

const definition: OfficePipeline = {
  id: "delivery",
  name: "Delivery",
  description: "Two stages",
  defaultFor: ["feature"],
  enforcement: "enforced",
  stages: [
    {
      id: "build",
      name: "Build",
      roleId: "developer",
      objective: "Build",
      checks: [],
      requiresApproval: false,
      capabilities: [],
    },
    {
      id: "review",
      name: "Review",
      roleId: "reviewer",
      objective: "Review",
      checks: [],
      requiresApproval: false,
      capabilities: [],
    },
  ],
};

function pipelineRun(id: string, taskId = `task-${id}`): PipelineRun {
  return PipelineRun.create({
    id,
    projectId: "project",
    taskId,
    manifestRevisionId: "manifest-1",
    manifestRevision: 1,
    definition,
    startedBy: "operator",
    stageRunIds: [`${id}-stage-1`, `${id}-stage-2`],
    now,
  });
}

function completedRun(id: string, taskId: string, stageRunId: string): AgentRun {
  const run = AgentRun.create({
    id,
    projectId: "project",
    taskId,
    agentId: "agent-1",
    pipelineRunId: `pipeline-of-${stageRunId}`,
    pipelineStageRunId: stageRunId,
    now,
  });
  run.transition("preparing", now);
  run.transition("running", now);
  run.transition("completed", now);
  return run;
}

describe("findSuspendedStageCandidates", () => {
  test("detects the refused stage-completion artifact", () => {
    const run = pipelineRun("pipeline-1");
    const agentRun = completedRun("run-1", "task-pipeline-1", "pipeline-1-stage-1");
    expect(findSuspendedStageCandidates([run], [agentRun])).toEqual([
      {
        pipelineRunId: "pipeline-1",
        pipelineStageRunId: "pipeline-1-stage-1",
        agentRunId: "run-1",
        taskId: "task-pipeline-1",
      },
    ]);
  });

  test("ignores pipelines and stages that are not waiting on a completion write", () => {
    const active = pipelineRun("pipeline-1");
    const finished = pipelineRun("pipeline-2");
    finished.assign("agent-1", "developer", now);
    finished.completeStage("agent-1", now);
    finished.assign("agent-2", "reviewer", now);
    finished.completeStage("agent-2", now);
    expect(finished.snapshot().status).toBe("completed");
    const queuedBound = AgentRun.create({
      id: "run-queued",
      projectId: "project",
      taskId: "task-pipeline-1",
      agentId: "agent-1",
      pipelineRunId: "pipeline-1",
      pipelineStageRunId: "pipeline-1-stage-1",
      now,
    });
    const completedElsewhere = completedRun(
      "run-other",
      "task-pipeline-1",
      "pipeline-2-stage-1",
    );
    expect(
      findSuspendedStageCandidates(
        [active, finished],
        [queuedBound, completedElsewhere],
      ),
    ).toEqual([]);
  });

  test("orders candidates by pipeline run id for deterministic scans", () => {
    const first = pipelineRun("pipeline-a");
    const second = pipelineRun("pipeline-b");
    const runs = [second, first];
    const agentRuns = [
      completedRun("run-b", "task-pipeline-b", "pipeline-b-stage-1"),
      completedRun("run-a", "task-pipeline-a", "pipeline-a-stage-1"),
    ];
    expect(
      findSuspendedStageCandidates(runs, agentRuns).map(
        (candidate) => candidate.pipelineRunId,
      ),
    ).toEqual(["pipeline-a", "pipeline-b"]);
  });
});

type CompletionInput = Parameters<
  ManagePipelineRuns["completeStageFromAgentRun"]
>[0];

/**
 * One suspended candidate (active pipeline, active stage, completed bound
 * run, running task, no dependency edges) whose resume write fails with the
 * given error. The repositories are stubs over domain aggregates; only the
 * catch-branch mapping under test reaches the failing completion.
 */
function serviceWithFailingCompletion(failure: () => Error) {
  const run = pipelineRun("pipeline-1");
  const agentRun = completedRun(
    "run-1",
    "task-pipeline-1",
    "pipeline-1-stage-1",
  );
  const task = Task.create({
    id: "task-pipeline-1",
    projectId: "project",
    title: "Dependent",
    now,
  });
  task.start(now);
  const calls: CompletionInput[] = [];
  const service = new RecoverSuspendedPipelines(
    { listByProject: async () => [run] } as unknown as PipelineRunRepository,
    { listRuns: async () => [agentRun] } as unknown as AgentRuntimeRepository,
    { listByProject: async () => [task] } as unknown as TaskRepository,
    { listByProject: async () => [] } as unknown as TaskDependencyRepository,
    {
      completeStageFromAgentRun: async (input: CompletionInput) => {
        calls.push(input);
        throw failure();
      },
    },
  );
  return { service, run, calls };
}

describe("RecoverSuspendedPipelines refusal mappings", () => {
  test("maps a prerequisite refusal from the guarded write to awaiting_prerequisites", async () => {
    const { service, run, calls } = serviceWithFailingCompletion(
      () =>
        new TaskPrerequisiteIncompleteError(
          "task-pipeline-1",
          [{ taskId: "prereq", status: "waiting_review" }],
          "completion",
        ),
    );

    const result = await service.execute({ projectId: "project", trigger: "tick" });

    expect(result).toEqual({
      projectId: "project",
      trigger: "tick",
      recoveries: [
        {
          pipelineRunId: "pipeline-1",
          pipelineStageRunId: "pipeline-1-stage-1",
          agentRunId: "run-1",
          taskId: "task-pipeline-1",
          outcome: "awaiting_prerequisites",
        },
      ],
    });
    // The write was attempted once and the refusal changed nothing.
    expect(calls).toEqual([
      {
        projectId: "project",
        agentRunId: "run-1",
        expectedPipelineRunId: "pipeline-1",
        resumption: { trigger: "tick" },
      },
    ]);
    expect(run.snapshot().status).toBe("active");
  });

  test.each([
    ["ConcurrentPipelineTransitionError", () => new ConcurrentPipelineTransitionError("pipeline-1")],
    ["PipelineActorUnauthorizedError", () => new PipelineActorUnauthorizedError("stage completion")],
  ] as const)(
    "maps a lost-race %s to superseded",
    async (_name, failure) => {
      const { service, run, calls } = serviceWithFailingCompletion(failure);

      const result = await service.execute({
        projectId: "project",
        trigger: "task_completion",
        triggerTaskId: "prereq",
      });

      expect(result.recoveries).toEqual([
        expect.objectContaining({
          pipelineRunId: "pipeline-1",
          outcome: "superseded",
        }),
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.resumption).toEqual({
        trigger: "task_completion",
        triggerTaskId: "prereq",
      });
      expect(run.snapshot().status).toBe("active");
    },
  );

  test("propagates an error that is not a recognized refusal", async () => {
    const { service } = serviceWithFailingCompletion(
      () => new Error("disk full"),
    );

    await expect(
      service.execute({ projectId: "project", trigger: "tick" }),
    ).rejects.toThrowError("disk full");
  });
});

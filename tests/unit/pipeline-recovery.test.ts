import { describe, expect, test } from "vitest";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import { findSuspendedStageCandidates } from "@ai-office/application/pipeline/recover-suspended-pipelines.ts";

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

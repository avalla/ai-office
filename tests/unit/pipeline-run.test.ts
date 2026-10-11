import { describe, expect, test } from "vitest";
import {
  PipelineRun,
  PipelineTransitionError,
  type PipelineRunConfigurationPin,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";

const pipeline: OfficePipeline = {
  id: "delivery",
  name: "Delivery",
  description: "Enforced delivery",
  defaultFor: ["feature"],
  enforcement: "enforced",
  stages: [
    {
      id: "implementation",
      name: "Implementation",
      roleId: "developer",
      objective: "Implement",
      checks: ["Tests pass"],
      requiresApproval: false,
      capabilities: ["filesystem.read", "filesystem.write"],
    },
    {
      id: "review",
      name: "Review",
      roleId: "reviewer",
      objective: "Review",
      checks: ["Review approved"],
      requiresApproval: true,
      requiresIndependentApproval: true,
      capabilities: ["filesystem.read", "review.submit"],
      requiresDifferentAgentFrom: ["implementation"],
    },
  ],
};

function create(definition: OfficePipeline = pipeline): PipelineRun {
  return PipelineRun.create({
    id: "pipeline-run",
    projectId: "project",
    taskId: "task",
    manifestRevisionId: "manifest",
    manifestRevision: 1,
    definition,
    startedBy: "operator",
    stageRunIds: ["implementation-run", "review-run"],
    now: new Date("2026-08-28T00:00:00.000Z"),
  });
}

describe("pipeline run", () => {
  test("does not turn guidance-only definitions into runtime authority", () => {
    expect(() =>
      PipelineRun.create({
        id: "pipeline-run",
        projectId: "project",
        taskId: "task",
        manifestRevisionId: "manifest",
        manifestRevision: 1,
        definition: { ...pipeline, enforcement: "guidance" },
        startedBy: "operator",
        stageRunIds: ["implementation-run", "review-run"],
        now: new Date("2026-08-28T00:00:00.000Z"),
      }),
    ).toThrow("Only an enforced pipeline can be started");
  });

  test("creates an active pinned run and advances valid assigned stages", () => {
    const run = create();
    expect(run.snapshot()).toMatchObject({
      status: "active",
      currentStageIndex: 0,
      manifestRevision: 1,
      stages: [{ status: "active" }, { status: "pending" }],
    });

    run.assign(
      "developer-agent",
      "developer",
      new Date("2026-08-28T00:01:00Z"),
    );
    run.completeStage("developer-agent", new Date("2026-08-28T00:02:00Z"));
    expect(run.currentStage()).toMatchObject({
      stageId: "review",
      status: "active",
    });
  });

  test("rejects wrong roles, wrong completing agents, and self review", () => {
    const run = create();
    expect(() =>
      run.assign("agent", "reviewer", new Date("2026-08-28T00:01:00Z")),
    ).toThrow(PipelineTransitionError);
    run.assign("same-agent", "developer", new Date("2026-08-28T00:01:00Z"));
    expect(() =>
      run.completeStage("other-agent", new Date("2026-08-28T00:02:00Z")),
    ).toThrow("Only the assigned agent");
    run.completeStage("same-agent", new Date("2026-08-28T00:02:00Z"));
    expect(() =>
      run.assign("same-agent", "reviewer", new Date("2026-08-28T00:03:00Z")),
    ).toThrow("Agent separation is required");
  });

  test("requires runtime approval and prevents an assigned agent self-approving", () => {
    const run = create();
    run.assign(
      "developer-agent",
      "developer",
      new Date("2026-08-28T00:01:00Z"),
    );
    run.completeStage("developer-agent", new Date("2026-08-28T00:02:00Z"));
    run.assign("reviewer-agent", "reviewer", new Date("2026-08-28T00:03:00Z"));
    run.completeStage("reviewer-agent", new Date("2026-08-28T00:04:00Z"));
    expect(run.currentStage()?.status).toBe("awaiting_approval");
    expect(() =>
      run.approveStage(
        "reviewer-agent",
        undefined,
        new Date("2026-08-28T00:05:00Z"),
      ),
    ).toThrow("cannot approve its own stage");
    run.approveStage(
      "operator",
      "Independent review accepted",
      new Date("2026-08-28T00:05:00Z"),
    );
    expect(run.snapshot().status).toBe("completed");
  });

  test("does not impose independent approval when the pipeline omits the constraint", () => {
    const definition = structuredClone(pipeline);
    delete definition.stages[1]!.requiresIndependentApproval;
    const run = create(definition);
    run.assign(
      "developer-agent",
      "developer",
      new Date("2026-08-28T00:01:00Z"),
    );
    run.completeStage("developer-agent", new Date("2026-08-28T00:02:00Z"));
    run.assign("reviewer-agent", "reviewer", new Date("2026-08-28T00:03:00Z"));
    run.completeStage("reviewer-agent", new Date("2026-08-28T00:04:00Z"));
    run.approveStage(
      "reviewer-agent",
      undefined,
      new Date("2026-08-28T00:05:00Z"),
    );
    expect(run.snapshot().status).toBe("completed");
  });

  test("records a reasoned override and supports cancellation", () => {
    const run = create();
    const override = run.overrideCurrent({
      id: "override",
      actorId: "operator",
      reason: "Emergency restoration approved by incident commander",
      now: new Date("2026-08-28T00:01:00Z"),
    });
    expect(override).toMatchObject({
      actorId: "operator",
      previousRule: "pipeline_agent_not_assigned",
      resultingAuthorization: "stage_completed",
    });
    expect(run.currentStage()?.stageId).toBe("review");
    run.cancel("operator", new Date("2026-08-28T00:02:00Z"));
    expect(run.snapshot().status).toBe("cancelled");
  });

  test("persists an explicit rejected approval as a terminal workflow event", () => {
    const run = create();
    run.assign(
      "developer-agent",
      "developer",
      new Date("2026-08-28T00:01:00Z"),
    );
    run.completeStage("developer-agent", new Date("2026-08-28T00:02:00Z"));
    run.assign("reviewer-agent", "reviewer", new Date("2026-08-28T00:03:00Z"));
    run.completeStage("reviewer-agent", new Date("2026-08-28T00:04:00Z"));
    run.rejectStage(
      "operator",
      "Blocking findings remain",
      new Date("2026-08-28T00:05:00Z"),
    );
    expect(run.snapshot()).toMatchObject({
      status: "cancelled",
      stages: expect.arrayContaining([
        expect.objectContaining({ approvalDecision: "rejected" }),
      ]),
    });
  });

  test("pins nothing by default, matching every run before M16.5's first slice", () => {
    expect(create().snapshot().configurationPin).toBeUndefined();
  });

  test("pins and round-trips a pack configuration identity alongside the legacy manifest pin", () => {
    const pin: PipelineRunConfigurationPin = {
      configurationDigest: `sha256:${"a".repeat(64)}`,
      coreContractVersion: 1,
      bindingRevision: 2,
      definitionRevision: 3,
      selectedPacks: [
        { id: "org.ai-office.legal", version: "0.2.0", manifestDigest: `sha256:${"b".repeat(64)}` },
      ],
      resolvedPacks: [
        { id: "org.ai-office.legal", version: "0.2.0", manifestDigest: `sha256:${"b".repeat(64)}` },
      ],
    };
    const run = PipelineRun.create({
      id: "pipeline-run",
      projectId: "project",
      taskId: "task",
      manifestRevisionId: "manifest",
      manifestRevision: 1,
      definition: pipeline,
      startedBy: "operator",
      stageRunIds: ["implementation-run", "review-run"],
      configurationPin: pin,
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    expect(run.snapshot().configurationPin).toEqual(pin);
    // The pin is pass-through evidence, not domain state: nothing about
    // pipeline selection or transitions reads or changes because of it.
    run.assign(
      "developer-agent",
      "developer",
      new Date("2026-08-28T00:01:00Z"),
    );
    expect(run.snapshot().configurationPin).toEqual(pin);
    const restored = PipelineRun.restore(run.snapshot());
    expect(restored.snapshot().configurationPin).toEqual(pin);
  });

  test("rejects an empty configuration digest", () => {
    const pin: PipelineRunConfigurationPin = {
      configurationDigest: "   ",
      coreContractVersion: 1,
      bindingRevision: 0,
      definitionRevision: 0,
      selectedPacks: [],
      resolvedPacks: [],
    };
    expect(() =>
      PipelineRun.create({
        id: "pipeline-run",
        projectId: "project",
        taskId: "task",
        manifestRevisionId: "manifest",
        manifestRevision: 1,
        definition: pipeline,
        startedBy: "operator",
        stageRunIds: ["implementation-run", "review-run"],
        configurationPin: pin,
        now: new Date("2026-08-28T00:00:00.000Z"),
      }),
    ).toThrow("Configuration digest");
  });
});

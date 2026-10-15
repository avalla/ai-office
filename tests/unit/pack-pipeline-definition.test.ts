import { describe, expect, test } from "vitest";
import {
  findPackWorkflow,
  localDefinitionId,
  packWorkflowPipeline,
} from "@ai-office/application/pipeline/pack-pipeline-definition.ts";
import type {
  ResolvedPolicy,
  ResolvedProjectConfiguration,
  ResolvedWorkflow,
} from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { PackPipelineUnsupportedError } from "@ai-office/application/pipeline-errors.ts";

const workflow = (
  localId: string,
  overrides: Partial<ResolvedWorkflow> = {},
): ResolvedWorkflow => ({
  workflowId: `pack:org.example/workflows/${localId}`,
  effectiveId: `pack:org.example@1.0.0#sha256:x/workflows/${localId}`,
  origin: "pack_owned",
  taskTypeId: "pack:org.example/taskTypes/case",
  stages: [
    { id: "open", roleId: "pack:org.example/roles/clerk" },
    {
      id: "close",
      roleId: "project:roles/lead",
      title: "Close",
      objective: "Close it",
      checks: ["signed"],
    },
  ],
  customization: "none",
  ...overrides,
});

const policy = (
  workflowId: string,
  overrides: Partial<ResolvedPolicy> = {},
): ResolvedPolicy => ({
  policyId: "pack:org.example/policies/p",
  effectiveId: "pack:org.example@1.0.0#sha256:x/policies/p",
  origin: "pack_owned",
  workflowId,
  state: "active",
  enforcement: "enforced",
  stages: [
    {
      stage: "close",
      requiresApproval: true,
      requiresIndependentApproval: true,
      requiresDifferentAgentFrom: ["open"],
      operations: ["case.close"],
    },
  ],
  ...overrides,
});

const configuration = (
  workflows: ResolvedWorkflow[],
  policies: ResolvedPolicy[] = [],
): ResolvedProjectConfiguration =>
  ({ workflows, policies }) as unknown as ResolvedProjectConfiguration;

describe("packWorkflowPipeline", () => {
  test("takes the local ID after the last slash", () => {
    expect(localDefinitionId("pack:org.example/workflows/case-flow")).toBe(
      "case-flow",
    );
    expect(localDefinitionId("project:roles/lead")).toBe("lead");
  });

  test("maps stages and takes every guard only from the active policy", () => {
    const w = workflow("case-flow", {
      additionalTaskTypeIds: ["pack:org.example/taskTypes/appeal"],
      title: "Case flow",
      description: "A case",
    });
    const pipeline = packWorkflowPipeline(
      configuration([w], [policy(w.workflowId)]),
      w,
    );
    expect(pipeline).toEqual({
      id: "case-flow",
      name: "Case flow",
      description: "A case",
      defaultFor: ["case", "appeal"],
      enforcement: "enforced",
      stages: [
        {
          id: "open",
          name: "open",
          roleId: "clerk",
          objective: "",
          checks: [],
          requiresApproval: false,
          requiresIndependentApproval: false,
          capabilities: [],
          requiresDifferentAgentFrom: [],
        },
        {
          id: "close",
          name: "Close",
          roleId: "lead",
          objective: "Close it",
          checks: ["signed"],
          requiresApproval: true,
          requiresIndependentApproval: true,
          capabilities: ["case.close"],
          requiresDifferentAgentFrom: ["open"],
        },
      ],
    });
  });

  test("a workflow with no active policy is guidance, never enforced", () => {
    const w = workflow("case-flow");
    expect(packWorkflowPipeline(configuration([w]), w).enforcement).toBe(
      "guidance",
    );
    expect(
      packWorkflowPipeline(
        configuration([w], [policy(w.workflowId, { state: "inert" })]),
        w,
      ).enforcement,
    ).toBe("guidance");
  });

  test("two active policies on one workflow are refused, not merged", () => {
    const w = workflow("case-flow");
    expect(() =>
      packWorkflowPipeline(
        configuration(
          [w],
          [policy(w.workflowId), policy(w.workflowId, { policyId: "other" })],
        ),
        w,
      ),
    ).toThrow(PackPipelineUnsupportedError);
  });

  test("two workflows sharing a local ID are refused, not chosen between", () => {
    const first = workflow("case-flow");
    const second = workflow("case-flow", {
      workflowId: "project:workflows/case-flow",
      origin: "project_owned",
    });
    expect(() =>
      findPackWorkflow(configuration([first, second]), "case-flow"),
    ).toThrow(PackPipelineUnsupportedError);
    expect(findPackWorkflow(configuration([first]), "missing")).toBeUndefined();
  });
});

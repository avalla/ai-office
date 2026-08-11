import { describe, expect, test } from "vitest";
import { assertApprovalBinding } from "@ai-office/application/capability/action-approval-binding.ts";
import {
  hashActionSimulationArtifact,
  sha256Text,
} from "@ai-office/application/capability/action-simulation-hash.ts";
import { InvalidActionApprovalStateError } from "@ai-office/application/capability-errors.ts";
import { ActionApproval } from "@ai-office/domain/capability/action-approval.ts";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import { ActionSimulation } from "@ai-office/domain/capability/action-simulation.ts";

const now = new Date("2026-08-11T00:00:00.000Z");

function binding() {
  const request = ActionRequest.create({
    id: "action-1",
    projectId: "project-1",
    agentId: "agent-1",
    resourceId: "resource-1",
    connector: "filesystem",
    connectorVersion: "2",
    operation: "filesystem.create",
    normalizedArguments: { path: "src/new.ts", content: "new\n" },
    effectiveConstraints: { allowMutation: true },
    payloadHash: "a".repeat(64),
    decision: "allow_with_approval",
    riskLevel: "medium",
    matchedGrantIds: ["grant-1"],
    reasons: ["approval is required"],
    now,
  });
  const preconditions = [{ kind: "absent" as const, path: "src/new.ts" }];
  const diff = "--- /dev/null\n+++ b/src/new.ts\n";
  const diffSha256 = sha256Text(diff);
  const artifactSha256 = hashActionSimulationArtifact({
    schemaVersion: 1,
    actionRequestId: "action-1",
    authorizationPayloadHash: "a".repeat(64),
    connector: "filesystem",
    connectorVersion: "2",
    operation: "filesystem.create",
    preconditions,
    diffSha256,
  });
  const simulation = ActionSimulation.create({
    id: "simulation-1",
    projectId: "project-1",
    actionRequestId: "action-1",
    authorizationPayloadHash: "a".repeat(64),
    connector: "filesystem",
    connectorVersion: "2",
    operation: "filesystem.create",
    preconditions,
    diff,
    diffSha256,
    artifactSha256,
    createdAt: now,
  });
  return { request, simulation, artifactSha256 };
}

function approval(override: { actionPayloadHash?: string; artifactHash?: string } = {}) {
  const { artifactSha256 } = binding();
  return ActionApproval.request({
    id: "approval-1",
    projectId: "project-1",
    actionRequestId: "action-1",
    simulationId: "simulation-1",
    actionPayloadHash: override.actionPayloadHash ?? "a".repeat(64),
    simulationArtifactHash: override.artifactHash ?? artifactSha256,
    connector: "filesystem",
    connectorVersion: "2",
    operation: "filesystem.create",
    now,
  });
}

describe("action approval exact binding", () => {
  test("accepts the exact action payload and simulation artifact hashes", () => {
    const { request, simulation } = binding();
    expect(() => assertApprovalBinding(request, simulation, approval())).not.toThrow();
  });

  test("rejects an action payload hash mismatch", () => {
    const { request, simulation } = binding();
    expect(() =>
      assertApprovalBinding(
        request,
        simulation,
        approval({ actionPayloadHash: "c".repeat(64) }),
      ),
    ).toThrow(InvalidActionApprovalStateError);
  });

  test("rejects a simulation artifact hash mismatch", () => {
    const { request, simulation } = binding();
    expect(() =>
      assertApprovalBinding(
        request,
        simulation,
        approval({ artifactHash: "d".repeat(64) }),
      ),
    ).toThrow(InvalidActionApprovalStateError);
  });
});

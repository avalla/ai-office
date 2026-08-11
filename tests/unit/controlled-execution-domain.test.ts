import { describe, expect, test } from "vitest";
import { ActionApproval } from "@ai-office/domain/capability/action-approval.ts";
import { ActionExecution } from "@ai-office/domain/capability/action-execution.ts";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import { CapabilityValidationError, InvalidActionTransitionError } from "@ai-office/domain/capability/errors.ts";

const now = new Date("2026-08-11T00:00:00.000Z");
const later = new Date("2026-08-11T00:00:01.000Z");

function request() {
  const value = ActionRequest.create({
    id: "action-1",
    projectId: "project-1",
    agentId: "agent-1",
    resourceId: "resource-1",
    connector: "filesystem",
    connectorVersion: "2",
    operation: "filesystem.write",
    normalizedArguments: { path: "src/index.ts", content: "next\n" },
    effectiveConstraints: { allowMutation: true },
    payloadHash: "a".repeat(64),
    decision: "allow_with_approval",
    riskLevel: "medium",
    matchedGrantIds: ["grant-1"],
    reasons: ["approval is required"],
    now,
  });
  value.transition("authorized", now);
  value.transition("simulating", now, "mutation", true);
  value.transition("simulated", now, "mutation", true);
  value.transition("approval_pending", now, "mutation", true);
  return value;
}

describe("M6C-lite controlled execution domain", () => {
  test("approval is a separate one-way aggregate with an audit actor", () => {
    const approval = ActionApproval.request({
      id: "approval-1",
      projectId: "project-1",
      actionRequestId: "action-1",
      simulationId: "simulation-1",
      actionPayloadHash: "a".repeat(64),
      simulationArtifactHash: "b".repeat(64),
      connector: "filesystem",
      connectorVersion: "2",
      operation: "filesystem.write",
      now,
    });
    expect(approval.snapshot().status).toBe("pending");
    expect("actor" in approval.snapshot()).toBe(false);
    approval.approve("local-user", later);
    expect(approval.snapshot()).toMatchObject({ status: "approved", actor: "local-user" });
    expect(() => approval.reject("other", later)).toThrow(CapabilityValidationError);
  });

  test("approval rejects binding hashes and non-monotonic decisions", () => {
    expect(() =>
      ActionApproval.request({
        id: "approval-1",
        projectId: "project-1",
        actionRequestId: "action-1",
        simulationId: "simulation-1",
        actionPayloadHash: "not-a-hash",
        simulationArtifactHash: "b".repeat(64),
        connector: "filesystem",
        connectorVersion: "2",
        operation: "filesystem.write",
        now,
      }),
    ).toThrow(CapabilityValidationError);
    const approval = ActionApproval.request({
      id: "approval-1",
      projectId: "project-1",
      actionRequestId: "action-1",
      simulationId: "simulation-1",
      actionPayloadHash: "a".repeat(64),
      simulationArtifactHash: "b".repeat(64),
      connector: "filesystem",
      connectorVersion: "2",
      operation: "filesystem.write",
      now: later,
    });
    expect(() => approval.approve("local-user", now)).toThrow(
      CapabilityValidationError,
    );
  });

  test("approval_pending acquires only an approved mutation execution lease", () => {
    const value = request();
    expect(() => value.transition("executing", later, "read", false)).toThrow(
      InvalidActionTransitionError,
    );
    value.transition("executing", later, "mutation", true);
    value.transition("execution_unknown", later, "mutation", true);
    expect(value.snapshot().status).toBe("execution_unknown");
    expect(() => value.transition("executing", later, "mutation", true)).toThrow(
      InvalidActionTransitionError,
    );
  });

  test("rejected action is terminal without an action-level approved state", () => {
    const value = request();
    value.transition("rejected", later, "mutation", true);
    expect(value.snapshot().status).toBe("rejected");
    expect(() => value.transition("executing", later, "mutation", true)).toThrow(
      InvalidActionTransitionError,
    );
  });

  test("execution ledger is one-way and distinguishes failed from unknown", () => {
    const failed = ActionExecution.start({
      id: "execution-1",
      projectId: "project-1",
      actionRequestId: "action-1",
      simulationId: "simulation-1",
      approvalId: "approval-1",
      now,
    });
    failed.fail(later, "SourcePreconditionFailedError");
    expect(failed.snapshot()).toMatchObject({
      status: "failed",
      failureCode: "SourcePreconditionFailedError",
    });
    expect(() => failed.complete(later)).toThrow(CapabilityValidationError);

    const unknown = ActionExecution.start({
      id: "execution-2",
      projectId: "project-1",
      actionRequestId: "action-2",
      simulationId: "simulation-2",
      approvalId: "approval-2",
      now,
    });
    unknown.markUnknown(later, "ParentFsyncFailed");
    expect(unknown.snapshot().status).toBe("execution_unknown");
  });
});

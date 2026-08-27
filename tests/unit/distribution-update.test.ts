import { describe, expect, test } from "vitest";
import {
  DistributionUpdateApprovalError,
  ManageDistributionUpdate,
} from "@ai-office/application/runtime/manage-distribution-update.ts";
import type {
  DistributionUpdateAdapter,
  DistributionUpdateDraft,
} from "@ai-office/application/ports/distribution-update-adapter.port.ts";

function draft(
  overrides: Partial<DistributionUpdateDraft> = {},
): DistributionUpdateDraft {
  return {
    contractVersion: 1,
    distributionRoot: "/distribution",
    packageName: "ai-office",
    branch: "main",
    remote: "origin",
    remoteIdentity: `sha256:${"1".repeat(64)}`,
    upstreamRef: "refs/heads/main",
    trackingRef: "refs/remotes/origin/main",
    currentRevision: "a".repeat(40),
    targetRevision: "b".repeat(40),
    steps: ["fetch", "fast_forward", "install_dependencies", "register_link"],
    ...overrides,
  };
}

describe("distribution update orchestration", () => {
  test("produces an exact plan without mutating the distribution", async () => {
    let applies = 0;
    const adapter: DistributionUpdateAdapter = {
      plan: async () => draft(),
      apply: async (value) => {
        applies += 1;
        return {
          contractVersion: 1,
          status: "updated",
          distributionRoot: value.distributionRoot,
          fromRevision: value.currentRevision,
          toRevision: value.targetRevision,
          completedSteps: value.steps,
          message: "updated",
        };
      },
    };
    const service = new ManageDistributionUpdate(adapter);

    const first = await service.plan("/distribution");
    const second = await service.plan("/distribution");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      contractVersion: 1,
      updateAvailable: true,
      upstream: {
        remote: "origin",
        identity: `sha256:${"1".repeat(64)}`,
        sourceRef: "refs/heads/main",
        trackingRef: "refs/remotes/origin/main",
      },
      preserves: ["runtime_state", "global_memory", "project_bindings"],
    });
    expect(applies).toBe(0);
  });

  test("rejects approval when the inspected revision changes", async () => {
    let current = draft();
    const adapter: DistributionUpdateAdapter = {
      plan: async () => current,
      apply: async () => {
        throw new Error("must not apply");
      },
    };
    const service = new ManageDistributionUpdate(adapter);
    const plan = await service.plan("/distribution");
    current = draft({ currentRevision: "c".repeat(40) });

    await expect(
      service.apply({
        distributionRoot: "/distribution",
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(DistributionUpdateApprovalError);
  });

  test("binds the credential-safe upstream identity into approval", async () => {
    let current = draft();
    const adapter: DistributionUpdateAdapter = {
      plan: async () => current,
      apply: async () => {
        throw new Error("must not apply");
      },
    };
    const service = new ManageDistributionUpdate(adapter);
    const plan = await service.plan("/distribution");
    current = draft({ remoteIdentity: `sha256:${"2".repeat(64)}` });

    await expect(
      service.apply({
        distributionRoot: "/distribution",
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(DistributionUpdateApprovalError);
  });

  test("treats an approved current revision as an idempotent no-op", async () => {
    let applies = 0;
    const current = "a".repeat(40);
    const adapter: DistributionUpdateAdapter = {
      plan: async () => draft({ targetRevision: current }),
      apply: async () => {
        applies += 1;
        throw new Error("must not apply");
      },
    };
    const service = new ManageDistributionUpdate(adapter);
    const plan = await service.plan("/distribution");

    expect(
      await service.apply({
        distributionRoot: "/distribution",
        approvedPlanHash: plan.planHash,
      }),
    ).toMatchObject({
      status: "already_current",
      completedSteps: [],
    });
    expect(applies).toBe(0);
  });
});

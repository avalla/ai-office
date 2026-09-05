import { DistributionUpdatePreconditionError } from "../ports/distribution-update-adapter.port.ts";
import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type {
  DistributionUpdateAdapter,
  DistributionUpdateRuntimeGuard,
  DistributionUpdateDraft,
  DistributionUpdateResult,
  DistributionUpdateStep,
} from "../ports/distribution-update-adapter.port.ts";

export class DistributionUpdateApprovalError extends Error {
  constructor() {
    super("AI Office update approval does not match the current plan");
    this.name = "DistributionUpdateApprovalError";
  }
}

export interface DistributionUpdatePlan {
  contractVersion: 1;
  distributionRoot: string;
  packageName: "ai-office";
  branch: string;
  upstream: {
    remote: string;
    identity: string;
    sourceRef: string;
    trackingRef: string;
  };
  currentRevision: string;
  targetRevision: string;
  updateAvailable: boolean;
  planHash: string;
  steps: readonly DistributionUpdateStep[];
  preserves: readonly ["runtime_state", "global_memory", "project_bindings"];
}

function hashDraft(draft: DistributionUpdateDraft): string {
  return createHash("sha256")
    .update(canonicalStringify(draft), "utf8")
    .digest("hex");
}

function publicPlan(draft: DistributionUpdateDraft): DistributionUpdatePlan {
  return {
    contractVersion: 1,
    distributionRoot: draft.distributionRoot,
    packageName: draft.packageName,
    branch: draft.branch,
    upstream: {
      remote: draft.remote,
      identity: draft.remoteIdentity,
      sourceRef: draft.upstreamRef,
      trackingRef: draft.trackingRef,
    },
    currentRevision: draft.currentRevision,
    targetRevision: draft.targetRevision,
    updateAvailable: draft.currentRevision !== draft.targetRevision,
    planHash: hashDraft(draft),
    steps: draft.steps,
    preserves: ["runtime_state", "global_memory", "project_bindings"],
  };
}

export class ManageDistributionUpdate {
  constructor(
    private readonly adapter: DistributionUpdateAdapter,
    private readonly runtimeGuard: DistributionUpdateRuntimeGuard,
  ) {}

  async plan(distributionRoot: string): Promise<DistributionUpdatePlan> {
    await this.runtimeGuard.assertStopped(distributionRoot);
    return publicPlan(await this.adapter.plan(distributionRoot));
  }

  async apply(input: {
    distributionRoot: string;
    approvedPlanHash: string;
  }): Promise<DistributionUpdateResult> {
    await this.runtimeGuard.assertStopped(input.distributionRoot);
    let draft: DistributionUpdateDraft;
    try {
      draft = await this.adapter.plan(input.distributionRoot);
    } catch (error) {
      if (error instanceof DistributionUpdatePreconditionError)
        throw new DistributionUpdateApprovalError();
      throw error;
    }
    if (hashDraft(draft) !== input.approvedPlanHash)
      throw new DistributionUpdateApprovalError();
    if (draft.currentRevision === draft.targetRevision)
      return {
        contractVersion: 1,
        status: "already_current",
        distributionRoot: draft.distributionRoot,
        fromRevision: draft.currentRevision,
        toRevision: draft.currentRevision,
        completedSteps: [],
        message: "AI Office is already current",
      };
    await this.runtimeGuard.assertStopped(input.distributionRoot);
    return this.adapter.apply(draft);
  }
}

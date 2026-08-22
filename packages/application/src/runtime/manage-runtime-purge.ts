import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type {
  RuntimePurgeAdapter,
  RuntimePurgeArtifact,
  RuntimePurgeDraft,
  RuntimePurgeResult,
} from "../ports/runtime-purge-adapter.port.ts";

export class RuntimePurgeApprovalError extends Error {
  constructor() {
    super("Runtime purge approval does not match the current plan");
    this.name = "RuntimePurgeApprovalError";
  }
}

export interface RuntimePurgePlan {
  contractVersion: 1;
  runtimeRoot: string;
  stateDirectory: string;
  stateDirectoryExists: boolean;
  planHash: string;
  artifacts: ReadonlyArray<Omit<RuntimePurgeArtifact, "fingerprint">>;
  preservedPaths: readonly string[];
}

function hashDraft(draft: RuntimePurgeDraft): string {
  return createHash("sha256")
    .update(canonicalStringify(draft), "utf8")
    .digest("hex");
}

export class ManageRuntimePurge {
  constructor(private readonly adapter: RuntimePurgeAdapter) {}

  async plan(runtimeRoot: string): Promise<RuntimePurgePlan> {
    const draft = await this.adapter.plan(runtimeRoot);
    return {
      contractVersion: 1,
      runtimeRoot: draft.runtimeRoot,
      stateDirectory: draft.stateDirectory,
      stateDirectoryExists: draft.stateDirectoryFingerprint !== null,
      planHash: hashDraft(draft),
      artifacts: draft.artifacts.map(
        ({ fingerprint: _, ...artifact }) => artifact,
      ),
      preservedPaths: draft.preservedPaths,
    };
  }

  async apply(input: {
    runtimeRoot: string;
    approvedPlanHash: string;
  }): Promise<RuntimePurgeResult> {
    const draft = await this.adapter.plan(input.runtimeRoot);
    if (hashDraft(draft) !== input.approvedPlanHash)
      throw new RuntimePurgeApprovalError();
    return this.adapter.apply(draft);
  }
}

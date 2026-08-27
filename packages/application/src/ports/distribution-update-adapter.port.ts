export type DistributionUpdateStep =
  "fetch" | "fast_forward" | "install_dependencies" | "register_link";

export interface DistributionUpdateDraft {
  contractVersion: 1;
  distributionRoot: string;
  packageName: "ai-office";
  branch: string;
  remote: string;
  remoteIdentity: string;
  upstreamRef: string;
  trackingRef: string;
  currentRevision: string;
  targetRevision: string;
  steps: readonly DistributionUpdateStep[];
}

export type DistributionUpdateResultStatus =
  "updated" | "already_current" | "failed" | "partial";

export interface DistributionUpdateResult {
  contractVersion: 1;
  status: DistributionUpdateResultStatus;
  distributionRoot: string;
  fromRevision: string;
  toRevision: string;
  completedSteps: readonly DistributionUpdateStep[];
  failedStep?: DistributionUpdateStep;
  message: string;
}

export interface DistributionUpdateAdapter {
  plan(distributionRoot: string): Promise<DistributionUpdateDraft>;
  apply(draft: DistributionUpdateDraft): Promise<DistributionUpdateResult>;
}

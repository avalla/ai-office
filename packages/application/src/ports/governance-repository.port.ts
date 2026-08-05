import type {
  ApprovalRecord,
  AdrRecord,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
} from "@ai-office/domain/governance/governance.ts";

export interface GovernanceSnapshot {
  milestones: MilestoneRecord[];
  requirements: RequirementRecord[];
  adrs: AdrRecord[];
  reviews: ReviewRecord[];
  approvals: ApprovalRecord[];
}
export interface GovernanceRepository {
  saveMilestone(value: MilestoneRecord): Promise<void>;
  saveRequirement(value: RequirementRecord): Promise<void>;
  saveAdr(value: AdrRecord): Promise<void>;
  saveReview(value: ReviewRecord): Promise<void>;
  saveApproval(value: ApprovalRecord): Promise<void>;
  findStatus(
    kind: "milestone" | "requirement" | "adr",
    id: string,
    projectId: string,
  ): Promise<string | null>;
  findReview(id: string, projectId: string): Promise<ReviewRecord | null>;
  updateStatus(
    kind: "milestone" | "requirement" | "adr",
    id: string,
    projectId: string,
    status: string,
    now: Date,
  ): Promise<boolean>;
  getSnapshot(projectId: string): Promise<GovernanceSnapshot>;
}

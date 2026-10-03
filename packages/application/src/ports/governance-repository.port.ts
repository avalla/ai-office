import type {
  ApprovalRecord,
  AdrRecord,
  GovernanceStatusByKind,
  GovernanceKind,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
  ReviewSubjectType,
} from "@ai-office/domain/governance/governance.ts";

export interface GovernanceSnapshot {
  milestones: MilestoneRecord[];
  requirements: RequirementRecord[];
  adrs: AdrRecord[];
  reviews: ReviewRecord[];
  approvals: ApprovalRecord[];
}

export interface GovernanceEventRecord {
  id: string;
  projectId: string;
  eventType:
    | "milestone.created"
    | "milestone.title_changed"
    | "milestone.description_changed"
    | "milestone.status_changed"
    | "requirement.created"
    | "requirement.updated"
    | "requirement.status_changed"
    | "adr.created"
    | "adr.status_changed"
    | "review.created"
    | "review.decided";
  aggregateId: string;
  metadata: Record<string, string>;
  occurredAt: Date;
}

export interface RequirementText {
  title: string;
  description: string;
}

export type ReviewDecisionResult =
  "decided" | "not_found" | "already_finalized";

export interface GovernanceRepository {
  saveMilestone(value: MilestoneRecord): Promise<void>;
  updateMilestoneTitle(
    id: string,
    projectId: string,
    expectedTitle: string,
    title: string,
    now: Date,
    eventId: string,
  ): Promise<boolean>;
  updateMilestoneDescription(
    id: string,
    projectId: string,
    expectedDescription: string | undefined,
    description: string,
    now: Date,
    eventId: string,
  ): Promise<boolean>;
  saveRequirement(value: RequirementRecord): Promise<void>;
  /**
   * Replaces the descriptive text of a proposed requirement and appends one
   * audit event in the same transaction. Returns false when the stored text
   * or status no longer matches `expected`.
   */
  updateRequirementText(
    id: string,
    projectId: string,
    expected: RequirementText,
    next: RequirementText,
    now: Date,
    event: { id: string; metadata: Record<string, string> },
  ): Promise<boolean>;
  saveAdr(value: AdrRecord): Promise<void>;
  saveReview(value: ReviewRecord): Promise<void>;
  findMilestoneProject(id: string): Promise<string | null>;
  findSubjectProject(
    type: ReviewSubjectType,
    id: string,
  ): Promise<string | null>;
  findStatus<K extends GovernanceKind>(
    kind: K,
    id: string,
    projectId: string,
  ): Promise<GovernanceStatusByKind[K] | null>;
  findReview(id: string, projectId: string): Promise<ReviewRecord | null>;
  updateStatus<K extends GovernanceKind>(
    kind: K,
    id: string,
    projectId: string,
    expectedStatus: GovernanceStatusByKind[K],
    status: GovernanceStatusByKind[K],
    now: Date,
  ): Promise<boolean>;
  decideReview(value: ApprovalRecord): Promise<ReviewDecisionResult>;
  getSnapshot(projectId: string): Promise<GovernanceSnapshot>;
  listEvents(projectId: string): Promise<GovernanceEventRecord[]>;
}

export type MilestoneStatus =
  "planned" | "active" | "completed" | "cancelled" | "archived";
export type RequirementStatus =
  "proposed" | "accepted" | "implemented" | "verified" | "rejected";
export type AdrStatus =
  "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type ReviewSubjectType =
  "task" | "agent_run" | "requirement" | "adr" | "milestone";

export interface GovernanceActor {
  type: "user" | "agent" | "system";
  id: string;
  displayName?: string;
}

export interface MilestoneRecord {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  createdAt: Date;
  updatedAt: Date;
}
export interface RequirementRecord {
  id: string;
  projectId: string;
  milestoneId?: string;
  key: string;
  title: string;
  description: string;
  status: RequirementStatus;
  createdAt: Date;
  updatedAt: Date;
}
export interface AdrRecord {
  id: string;
  projectId: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: AdrStatus;
  supersededById?: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface ReviewRecord {
  id: string;
  projectId: string;
  subjectType: ReviewSubjectType;
  subjectId: string;
  reviewer: GovernanceActor;
  status: ReviewStatus;
  summary?: string;
  createdAt: Date;
  completedAt?: Date;
}
export interface ApprovalRecord {
  id: string;
  projectId: string;
  reviewId: string;
  decision: "approved" | "rejected";
  actor: GovernanceActor;
  rationale?: string;
  createdAt: Date;
}

const governanceTransitions = {
  milestone: {
    planned: ["active", "cancelled"],
    active: ["completed", "cancelled"],
    completed: ["archived"],
    cancelled: [],
    archived: [],
  },
  requirement: {
    proposed: ["accepted", "rejected"],
    accepted: ["implemented", "rejected"],
    implemented: ["verified"],
    verified: [],
    rejected: [],
  },
  adr: {
    proposed: ["accepted", "rejected"],
    accepted: ["deprecated", "superseded"],
    rejected: [],
    deprecated: [],
    superseded: [],
  },
} as const;

export type GovernanceKind = keyof typeof governanceTransitions;

export interface GovernanceStatusByKind {
  milestone: MilestoneStatus;
  requirement: RequirementStatus;
  adr: AdrStatus;
}

// A requirement's wording is still under negotiation only while it is
// proposed; once accepted it is the baseline later work is judged against.
export function isRequirementEditable(status: RequirementStatus): boolean {
  return status === "proposed";
}

export function isGovernanceTransitionAllowed<K extends GovernanceKind>(
  kind: K,
  from: GovernanceStatusByKind[K],
  to: GovernanceStatusByKind[K],
): boolean {
  const transitions = governanceTransitions[kind] as Record<
    string,
    readonly string[]
  >;
  return transitions[from]?.includes(to) === true;
}

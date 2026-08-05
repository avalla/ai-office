export type MilestoneStatus = "planned" | "active" | "completed" | "cancelled";
export type RequirementStatus =
  "proposed" | "accepted" | "implemented" | "verified" | "rejected";
export type ReviewStatus = "pending" | "approved" | "changes_requested";

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
  status: "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";
  supersededById?: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface ReviewRecord {
  id: string;
  projectId: string;
  subjectType: "task" | "agent_run" | "requirement" | "adr" | "milestone";
  subjectId: string;
  reviewer: string;
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
  actor: string;
  rationale?: string;
  createdAt: Date;
}

const governanceTransitions = {
  milestone: {
    planned: ["active", "cancelled"],
    active: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
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

export function isGovernanceTransitionAllowed(
  kind: GovernanceKind,
  from: string,
  to: string,
): boolean {
  const transitions = governanceTransitions[kind] as Record<
    string,
    readonly string[]
  >;
  return transitions[from]?.includes(to) === true;
}

import type { Database } from "bun:sqlite";
import type {
  GovernanceRepository,
  GovernanceSnapshot,
} from "@ai-office/application/ports/governance-repository.port.ts";
import type {
  ApprovalRecord,
  AdrRecord,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
} from "@ai-office/domain/governance/governance.ts";

export class SqliteGovernanceRepository implements GovernanceRepository {
  constructor(private readonly database: Database) {}
  async saveMilestone(v: MilestoneRecord): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO milestone(id,project_id,title,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        v.id,
        v.projectId,
        v.title,
        v.description ?? null,
        v.status,
        v.createdAt.toISOString(),
        v.updatedAt.toISOString(),
      );
  }
  async saveRequirement(v: RequirementRecord): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO requirement(id,project_id,milestone_id,requirement_key,title,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        v.id,
        v.projectId,
        v.milestoneId ?? null,
        v.key,
        v.title,
        v.description,
        v.status,
        v.createdAt.toISOString(),
        v.updatedAt.toISOString(),
      );
  }
  async saveAdr(v: AdrRecord): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO architecture_decision(id,project_id,title,context,decision,consequences,status,superseded_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        v.id,
        v.projectId,
        v.title,
        v.context,
        v.decision,
        v.consequences,
        v.status,
        v.supersededById ?? null,
        v.createdAt.toISOString(),
        v.updatedAt.toISOString(),
      );
  }
  async saveReview(v: ReviewRecord): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO review(id,project_id,subject_type,subject_id,reviewer,status,summary,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        v.id,
        v.projectId,
        v.subjectType,
        v.subjectId,
        v.reviewer,
        v.status,
        v.summary ?? null,
        v.createdAt.toISOString(),
        v.completedAt?.toISOString() ?? null,
      );
  }
  async saveApproval(v: ApprovalRecord): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          "INSERT INTO approval(id,project_id,review_id,decision,actor,rationale,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          v.id,
          v.projectId,
          v.reviewId,
          v.decision,
          v.actor,
          v.rationale ?? null,
          v.createdAt.toISOString(),
        );
      this.database
        .prepare(
          "UPDATE review SET status=?, completed_at=? WHERE id=? AND project_id=?",
        )
        .run(
          v.decision === "approved" ? "approved" : "changes_requested",
          v.createdAt.toISOString(),
          v.reviewId,
          v.projectId,
        );
    })();
  }
  async findStatus(
    kind: "milestone" | "requirement" | "adr",
    id: string,
    projectId: string,
  ): Promise<string | null> {
    const table = kind === "adr" ? "architecture_decision" : kind;
    return (
      this.database
        .query<{ status: string }, [string, string]>(
          `SELECT status FROM ${table} WHERE id=? AND project_id=?`,
        )
        .get(id, projectId)?.status ?? null
    );
  }
  async findReview(
    id: string,
    projectId: string,
  ): Promise<ReviewRecord | null> {
    const row = this.database
      .query<Record<string, unknown>, [string, string]>(
        "SELECT * FROM review WHERE id=? AND project_id=?",
      )
      .get(id, projectId);
    if (row === null) return null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      subjectType: row.subject_type as ReviewRecord["subjectType"],
      subjectId: row.subject_id as string,
      reviewer: row.reviewer as string,
      status: row.status as ReviewRecord["status"],
      ...(row.summary === null ? {} : { summary: row.summary as string }),
      createdAt: new Date(row.created_at as string),
      ...(row.completed_at === null
        ? {}
        : { completedAt: new Date(row.completed_at as string) }),
    };
  }
  async updateStatus(
    kind: "milestone" | "requirement" | "adr",
    id: string,
    projectId: string,
    status: string,
    now: Date,
  ): Promise<boolean> {
    const table = kind === "adr" ? "architecture_decision" : kind;
    const result = this.database
      .prepare(
        `UPDATE ${table} SET status=?, updated_at=? WHERE id=? AND project_id=?`,
      )
      .run(status, now.toISOString(), id, projectId);
    return result.changes === 1;
  }
  async getSnapshot(projectId: string): Promise<GovernanceSnapshot> {
    const milestones = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM milestone WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        title: r.title as string,
        ...(r.description === null
          ? {}
          : { description: r.description as string }),
        status: r.status as MilestoneRecord["status"],
        createdAt: new Date(r.created_at as string),
        updatedAt: new Date(r.updated_at as string),
      }));
    const requirements = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM requirement WHERE project_id=? ORDER BY requirement_key,id",
      )
      .all(projectId)
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        ...(r.milestone_id === null
          ? {}
          : { milestoneId: r.milestone_id as string }),
        key: r.requirement_key as string,
        title: r.title as string,
        description: r.description as string,
        status: r.status as RequirementRecord["status"],
        createdAt: new Date(r.created_at as string),
        updatedAt: new Date(r.updated_at as string),
      }));
    const adrs = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM architecture_decision WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        title: r.title as string,
        context: r.context as string,
        decision: r.decision as string,
        consequences: r.consequences as string,
        status: r.status as AdrRecord["status"],
        ...(r.superseded_by_id === null
          ? {}
          : { supersededById: r.superseded_by_id as string }),
        createdAt: new Date(r.created_at as string),
        updatedAt: new Date(r.updated_at as string),
      }));
    const reviews = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM review WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        subjectType: r.subject_type as ReviewRecord["subjectType"],
        subjectId: r.subject_id as string,
        reviewer: r.reviewer as string,
        status: r.status as ReviewRecord["status"],
        ...(r.summary === null ? {} : { summary: r.summary as string }),
        createdAt: new Date(r.created_at as string),
        ...(r.completed_at === null
          ? {}
          : { completedAt: new Date(r.completed_at as string) }),
      }));
    const approvals = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM approval WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        reviewId: r.review_id as string,
        decision: r.decision as ApprovalRecord["decision"],
        actor: r.actor as string,
        ...(r.rationale === null ? {} : { rationale: r.rationale as string }),
        createdAt: new Date(r.created_at as string),
      }));
    return { milestones, requirements, adrs, reviews, approvals };
  }
}

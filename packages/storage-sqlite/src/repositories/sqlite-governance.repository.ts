import type { Database } from "bun:sqlite";
import { DuplicateRequirementKeyError } from "@ai-office/application/governance-errors.ts";
import type {
  GovernanceEventRecord,
  GovernanceRepository,
  GovernanceSnapshot,
  ReviewDecisionResult,
} from "@ai-office/application/ports/governance-repository.port.ts";
import type {
  ApprovalRecord,
  AdrRecord,
  GovernanceKind,
  GovernanceStatusByKind,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
  ReviewSubjectType,
} from "@ai-office/domain/governance/governance.ts";

const tableForKind = (kind: GovernanceKind): string =>
  kind === "adr" ? "architecture_decision" : kind;

const tableForSubject = (type: ReviewSubjectType): string => {
  if (type === "agent_run") return "agent_run";
  if (type === "adr") return "architecture_decision";
  return type;
};

export class SqliteGovernanceRepository implements GovernanceRepository {
  constructor(private readonly database: Database) {}

  private immediate<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEvent(value: GovernanceEventRecord): void {
    this.database
      .prepare(
        `INSERT INTO governance_event(
          id, project_id, event_type, aggregate_id, metadata_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.eventType,
        value.aggregateId,
        JSON.stringify(value.metadata),
        value.occurredAt.toISOString(),
      );
  }

  async saveMilestone(value: MilestoneRecord): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO milestone(
            id, project_id, title, description, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.projectId,
          value.title,
          value.description ?? null,
          value.status,
          value.createdAt.toISOString(),
          value.updatedAt.toISOString(),
        );
      this.appendEvent({
        id: `milestone:${value.id}:created`,
        projectId: value.projectId,
        eventType: "milestone.created",
        aggregateId: value.id,
        metadata: {},
        occurredAt: value.createdAt,
      });
    })();
  }

  async saveRequirement(value: RequirementRecord): Promise<void> {
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO requirement(
              id, project_id, milestone_id, requirement_key, title,
              description, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            value.id,
            value.projectId,
            value.milestoneId ?? null,
            value.key,
            value.title,
            value.description,
            value.status,
            value.createdAt.toISOString(),
            value.updatedAt.toISOString(),
          );
        this.appendEvent({
          id: `requirement:${value.id}:created`,
          projectId: value.projectId,
          eventType: "requirement.created",
          aggregateId: value.id,
          metadata: { key: value.key },
          occurredAt: value.createdAt,
        });
      })();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "requirement.project_id, requirement.requirement_key",
        )
      )
        throw new DuplicateRequirementKeyError(value.key);
      throw error;
    }
  }

  async saveAdr(value: AdrRecord): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO architecture_decision(
            id, project_id, title, context, decision, consequences, status,
            superseded_by_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.projectId,
          value.title,
          value.context,
          value.decision,
          value.consequences,
          value.status,
          value.supersededById ?? null,
          value.createdAt.toISOString(),
          value.updatedAt.toISOString(),
        );
      this.appendEvent({
        id: `adr:${value.id}:created`,
        projectId: value.projectId,
        eventType: "adr.created",
        aggregateId: value.id,
        metadata: {},
        occurredAt: value.createdAt,
      });
    })();
  }

  async saveReview(value: ReviewRecord): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO review(
            id, project_id, subject_type, subject_id, reviewer_actor_type,
            reviewer_actor_id, reviewer_display_name, status, summary,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.projectId,
          value.subjectType,
          value.subjectId,
          value.reviewer.type,
          value.reviewer.id,
          value.reviewer.displayName ?? null,
          value.status,
          value.summary ?? null,
          value.createdAt.toISOString(),
          value.completedAt?.toISOString() ?? null,
        );
      this.appendEvent({
        id: `review:${value.id}:created`,
        projectId: value.projectId,
        eventType: "review.created",
        aggregateId: value.id,
        metadata: {
          subjectType: value.subjectType,
          subjectId: value.subjectId,
        },
        occurredAt: value.createdAt,
      });
    })();
  }

  async findMilestoneProject(id: string): Promise<string | null> {
    return (
      this.database
        .query<{ project_id: string }, [string]>(
          "SELECT project_id FROM milestone WHERE id=?",
        )
        .get(id)?.project_id ?? null
    );
  }

  async findSubjectProject(
    type: ReviewSubjectType,
    id: string,
  ): Promise<string | null> {
    const table = tableForSubject(type);
    return (
      this.database
        .query<{ project_id: string }, [string]>(
          `SELECT project_id FROM ${table} WHERE id=?`,
        )
        .get(id)?.project_id ?? null
    );
  }

  async findStatus<K extends GovernanceKind>(
    kind: K,
    id: string,
    projectId: string,
  ): Promise<GovernanceStatusByKind[K] | null> {
    const row = this.database
      .query<{ status: string }, [string, string]>(
        `SELECT status FROM ${tableForKind(kind)} WHERE id=? AND project_id=?`,
      )
      .get(id, projectId);
    return (row?.status as GovernanceStatusByKind[K] | undefined) ?? null;
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
    return row === null ? null : this.reviewFromRow(row);
  }

  async updateStatus<K extends GovernanceKind>(
    kind: K,
    id: string,
    projectId: string,
    expectedStatus: GovernanceStatusByKind[K],
    status: GovernanceStatusByKind[K],
    now: Date,
  ): Promise<boolean> {
    return this.immediate(() => {
      const result = this.database
        .prepare(
          `UPDATE ${tableForKind(kind)}
           SET status=?, updated_at=?
           WHERE id=? AND project_id=? AND status=?`,
        )
        .run(status, now.toISOString(), id, projectId, expectedStatus);
      if (result.changes !== 1) return false;
      this.appendEvent({
        id: `${kind}:${id}:status:${status}`,
        projectId,
        eventType: `${kind}.status_changed`,
        aggregateId: id,
        metadata: { from: expectedStatus, to: status },
        occurredAt: now,
      });
      return true;
    });
  }

  async decideReview(value: ApprovalRecord): Promise<ReviewDecisionResult> {
    return this.immediate(() => {
      const review = this.database
        .query<{ status: ReviewRecord["status"] }, [string, string]>(
          "SELECT status FROM review WHERE id=? AND project_id=?",
        )
        .get(value.reviewId, value.projectId);
      if (review === null) return "not_found";
      if (review.status !== "pending") return "already_finalized";

      this.database
        .prepare(
          `INSERT INTO approval(
            id, project_id, review_id, decision, actor_type, actor_id,
            display_name, rationale, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.projectId,
          value.reviewId,
          value.decision,
          value.actor.type,
          value.actor.id,
          value.actor.displayName ?? null,
          value.rationale ?? null,
          value.createdAt.toISOString(),
        );
      this.appendEvent({
        id: `review:${value.reviewId}:decided`,
        projectId: value.projectId,
        eventType: "review.decided",
        aggregateId: value.reviewId,
        metadata: { decision: value.decision },
        occurredAt: value.createdAt,
      });
      return "decided";
    });
  }

  async getSnapshot(projectId: string): Promise<GovernanceSnapshot> {
    const milestones = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM milestone WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((row) => this.milestoneFromRow(row));
    const requirements = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM requirement WHERE project_id=? ORDER BY requirement_key,id",
      )
      .all(projectId)
      .map((row) => this.requirementFromRow(row));
    const adrs = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM architecture_decision WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((row) => this.adrFromRow(row));
    const reviews = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM review WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((row) => this.reviewFromRow(row));
    const approvals = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM approval WHERE project_id=? ORDER BY created_at,id",
      )
      .all(projectId)
      .map((row) => this.approvalFromRow(row));
    return { milestones, requirements, adrs, reviews, approvals };
  }

  async listEvents(projectId: string): Promise<GovernanceEventRecord[]> {
    return this.database
      .query<Record<string, unknown>, [string]>(
        `SELECT * FROM governance_event
         WHERE project_id=? ORDER BY rowid`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id as string,
        projectId: row.project_id as string,
        eventType: row.event_type as GovernanceEventRecord["eventType"],
        aggregateId: row.aggregate_id as string,
        metadata: JSON.parse(row.metadata_json as string) as Record<
          string,
          string
        >,
        occurredAt: new Date(row.occurred_at as string),
      }));
  }

  private milestoneFromRow(row: Record<string, unknown>): MilestoneRecord {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      ...(row.description === null
        ? {}
        : { description: row.description as string }),
      status: row.status as MilestoneRecord["status"],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private requirementFromRow(row: Record<string, unknown>): RequirementRecord {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      ...(row.milestone_id === null
        ? {}
        : { milestoneId: row.milestone_id as string }),
      key: row.requirement_key as string,
      title: row.title as string,
      description: row.description as string,
      status: row.status as RequirementRecord["status"],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private adrFromRow(row: Record<string, unknown>): AdrRecord {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      context: row.context as string,
      decision: row.decision as string,
      consequences: row.consequences as string,
      status: row.status as AdrRecord["status"],
      ...(row.superseded_by_id === null
        ? {}
        : { supersededById: row.superseded_by_id as string }),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private reviewFromRow(row: Record<string, unknown>): ReviewRecord {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      subjectType: row.subject_type as ReviewRecord["subjectType"],
      subjectId: row.subject_id as string,
      reviewer: {
        type: row.reviewer_actor_type as ReviewRecord["reviewer"]["type"],
        id: row.reviewer_actor_id as string,
        ...(row.reviewer_display_name === null
          ? {}
          : { displayName: row.reviewer_display_name as string }),
      },
      status: row.status as ReviewRecord["status"],
      ...(row.summary === null ? {} : { summary: row.summary as string }),
      createdAt: new Date(row.created_at as string),
      ...(row.completed_at === null
        ? {}
        : { completedAt: new Date(row.completed_at as string) }),
    };
  }

  private approvalFromRow(row: Record<string, unknown>): ApprovalRecord {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      reviewId: row.review_id as string,
      decision: row.decision as ApprovalRecord["decision"],
      actor: {
        type: row.actor_type as ApprovalRecord["actor"]["type"],
        id: row.actor_id as string,
        ...(row.display_name === null
          ? {}
          : { displayName: row.display_name as string }),
      },
      ...(row.rationale === null ? {} : { rationale: row.rationale as string }),
      createdAt: new Date(row.created_at as string),
    };
  }
}

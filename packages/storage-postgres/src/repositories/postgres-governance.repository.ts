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
import { PostgresClient } from "../database/postgres-client.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";

interface MilestoneRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneRecord["status"];
  created_at: Date | string;
  updated_at: Date | string;
}

interface RequirementRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  milestone_id: string | null;
  requirement_key: string;
  title: string;
  description: string;
  status: RequirementRecord["status"];
  created_at: Date | string;
  updated_at: Date | string;
}

interface AdrRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: AdrRecord["status"];
  superseded_by_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReviewRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  subject_type: ReviewSubjectType;
  subject_id: string;
  reviewer_actor_type: ReviewRecord["reviewer"]["type"];
  reviewer_actor_id: string;
  reviewer_display_name: string | null;
  status: ReviewRecord["status"];
  summary: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  review_id: string;
  decision: ApprovalRecord["decision"];
  actor_type: ApprovalRecord["actor"]["type"];
  actor_id: string;
  display_name: string | null;
  rationale: string | null;
  created_at: Date | string;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  event_type: GovernanceEventRecord["eventType"];
  aggregate_id: string;
  metadata_json: Record<string, string> | string;
  occurred_at: Date | string;
}

const tableForKind = (kind: GovernanceKind): string =>
  kind === "adr" ? "architecture_decision" : kind;

const tableForSubject = (type: ReviewSubjectType): string => {
  if (type === "agent_run") return "agent_run";
  if (type === "adr") return "architecture_decision";
  return type;
};

export class PostgresGovernanceRepository implements GovernanceRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async saveMilestone(value: MilestoneRecord): Promise<void> {
    await this.database.transaction(async () => {
      await this.assertProjectTenant(value.projectId);
      await this.database.query(
        `
          INSERT INTO core.milestone(
            id, project_id, title, description, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          value.id,
          value.projectId,
          value.title,
          value.description ?? null,
          value.status,
          value.createdAt,
          value.updatedAt,
        ],
      );
      await this.appendEvent({
        id: `milestone:${value.id}:created`,
        projectId: value.projectId,
        eventType: "milestone.created",
        aggregateId: value.id,
        metadata: {},
        occurredAt: value.createdAt,
      });
    });
  }

  async updateMilestoneTitle(
    id: string,
    projectId: string,
    expectedTitle: string,
    title: string,
    now: Date,
    eventId: string,
  ): Promise<boolean> {
    return this.database.transaction(async () => {
      await this.assertProjectTenant(projectId);
      const rows = await this.database.query<{ id: string }>(
        `
          UPDATE core.milestone
          SET title = $1, updated_at = $2
          WHERE id = $3 AND project_id = $4 AND title = $5
            AND EXISTS (
              SELECT 1 FROM core.project
              WHERE id = $4 AND tenant_id = $6
            )
          RETURNING id
        `,
        [title, now, id, projectId, expectedTitle, this.tenantId],
      );
      if (rows.length !== 1) return false;
      await this.appendEvent({
        id: eventId,
        projectId,
        eventType: "milestone.title_changed",
        aggregateId: id,
        metadata: { from: expectedTitle, to: title },
        occurredAt: now,
      });
      return true;
    });
  }

  async saveRequirement(value: RequirementRecord): Promise<void> {
    try {
      await this.database.transaction(async () => {
        await this.assertProjectTenant(value.projectId);
        await this.database.query(
          `
            INSERT INTO core.requirement(
              id, project_id, milestone_id, requirement_key, title,
              description, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            value.id,
            value.projectId,
            value.milestoneId ?? null,
            value.key,
            value.title,
            value.description,
            value.status,
            value.createdAt,
            value.updatedAt,
          ],
        );
        await this.appendEvent({
          id: `requirement:${value.id}:created`,
          projectId: value.projectId,
          eventType: "requirement.created",
          aggregateId: value.id,
          metadata: { key: value.key },
          occurredAt: value.createdAt,
        });
      });
    } catch (error) {
      if (hasConstraint(error, "requirement_project_key_unique"))
        throw new DuplicateRequirementKeyError(value.key);
      throw error;
    }
  }

  async saveAdr(value: AdrRecord): Promise<void> {
    await this.database.transaction(async () => {
      await this.assertProjectTenant(value.projectId);
      await this.database.query(
        `
          INSERT INTO core.architecture_decision(
            id, project_id, title, context, decision, consequences, status,
            superseded_by_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          value.id,
          value.projectId,
          value.title,
          value.context,
          value.decision,
          value.consequences,
          value.status,
          value.supersededById ?? null,
          value.createdAt,
          value.updatedAt,
        ],
      );
      await this.appendEvent({
        id: `adr:${value.id}:created`,
        projectId: value.projectId,
        eventType: "adr.created",
        aggregateId: value.id,
        metadata: {},
        occurredAt: value.createdAt,
      });
    });
  }

  async saveReview(value: ReviewRecord): Promise<void> {
    await this.database.transaction(async () => {
      await this.assertProjectTenant(value.projectId);
      await this.database.query(
        `
          INSERT INTO core.review(
            id, project_id, subject_type, subject_id, reviewer_actor_type,
            reviewer_actor_id, reviewer_display_name, status, summary,
            created_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          value.id,
          value.projectId,
          value.subjectType,
          value.subjectId,
          value.reviewer.type,
          value.reviewer.id,
          value.reviewer.displayName ?? null,
          value.status,
          value.summary ?? null,
          value.createdAt,
          value.completedAt ?? null,
        ],
      );
      await this.appendEvent({
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
    });
  }

  async findMilestoneProject(id: string): Promise<string | null> {
    const [row] = await this.database.query<{ project_id: string }>(
      `SELECT milestone.project_id
       FROM core.milestone AS milestone
       JOIN core.project AS project ON project.id = milestone.project_id
       WHERE milestone.id = $1 AND project.tenant_id = $2`,
      [id, this.tenantId],
    );
    return row?.project_id ?? null;
  }

  async findSubjectProject(
    type: ReviewSubjectType,
    id: string,
  ): Promise<string | null> {
    const [row] = await this.database.query<{ project_id: string }>(
      `SELECT subject.project_id
       FROM core.${tableForSubject(type)} AS subject
       JOIN core.project AS project ON project.id = subject.project_id
       WHERE subject.id = $1 AND project.tenant_id = $2`,
      [id, this.tenantId],
    );
    return row?.project_id ?? null;
  }

  async findStatus<K extends GovernanceKind>(
    kind: K,
    id: string,
    projectId: string,
  ): Promise<GovernanceStatusByKind[K] | null> {
    const [row] = await this.database.query<{ status: string }>(
      `
        SELECT status
        FROM core.${tableForKind(kind)} AS item
        JOIN core.project AS project ON project.id = item.project_id
        WHERE item.id = $1 AND item.project_id = $2
          AND project.tenant_id = $3
      `,
      [id, projectId, this.tenantId],
    );
    return (row?.status as GovernanceStatusByKind[K] | undefined) ?? null;
  }

  async findReview(
    id: string,
    projectId: string,
  ): Promise<ReviewRecord | null> {
    const [row] = await this.database.query<ReviewRow>(
      `
        SELECT review.id, review.project_id, review.subject_type, review.subject_id,
               review.reviewer_actor_type, review.reviewer_actor_id, review.reviewer_display_name,
               review.status, review.summary, review.created_at, review.completed_at
        FROM core.review AS review
        JOIN core.project AS project ON project.id = review.project_id
        WHERE review.id = $1 AND review.project_id = $2
          AND project.tenant_id = $3
      `,
      [id, projectId, this.tenantId],
    );
    return row === undefined ? null : reviewFromRow(row);
  }

  async updateStatus<K extends GovernanceKind>(
    kind: K,
    id: string,
    projectId: string,
    expectedStatus: GovernanceStatusByKind[K],
    status: GovernanceStatusByKind[K],
    now: Date,
  ): Promise<boolean> {
    return this.database.transaction(async () => {
      await this.assertProjectTenant(projectId);
      const rows = await this.database.query<{ id: string }>(
        `
          UPDATE core.${tableForKind(kind)}
          SET status = $1, updated_at = $2
          WHERE id = $3 AND project_id = $4 AND status = $5
            AND EXISTS (
              SELECT 1 FROM core.project
              WHERE id = $4 AND tenant_id = $6
            )
          RETURNING id
        `,
        [status, now, id, projectId, expectedStatus, this.tenantId],
      );
      if (rows.length !== 1) return false;
      await this.appendEvent({
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
    return this.database.transaction(async () => {
      await this.assertProjectTenant(value.projectId);
      const [review] = await this.database.query<{
        status: ReviewRecord["status"];
      }>(
        `
          SELECT status
          FROM core.review AS review
          JOIN core.project AS project ON project.id = review.project_id
          WHERE review.id = $1 AND review.project_id = $2
            AND project.tenant_id = $3
          FOR UPDATE
        `,
        [value.reviewId, value.projectId, this.tenantId],
      );
      if (review === undefined) return "not_found";
      if (review.status !== "pending") return "already_finalized";

      await this.database.query(
        `
          INSERT INTO core.approval(
            id, project_id, review_id, decision, actor_type, actor_id,
            display_name, rationale, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          value.id,
          value.projectId,
          value.reviewId,
          value.decision,
          value.actor.type,
          value.actor.id,
          value.actor.displayName ?? null,
          value.rationale ?? null,
          value.createdAt,
        ],
      );
      await this.appendEvent({
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
    const [milestones, requirements, adrs, reviews, approvals] =
      await Promise.all([
        this.database.query<MilestoneRow>(
          `
            SELECT id, project_id, title, description, status, created_at,
                   updated_at
            FROM core.milestone AS item
            WHERE item.project_id = $1
              AND EXISTS (
                SELECT 1 FROM core.project
                WHERE id = item.project_id AND tenant_id = $2
              )
            ORDER BY item.created_at, item.id
          `,
          [projectId, this.tenantId]
        ),
        this.database.query<RequirementRow>(
          `
            SELECT id, project_id, milestone_id, requirement_key, title,
                   description, status, created_at, updated_at
            FROM core.requirement AS item
            WHERE item.project_id = $1
              AND EXISTS (
                SELECT 1 FROM core.project
                WHERE id = item.project_id AND tenant_id = $2
              )
            ORDER BY item.requirement_key, item.id
          `,
          [projectId, this.tenantId]
        ),
        this.database.query<AdrRow>(
          `
            SELECT id, project_id, title, context, decision, consequences,
                   status, superseded_by_id, created_at, updated_at
            FROM core.architecture_decision AS item
            WHERE item.project_id = $1
              AND EXISTS (
                SELECT 1 FROM core.project
                WHERE id = item.project_id AND tenant_id = $2
              )
            ORDER BY item.created_at, item.id
          `,
          [projectId, this.tenantId]
        ),
        this.database.query<ReviewRow>(
          `
            SELECT id, project_id, subject_type, subject_id,
                   reviewer_actor_type, reviewer_actor_id,
                   reviewer_display_name, status, summary, created_at,
                   completed_at
            FROM core.review AS item
            WHERE item.project_id = $1
              AND EXISTS (
                SELECT 1 FROM core.project
                WHERE id = item.project_id AND tenant_id = $2
              )
            ORDER BY item.created_at, item.id
          `,
          [projectId, this.tenantId]
        ),
        this.database.query<ApprovalRow>(
          `
            SELECT id, project_id, review_id, decision, actor_type, actor_id,
                   display_name, rationale, created_at
            FROM core.approval AS item
            WHERE item.project_id = $1
              AND EXISTS (
                SELECT 1 FROM core.project
                WHERE id = item.project_id AND tenant_id = $2
              )
            ORDER BY item.created_at, item.id
          `,
          [projectId, this.tenantId]
        ),
      ]);

    return {
      milestones: milestones.map(milestoneFromRow),
      requirements: requirements.map(requirementFromRow),
      adrs: adrs.map(adrFromRow),
      reviews: reviews.map(reviewFromRow),
      approvals: approvals.map(approvalFromRow),
    };
  }

  async listEvents(projectId: string): Promise<GovernanceEventRecord[]> {
    const rows = await this.database.query<EventRow>(
      `
        SELECT id, project_id, event_type, aggregate_id, metadata_json,
               occurred_at
        FROM core.governance_event AS event
        WHERE event.project_id = $1
          AND EXISTS (
            SELECT 1 FROM core.project
            WHERE id = event.project_id AND tenant_id = $2
          )
        ORDER BY event.sequence
      `,
      [projectId, this.tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      metadata:
        typeof row.metadata_json === "string"
          ? (JSON.parse(row.metadata_json) as Record<string, string>)
          : row.metadata_json,
      occurredAt: toDate(row.occurred_at),
    }));
  }

  private async assertProjectTenant(projectId: string): Promise<void> {
    const rows = await this.database.query<{ id: string }>(
      "SELECT id FROM core.project WHERE id = $1 AND tenant_id = $2",
      [projectId, this.tenantId],
    );
    if (rows.length !== 1)
      throw new PostgresTenantScopeError("Project", projectId);
  }

  private async appendEvent(value: GovernanceEventRecord): Promise<void> {
    await this.database.query(
      `
        INSERT INTO core.governance_event(
          id, project_id, event_type, aggregate_id, metadata_json, occurred_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [
        value.id,
        value.projectId,
        value.eventType,
        value.aggregateId,
        value.metadata,
        value.occurredAt,
      ],
    );
  }
}

function milestoneFromRow(row: MilestoneRow): MilestoneRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function requirementFromRow(row: RequirementRow): RequirementRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.milestone_id === null ? {} : { milestoneId: row.milestone_id }),
    key: row.requirement_key,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function adrFromRow(row: AdrRow): AdrRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences,
    status: row.status,
    ...(row.superseded_by_id === null
      ? {}
      : { supersededById: row.superseded_by_id }),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function reviewFromRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    reviewer: {
      type: row.reviewer_actor_type,
      id: row.reviewer_actor_id,
      ...(row.reviewer_display_name === null
        ? {}
        : { displayName: row.reviewer_display_name }),
    },
    status: row.status,
    ...(row.summary === null ? {} : { summary: row.summary }),
    createdAt: toDate(row.created_at),
    ...(row.completed_at === null
      ? {}
      : { completedAt: toDate(row.completed_at) }),
  };
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    reviewId: row.review_id,
    decision: row.decision,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
    },
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    createdAt: toDate(row.created_at),
  };
}

function hasConstraint(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { constraint_name?: unknown };
  return value.constraint_name === constraint;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

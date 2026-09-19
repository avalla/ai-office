import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type {
  ApprovalRecord,
  AdrRecord,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
} from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresGovernanceRepository } from "@ai-office/storage-postgres/repositories/postgres-governance.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");
const now = new Date("2026-08-05T00:00:00.000Z");
let database!: PostgresClient;
let projects!: PostgresProjectRepository;
let governance!: PostgresGovernanceRepository;
let prefix!: string;

describe.skipIf(connectionString === undefined)(
  "PostgreSQL governance invariants",
  () => {
    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
      projects = new PostgresProjectRepository(database);
      governance = new PostgresGovernanceRepository(database);
    });

    beforeEach(() => {
      prefix = `governance-pg-invariant-${randomUUID()}`;
    });


    afterAll(async () => {
      await database.close();
    });

    test("rejects a requirement milestone from another project", async () => {
      const project = await createProject("project");
      const other = await createProject("other");
      const milestone = await saveMilestone(
        other.snapshot().id,
        "other-milestone",
      );

      await expect(
        governance.saveRequirement({
          ...requirement(project.snapshot().id, "requirement"),
          milestoneId: milestone.id,
        }),
      ).rejects.toThrow(
        "requirement milestone must belong to the same project",
      );
    });

    test("rejects an ADR superseding another project's ADR", async () => {
      const project = await createProject("project");
      const other = await createProject("other");
      const target = await saveAdr(other.snapshot().id, "other-adr");

      await expect(
        governance.saveAdr({
          ...adr(project.snapshot().id, "source"),
          status: "superseded",
          supersededById: target.id,
        }),
      ).rejects.toThrow();
    });

    test("rejects missing and cross-project review subjects", async () => {
      const project = await createProject("project");
      const other = await createProject("other");
      const otherRequirement = await saveRequirement(
        other.snapshot().id,
        "other-requirement",
      );

      await expect(
        governance.saveReview({
          ...review(project.snapshot().id, "missing-review"),
          subjectType: "requirement",
          subjectId: "missing-subject",
        }),
      ).rejects.toThrow("review subject does not exist in the same project");

      await expect(
        governance.saveReview({
          ...review(project.snapshot().id, "cross-review"),
          subjectType: "requirement",
          subjectId: otherRequirement.id,
        }),
      ).rejects.toThrow("review subject does not exist in the same project");
    });

    test("accepts every current SQLite review subject type with same-project ownership", async () => {
      const project = await createProject("project");
      const task = Task.create({
        id: `${prefix}-task`,
        projectId: project.snapshot().id,
        title: "Task",
        now,
      });
      await new PostgresTaskRepository(database).save(task);
      const milestone = await saveMilestone(project.snapshot().id, "milestone");
      const requirementValue = await saveRequirement(
        project.snapshot().id,
        "requirement",
      );
      const adrValue = await saveAdr(project.snapshot().id, "adr");
      await database.query(
        "INSERT INTO core.agent_run(id, project_id) VALUES ($1, $2)",
        [`${prefix}-agent-run`, project.snapshot().id],
      );

      const subjects = [
        ["task", task.snapshot().id],
        ["agent_run", `${prefix}-agent-run`],
        ["requirement", requirementValue.id],
        ["adr", adrValue.id],
        ["milestone", milestone.id],
      ] as const;
      for (const [subjectType, subjectId] of subjects)
        await governance.saveReview({
          ...review(project.snapshot().id, `${subjectType}-review`),
          subjectType,
          subjectId,
        });

      expect(
        (await governance.getSnapshot(project.snapshot().id)).reviews,
      ).toHaveLength(subjects.length);
    });

    test("rejects approval and governance-event updates and deletes", async () => {
      const project = await createProject("project");
      const requirementValue = await saveRequirement(
        project.snapshot().id,
        "requirement",
      );
      const reviewValue = await saveReview(
        project.snapshot().id,
        "review",
        requirementValue.id,
      );
      const approval = approvalValue(project.snapshot().id, reviewValue.id);

      await expect(governance.decideReview(approval)).resolves.toBe("decided");
      await expect(
        database.query(
          "UPDATE core.approval SET rationale = $1 WHERE id = $2",
          ["changed", approval.id],
        ),
      ).rejects.toThrow("approval is append-only");
      await expect(
        database.query("DELETE FROM core.approval WHERE id = $1", [
          approval.id,
        ]),
      ).rejects.toThrow("approval is append-only");

      const [event] = await database.query<{ id: string }>(
        "SELECT id FROM core.governance_event WHERE project_id = $1 ORDER BY sequence LIMIT 1",
        [project.snapshot().id],
      );
      await expect(
        database.query(
          "UPDATE core.governance_event SET aggregate_id = $1 WHERE id = $2",
          ["changed", event?.id],
        ),
      ).rejects.toThrow("governance_event is append-only");
      await expect(
        database.query("DELETE FROM core.governance_event WHERE id = $1", [
          event?.id,
        ]),
      ).rejects.toThrow("governance_event is append-only");
    });

    test("rolls back approval and review finalization together", async () => {
      const project = await createProject("project");
      const requirementValue = await saveRequirement(
        project.snapshot().id,
        "requirement",
      );
      const reviewValue = await saveReview(
        project.snapshot().id,
        "review",
        requirementValue.id,
      );
      const approval = approvalValue(project.snapshot().id, reviewValue.id);
      await database.query(
        `INSERT INTO core.governance_event(
           id, project_id, event_type, aggregate_id, metadata_json, occurred_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          `review:${reviewValue.id}:decided`,
          project.snapshot().id,
          "review.decided",
          reviewValue.id,
          {},
          now,
        ],
      );

      await expect(governance.decideReview(approval)).rejects.toThrow();
      const snapshot = await governance.getSnapshot(project.snapshot().id);
      expect(snapshot.approvals).toEqual([]);
      expect(snapshot.reviews[0]).toMatchObject({
        id: reviewValue.id,
        status: "pending",
      });
      expect(snapshot.reviews[0]?.completedAt).toBeUndefined();
    });

    test("serializes concurrent finalization to one approval", async () => {
      const project = await createProject("project");
      const requirementValue = await saveRequirement(
        project.snapshot().id,
        "requirement",
      );
      const reviewValue = await saveReview(
        project.snapshot().id,
        "review",
        requirementValue.id,
      );

      const results = await Promise.all([
        governance.decideReview(
          approvalValue(project.snapshot().id, reviewValue.id),
        ),
        governance.decideReview({
          ...approvalValue(project.snapshot().id, reviewValue.id),
          id: `${prefix}-approval-2`,
          decision: "rejected",
        }),
      ]);
      expect(results.sort()).toEqual(["already_finalized", "decided"]);
      expect(
        (await governance.getSnapshot(project.snapshot().id)).approvals,
      ).toHaveLength(1);
    });

    test("prevents terminal reviews without approval and prevents returning to pending", async () => {
      const project = await createProject("project");
      const requirementValue = await saveRequirement(
        project.snapshot().id,
        "requirement",
      );
      const reviewValue = await saveReview(
        project.snapshot().id,
        "review",
        requirementValue.id,
      );

      await expect(
        database.query(
          "UPDATE core.review SET status = 'approved' WHERE id = $1",
          [reviewValue.id],
        ),
      ).rejects.toThrow("review status requires a matching decision");

      await expect(
        governance.decideReview(
          approvalValue(project.snapshot().id, reviewValue.id),
        ),
      ).resolves.toBe("decided");
      await expect(
        database.query(
          "UPDATE core.review SET status = 'pending' WHERE id = $1",
          [reviewValue.id],
        ),
      ).rejects.toThrow("decided review cannot return to pending");
    });
  },
);

async function createProject(suffix: string): Promise<Project> {
  const value = Project.create({
    id: `${prefix}-${suffix}`,
    name: suffix,
    now,
  });
  await projects.save(value);
  return value;
}

async function saveMilestone(
  projectId: string,
  suffix: string,
): Promise<MilestoneRecord> {
  const value: MilestoneRecord = {
    id: `${prefix}-${suffix}`,
    projectId,
    title: suffix,
    status: "planned",
    createdAt: now,
    updatedAt: now,
  };
  await governance.saveMilestone(value);
  return value;
}

async function saveRequirement(
  projectId: string,
  suffix: string,
): Promise<RequirementRecord> {
  const value = requirement(projectId, suffix);
  await governance.saveRequirement(value);
  return value;
}

function requirement(projectId: string, suffix: string): RequirementRecord {
  return {
    id: `${prefix}-${suffix}`,
    projectId,
    key: `${suffix}-key`,
    title: suffix,
    description: suffix,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
}

async function saveAdr(projectId: string, suffix: string): Promise<AdrRecord> {
  const value = adr(projectId, suffix);
  await governance.saveAdr(value);
  return value;
}

function adr(projectId: string, suffix: string): AdrRecord {
  return {
    id: `${prefix}-${suffix}`,
    projectId,
    title: suffix,
    context: "Context",
    decision: "Decision",
    consequences: "Consequences",
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
}

async function saveReview(
  projectId: string,
  suffix: string,
  subjectId: string,
): Promise<ReviewRecord> {
  const value: ReviewRecord = {
    ...review(projectId, suffix),
    subjectType: "requirement",
    subjectId,
  };
  await governance.saveReview(value);
  return value;
}

function review(projectId: string, suffix: string): ReviewRecord {
  return {
    id: `${prefix}-${suffix}`,
    projectId,
    subjectType: "requirement",
    subjectId: `${prefix}-missing`,
    reviewer: { type: "user", id: "reviewer" },
    status: "pending",
    createdAt: now,
  };
}

function approvalValue(projectId: string, reviewId: string): ApprovalRecord {
  return {
    id: `${prefix}-approval`,
    projectId,
    reviewId,
    decision: "approved",
    actor: { type: "user", id: "approver" },
    createdAt: now,
  };
}

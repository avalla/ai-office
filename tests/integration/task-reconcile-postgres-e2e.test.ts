import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { ManageTaskLifecycle } from "@ai-office/application/commands/manage-task-lifecycle.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import {
  ReconcileTasks,
  TaskReconciliationApprovalError,
  TaskReconciliationStalePlanError,
} from "@ai-office/application/commands/reconcile-tasks.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresGovernanceRepository } from "@ai-office/storage-postgres/repositories/postgres-governance.repository.ts";
import { PostgresPipelineRunRepository } from "@ai-office/storage-postgres/repositories/postgres-pipeline-run.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskDependencyRepository } from "@ai-office/storage-postgres/repositories/postgres-task-dependency.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from "../helpers/postgres-test-db.ts";

// RRD-02: the review-exit reconciliation path against PostgreSQL
// repositories, where the prerequisite-exit triggers and advisory locks of
// supabase/migrations/20261008000300 are the real admission guard. The
// lifecycle transitions are driven through ManageTaskLifecycle (the same
// service the CLI uses) and the finding and repair through ReconcileTasks,
// so the whole path — admission under review, exit, finding, approval-gated
// repair, audit — runs against the storage that enforces it.
//
// The suite uses a dedicated database migrated in beforeAll and dropped in
// afterAll (see tests/helpers/postgres-test-db.ts).

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const epoch = new Date("2026-10-15T00:00:00.000Z");
const clock: Clock = { now: () => new Date(epoch) };
const ids: IdGenerator = { generate: () => randomUUID() };

/**
 * Task reads that commit a prerequisite recovery on a second connection just
 * after the repair transaction re-derives its plan.
 *
 * Under READ COMMITTED neither the derivation reads nor the plan-hash check
 * take row locks, so the recovery's UPDATE commits while the repair
 * transaction is open; the apply-time revalidation read then sees it. The raw
 * UPDATE bypassing domain transitions follows the run-tick e2e precedent —
 * it models a concurrent writer, not application behavior.
 */
class RecoveringTaskReads implements TaskRepository {
  private inspections = 0;

  constructor(
    private readonly inner: TaskRepository,
    private readonly prerequisiteId: string,
    private readonly recovery: PostgresClient,
  ) {}

  async findById(id: string): Promise<Task | null> {
    return this.inner.findById(id);
  }

  async listByProject(projectId: string): Promise<Task[]> {
    const tasks = await this.inner.listByProject(projectId);
    this.inspections += 1;
    // The first listByProject is the operator's inspection; the second is
    // repair()'s in-transaction re-derivation. Recovering after it keeps the
    // derived plan matching the approved hash, so only the apply-time
    // revalidation can still refuse.
    if (this.inspections === 2)
      await this.recovery.query(
        "UPDATE core.task SET status = 'running', updated_at = $2 WHERE id = $1",
        [this.prerequisiteId, new Date(epoch.getTime() + 1)],
      );
    return tasks;
  }

  async save(task: Task): Promise<void> {
    return this.inner.save(task);
  }
}

describe.skipIf(connectionString === undefined)(
  "task:reconcile PostgreSQL end-to-end",
  () => {
    let db: PostgresTestDatabase;

    beforeAll(async () => {
      db = await createPostgresTestDatabase({
        adminConnectionString: connectionString!,
        prefix: "ai_office_rrd02_",
      });
    }, 60_000);

    afterAll(async () => {
      // beforeAll may have failed before assigning db; the helper already
      // cleans up its own failure paths, so only dispose a live database.
      if (db !== undefined) await db.dispose();
    });

    async function seedProject() {
      const suffix = randomUUID();
      const tenantId = `rrd02-tenant-${suffix}`;
      const projectId = `rrd02-project-${suffix}`;
      const prerequisiteId = `rrd02-prerequisite-${suffix}`;
      const dependentId = `rrd02-dependent-${suffix}`;
      await db.client.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [tenantId, tenantId, epoch],
      );
      const projects = new PostgresProjectRepository(db.client, tenantId);
      const tasks = new PostgresTaskRepository(db.client, tenantId);
      const dependencies = new PostgresTaskDependencyRepository(
        db.client,
        tenantId,
      );
      const pipelines = new PostgresPipelineRunRepository(db.client, tenantId);
      const runtime = new PostgresAgentRuntimeRepository(db.client, tenantId);
      const links = new PostgresTaskRequirementRepository(db.client, tenantId);
      const governance = new PostgresGovernanceRepository(db.client, tenantId);
      const transactions = new PostgresTransactionRunner(db.client);
      const audit = new RecordAuditEvent(
        new PostgresAuditEventRepository(db.client, tenantId),
        ids,
        clock,
      );
      const lifecycle = new ManageTaskLifecycle(
        projects,
        tasks,
        audit,
        clock,
        transactions,
        undefined,
        dependencies,
      );
      const reconcile = new ReconcileTasks(
        projects,
        tasks,
        pipelines,
        runtime,
        links,
        lifecycle,
        clock,
        transactions,
        governance,
        dependencies,
      );
      await projects.save(
        Project.create({ id: projectId, name: projectId, now: epoch }),
      );
      await tasks.save(
        Task.create({
          id: prerequisiteId,
          projectId,
          title: "Prerequisite",
          now: epoch,
        }),
      );
      await tasks.save(
        Task.create({
          id: dependentId,
          projectId,
          title: "Dependent",
          now: epoch,
        }),
      );
      await dependencies.link({
        projectId,
        taskId: dependentId,
        dependsOnTaskId: prerequisiteId,
        createdAt: epoch,
      });
      return {
        projectId,
        prerequisiteId,
        dependentId,
        lifecycle,
        reconcile,
        projects,
        tasks,
        pipelines,
        runtime,
        links,
        governance,
        dependencies,
        transactions,
      };
    }

    async function auditEvents(projectId: string) {
      return db.client.query<{
        event_type: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT event_type, aggregate_id, payload_json AS payload FROM core.audit_event WHERE project_id = $1 ORDER BY sequence",
        [projectId],
      );
    }

    async function taskStatus(taskId: string): Promise<string> {
      const [row] = await db.client.query<{ status: string }>(
        "SELECT status FROM core.task WHERE id = $1",
        [taskId],
      );
      return row!.status;
    }

    test("a prerequisite leaving review surfaces the started dependent, and only an approved repair mutates it", async () => {
      const f = await seedProject();
      const input = (taskId: string) => ({
        projectId: f.projectId,
        taskId,
        actorId: "operator",
      });
      await f.lifecycle.start(input(f.prerequisiteId));
      await f.lifecycle.submitForReview(input(f.prerequisiteId));
      // Admitted under the review-ready rule (PR #147).
      await f.lifecycle.start(input(f.dependentId));
      await f.lifecycle.submitForReview(input(f.dependentId));

      // The review exit: the dependent can never complete on rejected work.
      await f.lifecycle.fail({
        ...input(f.prerequisiteId),
        reason: "Review rejected the change",
      });

      // Detection is a read: the dependent row and the audit trail are
      // exactly what the lifecycle transitions left behind.
      const auditBefore = await auditEvents(f.projectId);
      const report = await f.reconcile.inspect(f.projectId);
      expect(await taskStatus(f.dependentId)).toBe("waiting_review");
      expect(await auditEvents(f.projectId)).toEqual(auditBefore);

      const issue = report.issues.find(
        (value) =>
          value.finding === "blocking_prerequisite_incomplete" &&
          value.taskId === f.dependentId,
      );
      expect(issue).toMatchObject({
        severity: "inconsistent",
        repairable: true,
        repairOperation: "cancel",
        suggestedCommand: "task:cancel",
        refusalReason: null,
        reviewExits: [
          {
            taskId: f.prerequisiteId,
            from: "waiting_review",
            to: "failed",
          },
        ],
      });
      expect(issue?.summary).toContain(
        `prerequisite ${f.prerequisiteId} exited waiting_review -> failed`,
      );
      expect(report.planHash).not.toBeNull();

      // No dependent state mutation without approval: a mismatched hash is
      // refused and changes nothing.
      await expect(
        f.reconcile.repair({
          projectId: f.projectId,
          approvedPlanHash: "0".repeat(64),
          actorId: "operator",
        }),
      ).rejects.toBeInstanceOf(TaskReconciliationApprovalError);
      expect(await taskStatus(f.dependentId)).toBe("waiting_review");
      expect(await auditEvents(f.projectId)).toEqual(auditBefore);

      // The approved plan cancels the dependent through the lifecycle
      // service, with the same audit record a manual task:cancel writes.
      const result = await f.reconcile.repair({
        projectId: f.projectId,
        approvedPlanHash: report.planHash!,
        actorId: "operator",
      });
      expect(result.applied).toEqual([
        {
          taskId: f.dependentId,
          from: "waiting_review",
          to: "cancelled",
          operation: "cancel",
        },
      ]);
      expect(await taskStatus(f.dependentId)).toBe("cancelled");
      const auditAfter = await auditEvents(f.projectId);
      expect(auditAfter).toHaveLength(auditBefore.length + 1);
      expect(auditAfter.at(-1)).toMatchObject({
        event_type: "task.status_changed",
        aggregate_id: f.dependentId,
        payload: {
          operation: "cancel",
          from: "waiting_review",
          to: "cancelled",
          reason: `reconciled: prerequisite ${f.prerequisiteId} exited review to failed`,
        },
      });

      // The repair consumed the finding: re-inspection is clean and the
      // consumed hash approves nothing twice.
      const after = await f.reconcile.inspect(f.projectId);
      expect(after.issues).toEqual([]);
      expect(after.planHash).toBeNull();
      await expect(
        f.reconcile.repair({
          projectId: f.projectId,
          approvedPlanHash: report.planHash!,
          actorId: "operator",
        }),
      ).rejects.toBeInstanceOf(TaskReconciliationApprovalError);
    });

    test("a blocked prerequisite offers the reversible block repair", async () => {
      const f = await seedProject();
      const input = (taskId: string) => ({
        projectId: f.projectId,
        taskId,
        actorId: "operator",
      });
      await f.lifecycle.start(input(f.prerequisiteId));
      await f.lifecycle.submitForReview(input(f.prerequisiteId));
      await f.lifecycle.start(input(f.dependentId));
      await f.lifecycle.block({
        ...input(f.prerequisiteId),
        reason: "Review found a blocker",
      });

      const report = await f.reconcile.inspect(f.projectId);
      const issue = report.issues.find(
        (value) =>
          value.finding === "blocking_prerequisite_incomplete" &&
          value.taskId === f.dependentId,
      );
      expect(issue).toMatchObject({
        severity: "warning",
        repairable: true,
        repairOperation: "block",
        suggestedCommand: `task:block --reason ${JSON.stringify(
          `reconciled: prerequisite ${f.prerequisiteId} exited review to blocked`,
        )}`,
        reviewExits: [
          {
            taskId: f.prerequisiteId,
            from: "waiting_review",
            to: "blocked",
          },
        ],
      });

      const result = await f.reconcile.repair({
        projectId: f.projectId,
        approvedPlanHash: report.planHash!,
        actorId: "operator",
      });
      expect(result.applied).toEqual([
        {
          taskId: f.dependentId,
          from: "running",
          to: "blocked",
          operation: "block",
        },
      ]);
      expect(await taskStatus(f.dependentId)).toBe("blocked");
      const events = await auditEvents(f.projectId);
      expect(events.at(-1)).toMatchObject({
        event_type: "task.status_changed",
        aggregate_id: f.dependentId,
        payload: {
          operation: "block",
          from: "running",
          to: "blocked",
          reason: `reconciled: prerequisite ${f.prerequisiteId} exited review to blocked`,
        },
      });
    });

    test("refuses the repair when the prerequisite recovers between plan derivation and apply", async () => {
      const f = await seedProject();
      const input = (taskId: string) => ({
        projectId: f.projectId,
        taskId,
        actorId: "operator",
      });
      await f.lifecycle.start(input(f.prerequisiteId));
      await f.lifecycle.submitForReview(input(f.prerequisiteId));
      await f.lifecycle.start(input(f.dependentId));
      await f.lifecycle.block({
        ...input(f.prerequisiteId),
        reason: "Review found a blocker",
      });

      // Reconciliation reads through the decorator; the lifecycle keeps the
      // original repository — which is the gap under test, since block/cancel
      // never re-read prerequisites.
      const recovery = new PostgresClient(db.connectionString);
      const reads = new RecoveringTaskReads(
        f.tasks,
        f.prerequisiteId,
        recovery,
      );
      const reconcile = new ReconcileTasks(
        f.projects,
        reads,
        f.pipelines,
        f.runtime,
        f.links,
        f.lifecycle,
        clock,
        f.transactions,
        f.governance,
        f.dependencies,
      );
      try {
        const report = await reconcile.inspect(f.projectId);
        expect(report.planHash).not.toBeNull();
        const auditBefore = await auditEvents(f.projectId);

        // The recovery commits on the second connection just after the repair
        // transaction re-derived the matching plan; the apply-time
        // revalidation read then sees it and refuses the whole batch.
        await expect(
          reconcile.repair({
            projectId: f.projectId,
            approvedPlanHash: report.planHash!,
            actorId: "operator",
          }),
        ).rejects.toBeInstanceOf(TaskReconciliationStalePlanError);

        // The refusal wrote nothing: no status change, no audit record.
        expect(await taskStatus(f.dependentId)).toBe("running");
        expect(await auditEvents(f.projectId)).toEqual(auditBefore);

        // Re-inspection describes the recovered state: the repairless
        // warning, no plan to approve.
        const after = await f.reconcile.inspect(f.projectId);
        const issue = after.issues.find(
          (value) =>
            value.finding === "blocking_prerequisite_incomplete" &&
            value.taskId === f.dependentId,
        );
        expect(issue).toMatchObject({
          severity: "warning",
          repairable: false,
          repairOperation: null,
          suggestedCommand: null,
        });
        expect(issue?.reviewExits).toBeUndefined();
        expect(after.planHash).toBeNull();
      } finally {
        await recovery.close();
      }
    });
  },
);

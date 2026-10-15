import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { SimulatedAgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import { RunExecutionControl } from "@ai-office/application/runtime/run-execution-control.ts";
import { AdmitAgentRun } from "@ai-office/application/commands/admit-agent-run.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import {
  isPrerequisiteRefusal,
  TaskPrerequisiteIncompleteError,
} from "@ai-office/application/commands/manage-task-dependencies.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { RecoverSuspendedPipelines } from "@ai-office/application/pipeline/recover-suspended-pipelines.ts";
import { executeRuntimeCommand } from "@ai-office/runtime-host/runtime-command.ts";
import type { RuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate as migrateSqlite } from "@ai-office/storage-sqlite/database/migrate.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresGovernanceRepository } from "@ai-office/storage-postgres/repositories/postgres-governance.repository.ts";
import { PostgresOfficeManifestRepository } from "@ai-office/storage-postgres/repositories/postgres-office-manifest.repository.ts";
import { PostgresPipelineRunRepository } from "@ai-office/storage-postgres/repositories/postgres-pipeline-run.repository.ts";
import { PostgresProjectDefinitionRepository } from "@ai-office/storage-postgres/repositories/postgres-project-definition.repository.ts";
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskDependencyRepository } from "@ai-office/storage-postgres/repositories/postgres-task-dependency.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from "../helpers/postgres-test-db.ts";

// RRD-03: hermetic end-to-end coverage of the `run:tick` path against
// PostgreSQL repositories, focused on the prerequisite-exit race at the
// dependency gate.
//
// Two layers are covered, and the names say which:
// - The "run:tick command ..." tests dispatch `run:tick` through
//   executeRuntimeCommand (the dispatcher the daemon routes to), so the real
//   handler in packages/runtime-host/src/commands/run.ts runs: claim-refusal
//   tolerance, execution-control reservation release, the
//   STAGE_AWAITING_PREREQUISITES translation, exit code and JSON report.
// - The remaining tests compose the application services the handler wires
//   (schedule -> admit -> execute -> completeStageFromAgentRun) directly, to
//   assert storage-level state and typed errors.
// Not covered: the Unix-socket transport. The daemon cannot host PostgreSQL
// because storage is still partial (StorageProviderIncompleteError), so the
// handler is driven in-process with a PostgreSQL-backed ProjectStorage. The
// suite uses a dedicated database migrated in beforeAll and dropped in
// afterAll (see tests/helpers/postgres-test-db.ts).
//
// The race is the one guarded by supabase/migrations/20261008000300: a
// prerequisite leaving waiting_review takes the project's graph-edit advisory
// lock in the writing transaction, and the claim trigger on core.agent_run
// takes the same lock and re-reads prerequisite statuses before committing
// the admission. Removing either lock turns the deterministic "blocked claim,
// then typed refusal" below into a timeout or a wrongly admitted run.

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const epoch = new Date("2026-10-11T00:00:00.000Z");
const clock: Clock = { now: () => new Date(epoch) };
const ids: IdGenerator = { generate: () => randomUUID() };

describe.skipIf(connectionString === undefined)(
  "run:tick PostgreSQL end-to-end",
  () => {
    let db: PostgresTestDatabase;

    beforeAll(async () => {
      db = await createPostgresTestDatabase({
        adminConnectionString: connectionString!,
        prefix: "ai_office_rrd03_",
      });
    }, 60_000);

    afterAll(async () => {
      // beforeAll may have failed before assigning db; the helper already
      // cleans up its own failure paths, so only dispose a live database.
      if (db !== undefined) await db.dispose();
    });

    async function seedOffice() {
      const suffix = randomUUID();
      const tenantId = `rrd03-tenant-${suffix}`;
      const projectId = `rrd03-project-${suffix}`;
      const prerequisiteId = `rrd03-prerequisite-${suffix}`;
      const dependentId = `rrd03-dependent-${suffix}`;
      await db.client.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [tenantId, tenantId, epoch],
      );
      const projects = new PostgresProjectRepository(db.client, tenantId);
      const tasks = new PostgresTaskRepository(db.client, tenantId);
      const runtime = new PostgresAgentRuntimeRepository(db.client, tenantId);
      const dependencies = new PostgresTaskDependencyRepository(
        db.client,
        tenantId,
      );
      const auditEvents = new PostgresAuditEventRepository(db.client, tenantId);
      const pipelines = new PostgresPipelineRunRepository(db.client, tenantId);
      const manifests = new PostgresOfficeManifestRepository(
        db.client,
        tenantId,
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
      const role = Role.create({
        id: `rrd03-role-${suffix}`,
        projectId,
        key: "developer",
        name: "Developer",
        version: 1,
        capabilities: ["read"],
        tools: ["test"],
        modelPolicy: "mock",
        limits: { maxIterations: 3, maxCostMicros: 5000n, timeoutSeconds: 60 },
        sourcePath: "roles/developer.yaml",
        now: epoch,
      });
      const agent = {
        id: `rrd03-agent-${suffix}`,
        projectId,
        roleId: role.snapshot().id,
        name: "Developer",
        enabled: true,
        createdAt: epoch,
        updatedAt: epoch,
      };
      await runtime.saveRole(role);
      await runtime.saveAgent(agent);
      await dependencies.link({
        projectId,
        taskId: dependentId,
        dependsOnTaskId: prerequisiteId,
        createdAt: epoch,
      });
      // Review-submitted prerequisites admit dependent execution (PR #147).
      await db.client.query(
        "UPDATE core.task SET status = 'waiting_review', updated_at = $2 WHERE id = $1",
        [prerequisiteId, epoch],
      );
      const transactions = new PostgresTransactionRunner(db.client);
      const audit = new RecordAuditEvent(auditEvents, ids, clock);
      const scheduler = new ScheduleAgentRun(
        projects,
        tasks,
        runtime,
        ids,
        clock,
        transactions,
        pipelines,
        undefined,
        undefined,
        dependencies,
      );
      const admission = new AdmitAgentRun(
        runtime,
        tasks,
        pipelines,
        clock,
        undefined,
        dependencies,
      );
      const execute = new ExecuteAgentRun(
        runtime,
        new SimulatedAgentExecutor(),
        new InMemoryWorktreeManager(),
        clock,
      );
      const pipelineManager = new ManagePipelineRuns(
        manifests,
        pipelines,
        tasks,
        runtime,
        audit,
        ids,
        clock,
        transactions,
        undefined,
        dependencies,
      );
      return {
        projectId,
        prerequisiteId,
        dependentId,
        tenantId,
        agent,
        manifests,
        runtime,
        pipelines,
        tasks,
        dependencies,
        scheduler,
        admission,
        execute,
        pipelineManager,
      };
    }

    async function setTaskStatus(taskId: string, status: string, at: Date) {
      await db.client.query(
        "UPDATE core.task SET status = $2, updated_at = $3 WHERE id = $1",
        [taskId, status, at],
      );
    }

    // The handler runs on the host SystemClock, while the suite schedules with
    // a fixed epoch; keep the schedule-time lease valid for the handler tick by
    // deriving the expiry from the wall clock, never from a fixed date.
    async function extendTaskLease(taskId: string) {
      await db.client.query(
        "UPDATE core.task_lock SET expires_at = $2 WHERE task_id = $1",
        [taskId, new Date(Date.now() + 24 * 60 * 60 * 1000)],
      );
    }

    /**
     * A Runtime command context whose run:tick-relevant ports are the
     * PostgreSQL repositories under test. Ports that run:tick never touches
     * for runs without an action intent (capabilities, controlled execution,
     * costs, job outbox, and the other ports storage-postgres has not
     * implemented yet) come from an isolated SQLite store so the composed
     * ProjectStorage stays complete; every read or write on the
     * schedule/admit/execute/stage-completion path is PostgreSQL.
     */
    async function composeHandler(f: Awaited<ReturnType<typeof seedOffice>>) {
      const directory = await mkdtemp(join(tmpdir(), "rrd03-runtime-"));
      const sqlite = openDatabase(join(directory, "project.sqlite"));
      migrateSqlite(sqlite, "migrations/project");
      const base = createSqliteProjectStorage(sqlite);
      const client = db.client;
      const storage: ProjectStorage = {
        ...base,
        projects: new PostgresProjectRepository(client, f.tenantId),
        packBindings: new PostgresProjectPackBindingRepository(
          client,
          f.tenantId,
        ),
        definitions: new PostgresProjectDefinitionRepository(
          client,
          f.tenantId,
        ),
        officeManifests: new PostgresOfficeManifestRepository(
          client,
          f.tenantId,
        ),
        pipelines: new PostgresPipelineRunRepository(client, f.tenantId),
        tasks: new PostgresTaskRepository(client, f.tenantId),
        taskDependencies: new PostgresTaskDependencyRepository(
          client,
          f.tenantId,
        ),
        taskRequirements: new PostgresTaskRequirementRepository(
          client,
          f.tenantId,
        ),
        runtime: new PostgresAgentRuntimeRepository(client, f.tenantId),
        governance: new PostgresGovernanceRepository(client, f.tenantId),
        auditEvents: new PostgresAuditEventRepository(client, f.tenantId),
        transactions: new PostgresTransactionRunner(client),
      };
      const executionControl = new RunExecutionControl("rrd03-test-host");
      const runtimePaths: RuntimePaths = {
        runtimeHome: directory,
        projectDatabasePath: join(directory, "project.sqlite"),
        socketPath: join(directory, "runtime.sock"),
        globalDatabasePath: join(directory, "global.sqlite"),
        draftsDirectory: join(directory, "drafts"),
        generatedDirectory: join(directory, "generated"),
      };
      async function run(args: string[]) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const code = await executeRuntimeCommand(args, {
          projectRoot: directory,
          runtimePaths,
          projectStorage: storage,
          executionControl,
          io: {
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
          },
        });
        return { code, stdout, stderr };
      }
      return {
        executionControl,
        run,
        async close() {
          sqlite.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    }

    async function seedDeliveryManifest(
      f: Awaited<ReturnType<typeof seedOffice>>,
    ) {
      await f.manifests.save({
        id: `rrd03-manifest-${randomUUID()}`,
        projectId: f.projectId,
        revision: 1,
        manifest: {
          schemaVersion: 1,
          provenance: {
            host: "codex",
            skill: "ai-office",
            skillVersion: "1.0.0",
          },
          project: {
            mission: "RRD-03",
            goals: ["Cover run:tick on PostgreSQL"],
            constraints: [],
            preferences: [],
            permissionPreferences: [],
          },
          office: {
            name: "RRD-03 office",
            roles: [
              {
                id: "developer",
                title: "Developer",
                purpose: "Build",
                responsibilities: ["Build"],
              },
            ],
          },
          pipelines: [
            {
              id: "delivery",
              name: "Delivery",
              description: "Single-stage delivery",
              defaultFor: ["feature"],
              enforcement: "enforced",
              stages: [
                {
                  id: "build",
                  name: "Build",
                  roleId: "developer",
                  objective: "Build",
                  checks: ["Tests"],
                  requiresApproval: false,
                  capabilities: [],
                },
              ],
            },
          ],
        },
        appliedAt: epoch,
      });
    }

    test("claims and executes a queued run behind a review-submitted prerequisite", async () => {
      const f = await seedOffice();
      const runId = await f.scheduler.execute({
        projectId: f.projectId,
        taskId: f.dependentId,
        agentId: f.agent.id,
      });
      const queued = await f.runtime.listQueuedRuns(f.projectId, 1);
      expect(queued.map((run) => run.snapshot().id)).toEqual([runId]);
      const claimed = await f.admission.execute(queued[0]!);
      expect(claimed?.snapshot().status).toBe("preparing");
      const result = await f.execute.execute(claimed!);
      expect(result.status).toBe("completed");
      expect(
        (await f.runtime.listRunEvents(runId)).map((event) => event.status),
      ).toEqual(["queued", "preparing", "running", "reviewing", "completed"]);
      expect(await f.runtime.findTaskLock(f.dependentId)).toBeNull();
    });

    test(
      "refuses a claim that races a prerequisite leaving review, then recovers",
      { timeout: 30_000 },
      async () => {
        const f = await seedOffice();
        const runId = await f.scheduler.execute({
          projectId: f.projectId,
          taskId: f.dependentId,
          agentId: f.agent.id,
        });
        const queued = await f.runtime.listQueuedRuns(f.projectId, 1);
        expect(queued.map((run) => run.snapshot().id)).toEqual([runId]);
        const historyBefore = await db.client.query(
          "SELECT state, first_known_at FROM core.task_execution_history WHERE task_id = $1",
          [f.dependentId],
        );

        const mutation = new PostgresClient(db.connectionString);
        const observer = new PostgresClient(db.connectionString);
        let release!: () => void;
        let locked!: () => void;
        const lockAcquired = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const releaseGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        // The prerequisite leaves review. The exit takes the project's
        // graph-edit advisory lock and holds it until this transaction commits.
        const mutationDone = mutation.transaction(async () => {
          await mutation.query(
            "UPDATE core.task SET status = 'failed', updated_at = $2 WHERE id = $1",
            [f.prerequisiteId, new Date(epoch.getTime() + 1)],
          );
          locked();
          await releaseGate;
        });
        try {
          await lockAcquired;
          // The application-level check still sees waiting_review; the claim
          // then blocks on the advisory lock held by the exit transaction.
          const claim = f.admission.execute(queued[0]!);
          // If the observer loop below gives up, the in-flight claim rejects
          // without a handler; keep the real failure free of that noise.
          claim.catch(() => undefined);
          for (let attempt = 0; attempt < 1000; attempt += 1) {
            const [row] = await observer.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE datname = current_database()
                 AND wait_event_type = 'Lock' AND state = 'active'`,
            );
            if ((row?.count ?? 0) > 0) break;
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (attempt === 999)
              throw new Error("claim did not reach the dependency-gate lock");
          }
          release();
          const outcome = await claim.then(
            () => ({ refused: false, error: undefined as unknown }),
            (error: unknown) => ({ refused: true, error }),
          );
          await mutationDone;

          // The storage guard refused the claim after the exit committed. The
          // typed application error is not what crosses the wire here; the
          // driver error from the trigger is the authoritative refusal.
          expect(outcome.refused).toBe(true);
          expect(isPrerequisiteRefusal(outcome.error)).toBe(true);
          expect(outcome.error).not.toBeInstanceOf(
            TaskPrerequisiteIncompleteError,
          );
          expect((outcome.error as Error).message).toContain(
            "task has incomplete prerequisites",
          );

          // Consistency: the refused claim left no trace. The run stays
          // queued with only its schedule-time event, no audit was written,
          // the execution-history marker is unchanged, and the only task lock
          // is the schedule-time lease still owned by the queued run (a
          // refused claim never reaches execution, so nothing releases it).
          expect((await f.runtime.findRun(runId))?.snapshot().status).toBe(
            "queued",
          );
          expect(
            (await f.runtime.listRunEvents(runId)).map((event) => event.status),
          ).toEqual(["queued"]);
          expect(
            await db.client.query(
              "SELECT id FROM core.audit_event WHERE project_id = $1",
              [f.projectId],
            ),
          ).toEqual([]);
          expect(
            await db.client.query(
              "SELECT state, first_known_at FROM core.task_execution_history WHERE task_id = $1",
              [f.dependentId],
            ),
          ).toEqual(historyBefore);
          expect(
            await db.client.query(
              "SELECT run_id FROM core.task_lock WHERE task_id = $1",
              [f.dependentId],
            ),
          ).toEqual([{ run_id: runId }]);

          // Recoverability: with the prerequisite back in review the next
          // tick re-claims the same queued run and executes it to completion.
          await setTaskStatus(
            f.prerequisiteId,
            "waiting_review",
            new Date(epoch.getTime() + 2),
          );
          const reclaimed = await f.runtime.findRun(runId);
          const admitted = await f.admission.execute(reclaimed!);
          expect(admitted?.snapshot().status).toBe("preparing");
          const result = await f.execute.execute(admitted!);
          expect(result.status).toBe("completed");
          expect(
            (await f.runtime.listRunEvents(runId)).map((event) => event.status),
          ).toEqual([
            "queued",
            "preparing",
            "running",
            "reviewing",
            "completed",
          ]);
          expect(await f.runtime.findTaskLock(f.dependentId)).toBeNull();
        } finally {
          release();
          await mutationDone.catch(() => undefined);
          await observer.close();
          await mutation.close();
        }
      },
    );

    test("holds pipeline stage completion until prerequisites complete", async () => {
      const f = await seedOffice();
      await seedDeliveryManifest(f);
      const started = await f.pipelineManager.start({
        projectId: f.projectId,
        taskId: f.dependentId,
        pipelineId: "delivery",
        principal: localOperatorPrincipal,
      });
      const pipelineRunId = started.snapshot().id;
      await f.pipelineManager.assign({
        projectId: f.projectId,
        pipelineRunId,
        agentId: f.agent.id,
        principal: localOperatorPrincipal,
      });
      const runId = await f.scheduler.execute({
        projectId: f.projectId,
        taskId: f.dependentId,
        agentId: f.agent.id,
      });
      const queued = await f.runtime.listQueuedRuns(f.projectId, 1);
      expect(queued.map((run) => run.snapshot().id)).toEqual([runId]);
      const claimed = await f.admission.execute(queued[0]!);
      expect(claimed?.snapshot().status).toBe("preparing");
      expect(claimed?.snapshot().pipelineRunId).toBe(pipelineRunId);
      const result = await f.execute.execute(claimed!);
      expect(result.status).toBe("completed");

      // The run finished, but the final stage cannot close while the
      // prerequisite is still in review: the completion requirement is
      // stricter than the start requirement. The typed refusal rolls back the
      // whole stage-completion transaction, matching the
      // STAGE_AWAITING_PREREQUISITES branch of run:tick.
      const auditBefore = await db.client.query(
        "SELECT event_type FROM core.audit_event WHERE project_id = $1 ORDER BY occurred_at, id",
        [f.projectId],
      );
      const refusal = await f.pipelineManager
        .completeStageFromAgentRun({
          projectId: f.projectId,
          agentRunId: runId,
          expectedPipelineRunId: pipelineRunId,
        })
        .then(
          () => ({ refused: false, error: undefined as unknown }),
          (error: unknown) => ({ refused: true, error }),
        );
      expect(refusal.refused).toBe(true);
      expect(refusal.error).toBeInstanceOf(TaskPrerequisiteIncompleteError);
      expect(isPrerequisiteRefusal(refusal.error)).toBe(true);
      expect(
        (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
          .status,
      ).toBe("active");
      expect((await f.runtime.findRun(runId))?.snapshot().status).toBe(
        "completed",
      );
      expect(
        await db.client.query("SELECT status FROM core.task WHERE id = $1", [
          f.dependentId,
        ]),
      ).toEqual([{ status: "running" }]);
      expect(
        await db.client.query(
          "SELECT event_type FROM core.audit_event WHERE project_id = $1 ORDER BY occurred_at, id",
          [f.projectId],
        ),
      ).toEqual(auditBefore);

      // Recoverability: once the prerequisite completes, the same
      // stage-completion call closes the stage, the pipeline and the task.
      await setTaskStatus(
        f.prerequisiteId,
        "completed",
        new Date(epoch.getTime() + 1),
      );
      const completed = await f.pipelineManager.completeStageFromAgentRun({
        projectId: f.projectId,
        agentRunId: runId,
        expectedPipelineRunId: pipelineRunId,
      });
      expect(completed.snapshot().status).toBe("completed");
      expect(
        await db.client.query("SELECT status FROM core.task WHERE id = $1", [
          f.dependentId,
        ]),
      ).toEqual([{ status: "completed" }]);
    });

    test(
      "run:tick command tolerates the prerequisite-exit race and retries cleanly",
      { timeout: 30_000 },
      async () => {
        const f = await seedOffice();
        const runId = await f.scheduler.execute({
          projectId: f.projectId,
          taskId: f.dependentId,
          agentId: f.agent.id,
        });
        await extendTaskLease(f.dependentId);
        const handler = await composeHandler(f);

        const mutation = new PostgresClient(db.connectionString);
        const observer = new PostgresClient(db.connectionString);
        let release!: () => void;
        let locked!: () => void;
        const lockAcquired = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const releaseGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const mutationDone = mutation.transaction(async () => {
          await mutation.query(
            "UPDATE core.task SET status = 'failed', updated_at = $2 WHERE id = $1",
            [f.prerequisiteId, new Date(epoch.getTime() + 1)],
          );
          locked();
          await releaseGate;
        });
        try {
          await lockAcquired;
          // The command-level claim blocks on the advisory lock held by the
          // exit transaction; the handler must tolerate the storage refusal.
          const tick = handler.run([
            "run:tick",
            "--project",
            f.projectId,
            "--simulate",
            "--json",
          ]);
          tick.catch(() => undefined);
          for (let attempt = 0; attempt < 1000; attempt += 1) {
            const [row] = await observer.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE datname = current_database()
                 AND wait_event_type = 'Lock' AND state = 'active'`,
            );
            if ((row?.count ?? 0) > 0) break;
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (attempt === 999)
              throw new Error("claim did not reach the dependency-gate lock");
          }
          release();
          const refused = await tick;
          await mutationDone;

          // The refused run is skipped, not failed: exit 0, empty results,
          // nothing on stderr, and the execution-control reservation is
          // released even though the claim raced the refusal. No pipeline is
          // suspended in this scenario, so the recovery sweep is empty.
          expect(refused.code).toBe(0);
          expect(refused.stderr).toEqual([]);
          expect(JSON.parse(refused.stdout.join("\n"))).toEqual({
            schemaVersion: 1,
            results: [],
            unsuccessful: 0,
            pipelineRecoveries: [],
          });
          expect(handler.executionControl.has(runId)).toBe(false);
          expect((await f.runtime.findRun(runId))?.snapshot().status).toBe(
            "queued",
          );
          expect(
            (await f.runtime.listRunEvents(runId)).map((event) => event.status),
          ).toEqual(["queued"]);

          // Retry: once the prerequisite is back in review, the next tick
          // re-claims the same queued run and executes it to completion.
          await setTaskStatus(
            f.prerequisiteId,
            "waiting_review",
            new Date(epoch.getTime() + 2),
          );
          const retry = await handler.run([
            "run:tick",
            "--project",
            f.projectId,
            "--simulate",
            "--json",
          ]);
          expect(retry.code).toBe(0);
          expect(retry.stderr).toEqual([]);
          const report = JSON.parse(retry.stdout.join("\n")) as {
            results: { runId: string; status: string }[];
            unsuccessful: number;
          };
          expect(report.unsuccessful).toBe(0);
          expect(report.results).toEqual([
            expect.objectContaining({ runId, status: "completed" }),
          ]);
          expect(handler.executionControl.has(runId)).toBe(false);
          expect(
            (await f.runtime.listRunEvents(runId)).map((event) => event.status),
          ).toEqual([
            "queued",
            "preparing",
            "running",
            "reviewing",
            "completed",
          ]);
          expect(await f.runtime.findTaskLock(f.dependentId)).toBeNull();
        } finally {
          release();
          await mutationDone.catch(() => undefined);
          await observer.close();
          await mutation.close();
          await handler.close();
        }
      },
    );

    test("run:tick command reports STAGE_AWAITING_PREREQUISITES for a stage-bound run", async () => {
      const f = await seedOffice();
      await seedDeliveryManifest(f);
      const started = await f.pipelineManager.start({
        projectId: f.projectId,
        taskId: f.dependentId,
        pipelineId: "delivery",
        principal: localOperatorPrincipal,
      });
      const pipelineRunId = started.snapshot().id;
      await f.pipelineManager.assign({
        projectId: f.projectId,
        pipelineRunId,
        agentId: f.agent.id,
        principal: localOperatorPrincipal,
      });
      const runId = await f.scheduler.execute({
        projectId: f.projectId,
        taskId: f.dependentId,
        agentId: f.agent.id,
      });
      await extendTaskLease(f.dependentId);
      const handler = await composeHandler(f);
      try {
        // The run completes but the final stage cannot close while the
        // prerequisite is still in review; the command translates the typed
        // refusal into a per-run error instead of failing the batch.
        const tick = await handler.run([
          "run:tick",
          "--project",
          f.projectId,
          "--simulate",
          "--json",
        ]);
        expect(tick.code).toBe(1);
        const report = JSON.parse(tick.stdout.join("\n")) as {
          results: {
            runId: string;
            status: string;
            error?: { code: string; message: string };
          }[];
          unsuccessful: number;
        };
        expect(report.unsuccessful).toBe(1);
        expect(report.results).toEqual([
          expect.objectContaining({
            runId,
            status: "completed",
            error: expect.objectContaining({
              code: "STAGE_AWAITING_PREREQUISITES",
            }),
          }),
        ]);
        expect(handler.executionControl.has(runId)).toBe(false);
        expect(
          (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
            .status,
        ).toBe("active");
        expect(
          await db.client.query("SELECT status FROM core.task WHERE id = $1", [
            f.dependentId,
          ]),
        ).toEqual([{ status: "running" }]);

        // Once the prerequisite completes, the next tick's recovery sweep
        // resumes the suspended pipeline: the stage closes, the pipeline and
        // the task complete, and the resume is reported with its provenance.
        await setTaskStatus(
          f.prerequisiteId,
          "completed",
          new Date(epoch.getTime() + 1),
        );
        const resumedTick = await handler.run([
          "run:tick",
          "--project",
          f.projectId,
          "--simulate",
          "--json",
        ]);
        expect(resumedTick.code).toBe(0);
        const resumedReport = JSON.parse(resumedTick.stdout.join("\n")) as {
          pipelineRecoveries: {
            pipelineRunId: string;
            outcome: string;
          }[];
        };
        expect(resumedReport.pipelineRecoveries).toEqual([
          expect.objectContaining({ pipelineRunId, outcome: "resumed" }),
        ]);
        expect(
          (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
            .status,
        ).toBe("completed");
        expect(
          await db.client.query("SELECT status FROM core.task WHERE id = $1", [
            f.dependentId,
          ]),
        ).toEqual([{ status: "completed" }]);

        // A repeated tick finds nothing to resume.
        const idleTick = await handler.run([
          "run:tick",
          "--project",
          f.projectId,
          "--simulate",
          "--json",
        ]);
        expect(idleTick.code).toBe(0);
        expect(
          (
            JSON.parse(idleTick.stdout.join("\n")) as {
              pipelineRecoveries: unknown[];
            }
          ).pipelineRecoveries,
        ).toEqual([]);
      } finally {
        await handler.close();
      }
    });

    // RRD-01: the recovery service resumes the suspended artifact once the
    // last prerequisite completes — exactly once, with provenance, and
    // serialized against concurrent triggers by the project advisory lock.
    async function seedSuspendedPipeline(f: Awaited<ReturnType<typeof seedOffice>>) {
      await seedDeliveryManifest(f);
      const started = await f.pipelineManager.start({
        projectId: f.projectId,
        taskId: f.dependentId,
        pipelineId: "delivery",
        principal: localOperatorPrincipal,
      });
      const pipelineRunId = started.snapshot().id;
      await f.pipelineManager.assign({
        projectId: f.projectId,
        pipelineRunId,
        agentId: f.agent.id,
        principal: localOperatorPrincipal,
      });
      const runId = await f.scheduler.execute({
        projectId: f.projectId,
        taskId: f.dependentId,
        agentId: f.agent.id,
      });
      const claimed = await f.admission.execute(
        (await f.runtime.listQueuedRuns(f.projectId, 1))[0]!,
      );
      const result = await f.execute.execute(claimed!);
      expect(result.status).toBe("completed");
      // Sanity: the stage-completion refusal leaves the suspended artifact.
      expect(
        (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
          .status,
      ).toBe("active");
      return { pipelineRunId, runId };
    }

    function recoveryOn(f: Awaited<ReturnType<typeof seedOffice>>) {
      return new RecoverSuspendedPipelines(
        f.pipelines,
        f.runtime,
        f.tasks,
        f.dependencies,
        f.pipelineManager,
      );
    }

    test("recovery resumes a suspended pipeline exactly once, with provenance", async () => {
      const f = await seedOffice();
      const { pipelineRunId, runId } = await seedSuspendedPipeline(f);
      const recovery = recoveryOn(f);

      // While the prerequisite is still in review the sweep is a quiet no-op.
      const waiting = await recovery.execute({
        projectId: f.projectId,
        trigger: "tick",
      });
      expect(waiting.recoveries).toEqual([
        expect.objectContaining({
          pipelineRunId,
          outcome: "awaiting_prerequisites",
        }),
      ]);

      await setTaskStatus(
        f.prerequisiteId,
        "completed",
        new Date(epoch.getTime() + 1),
      );
      const resumed = await recovery.execute({
        projectId: f.projectId,
        trigger: "task_completion",
        triggerTaskId: f.prerequisiteId,
      });
      expect(resumed.recoveries).toEqual([
        expect.objectContaining({ pipelineRunId, outcome: "resumed" }),
      ]);
      expect(
        (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
          .status,
      ).toBe("completed");
      expect(
        await db.client.query("SELECT status FROM core.task WHERE id = $1", [
          f.dependentId,
        ]),
      ).toEqual([{ status: "completed" }]);

      // Provenance: one pipeline.resumed event links the resume to the
      // completion that caused it, with the authoritative prerequisite list.
      const events = await db.client.query<{
        actor_type: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT actor_type, payload_json AS payload FROM core.audit_event WHERE project_id = $1 AND event_type = 'pipeline.resumed'",
        [f.projectId],
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.actor_type).toBe("system");
      expect(events[0]!.payload).toMatchObject({
        agentRunId: runId,
        trigger: "task_completion",
        triggerTaskId: f.prerequisiteId,
        prerequisiteTaskIds: [f.prerequisiteId],
      });
      // No duplicate execution evidence for the resumed run.
      expect(
        (await f.runtime.listRunEvents(runId)).map((event) => event.status),
      ).toEqual(["queued", "preparing", "running", "reviewing", "completed"]);

      // Repeated triggers are no-ops: no candidate, no second audit record.
      const again = await recovery.execute({
        projectId: f.projectId,
        trigger: "tick",
      });
      expect(again.recoveries).toEqual([]);
      expect(
        await db.client.query(
          "SELECT id FROM core.audit_event WHERE project_id = $1 AND event_type = 'pipeline.resumed'",
          [f.projectId],
        ),
      ).toHaveLength(1);
    });

    test("concurrent recovery triggers resume once under the advisory lock", async () => {
      const f = await seedOffice();
      const { pipelineRunId } = await seedSuspendedPipeline(f);
      await setTaskStatus(
        f.prerequisiteId,
        "completed",
        new Date(epoch.getTime() + 1),
      );

      // A second, independent recovery pipeline on its own connection, so the
      // two triggers genuinely race on the same project state.
      const other = new PostgresClient(db.connectionString);
      try {
        const otherRecovery = new RecoverSuspendedPipelines(
          new PostgresPipelineRunRepository(other, f.tenantId),
          new PostgresAgentRuntimeRepository(other, f.tenantId),
          new PostgresTaskRepository(other, f.tenantId),
          new PostgresTaskDependencyRepository(other, f.tenantId),
          new ManagePipelineRuns(
            new PostgresOfficeManifestRepository(other, f.tenantId),
            new PostgresPipelineRunRepository(other, f.tenantId),
            new PostgresTaskRepository(other, f.tenantId),
            new PostgresAgentRuntimeRepository(other, f.tenantId),
            new RecordAuditEvent(
              new PostgresAuditEventRepository(other, f.tenantId),
              ids,
              clock,
            ),
            ids,
            clock,
            new PostgresTransactionRunner(other),
            undefined,
            new PostgresTaskDependencyRepository(other, f.tenantId),
          ),
        );

        const [first, second] = await Promise.all([
          recoveryOn(f).execute({ projectId: f.projectId, trigger: "tick" }),
          otherRecovery.execute({
            projectId: f.projectId,
            trigger: "task_completion",
            triggerTaskId: f.prerequisiteId,
          }),
        ]);

        const outcomes = [...first.recoveries, ...second.recoveries].map(
          (entry) => entry.outcome,
        );
        expect(
          outcomes.filter((outcome) => outcome === "resumed"),
        ).toHaveLength(1);
        expect(
          (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
            .status,
        ).toBe("completed");
        expect(
          await db.client.query(
            "SELECT id FROM core.audit_event WHERE project_id = $1 AND event_type = 'pipeline.resumed'",
            [f.projectId],
          ),
        ).toHaveLength(1);
      } finally {
        await other.close();
      }
    });

    test("a prerequisite that regresses before resume keeps the pipeline suspended", async () => {
      const f = await seedOffice();
      const { pipelineRunId } = await seedSuspendedPipeline(f);
      const recovery = recoveryOn(f);

      await setTaskStatus(
        f.prerequisiteId,
        "completed",
        new Date(epoch.getTime() + 1),
      );
      // The regression: the prerequisite is reopened before any recovery runs.
      await setTaskStatus(
        f.prerequisiteId,
        "waiting_review",
        new Date(epoch.getTime() + 2),
      );

      const result = await recovery.execute({
        projectId: f.projectId,
        trigger: "tick",
      });
      expect(result.recoveries).toEqual([
        expect.objectContaining({
          pipelineRunId,
          outcome: "awaiting_prerequisites",
        }),
      ]);
      expect(
        (await f.pipelines.findById(pipelineRunId, f.projectId))?.snapshot()
          .status,
      ).toBe("active");
      expect(
        await db.client.query("SELECT status FROM core.task WHERE id = $1", [
          f.dependentId,
        ]),
      ).toEqual([{ status: "running" }]);
    });
  },
);

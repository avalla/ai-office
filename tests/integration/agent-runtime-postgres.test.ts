import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = "supabase/migrations";
const now = new Date("2026-09-22T10:00:00.000Z");

describe.skipIf(connectionString === undefined)(
  "PostgreSQL AgentRuntime authority",
  () => {
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
    });

    afterAll(async () => {
      await database.close();
    });

    async function fixture() {
      const suffix = randomUUID();
      const tenantId = `runtime-tenant-${suffix}`;
      const projectId = `runtime-project-${suffix}`;
      const taskId = `runtime-task-${suffix}`;
      const roleId = `runtime-role-${suffix}`;
      const agentId = `runtime-agent-${suffix}`;
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [tenantId, tenantId, now],
      );
      const projects = new PostgresProjectRepository(database, tenantId);
      const tasks = new PostgresTaskRepository(database, tenantId);
      const runtime = new PostgresAgentRuntimeRepository(database, tenantId);
      const auditEvents = new PostgresAuditEventRepository(database, tenantId);
      const project = Project.create({ id: projectId, name: projectId, now });
      const task = Task.create({
        id: taskId,
        projectId,
        title: "Runtime task",
        now,
      });
      const role = Role.create({
        id: roleId,
        projectId,
        key: "developer",
        name: "Developer",
        version: 1,
        capabilities: ["read"],
        tools: ["test"],
        modelPolicy: "mock",
        limits: { maxIterations: 3, maxCostMicros: 5000n, timeoutSeconds: 60 },
        sourcePath: "roles/developer.yaml",
        guidanceText: "Be precise.",
        guidanceVersion: 2,
        now,
      });
      const agent = {
        id: agentId,
        projectId,
        roleId,
        name: "Developer",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      await projects.save(project);
      await tasks.save(task);
      await runtime.saveRole(role);
      await runtime.saveAgent(agent);
      return {
        tenantId,
        projectId,
        task,
        tasks,
        role,
        agent,
        runtime,
        auditEvents,
      };
    }

    test("round-trips roles, agents, runs and append-only events", async () => {
      const f = await fixture();
      const run = AgentRun.create({
        id: `runtime-run-${randomUUID()}`,
        projectId: f.projectId,
        taskId: f.task.snapshot().id,
        agentId: f.agent.id,
        modelRouting: { status: "unrouted" },
        roleGuidance: { version: 2, text: "Be precise." },
        now,
      });
      await f.runtime.saveRun(run);
      expect(
        (
          await f.runtime.findRole(f.role.snapshot().id, f.projectId)
        )?.snapshot(),
      ).toMatchObject({
        id: f.role.snapshot().id,
        projectId: f.projectId,
        key: "developer",
        name: "Developer",
        version: 1,
        capabilities: ["read"],
        tools: ["test"],
        modelPolicy: "mock",
        limits: f.role.snapshot().limits,
        sourcePath: "roles/developer.yaml",
        guidanceText: "Be precise.",
        guidanceVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
      expect(await f.runtime.findAgent(f.agent.id)).toEqual(f.agent);
      expect((await f.runtime.findRun(run.snapshot().id))?.snapshot()).toEqual(
        run.snapshot(),
      );
      expect(
        (await f.runtime.listRunEvents(run.snapshot().id)).map(
          (event) => event.status,
        ),
      ).toEqual(["queued"]);
      await f.runtime.saveRun(run);
      expect(
        (await f.runtime.listRunEvents(run.snapshot().id)).map(
          (event) => event.status,
        ),
      ).toEqual(["queued"]);
    });

    test("keeps identity-only governance rows out of runtime reads", async () => {
      const f = await fixture();
      const id = `identity-only-${randomUUID()}`;
      await database.query(
        "INSERT INTO core.agent_run(id, project_id) VALUES ($1, $2)",
        [id, f.projectId],
      );
      expect(await f.runtime.findRun(id)).toBeNull();
      expect(await f.runtime.listRuns(f.projectId)).toEqual([]);
    });

    test("enforces tenant scope for reads, references and audit append", async () => {
      const f = await fixture();
      const foreignTenant = `foreign-tenant-${randomUUID()}`;
      const foreignProject = `foreign-project-${randomUUID()}`;
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [foreignTenant, foreignTenant, now],
      );
      await database.query(
        "INSERT INTO core.project(id, name, tenant_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        [foreignProject, foreignProject, foreignTenant, now],
      );
      expect(
        await f.runtime.findRole(f.role.snapshot().id, foreignProject),
      ).toBeNull();
      expect(await f.runtime.listAgents(foreignProject)).toEqual([]);
      await expect(
        f.auditEvents.append(
          AuditEvent.create({
            id: `foreign-audit-${randomUUID()}`,
            eventType: "foreign.event",
            actorType: "system",
            projectId: foreignProject,
            payload: {},
            occurredAt: now,
          }),
        ),
      ).rejects.toThrow("outside the PostgreSQL tenant context");
    });

    test("has one real concurrent task-lock winner and owner-only renewal/release", async () => {
      const f = await fixture();
      const runA = AgentRun.create({
        id: `lock-a-${randomUUID()}`,
        projectId: f.projectId,
        taskId: f.task.snapshot().id,
        agentId: f.agent.id,
        now,
      });
      const runB = AgentRun.create({
        id: `lock-b-${randomUUID()}`,
        projectId: f.projectId,
        taskId: f.task.snapshot().id,
        agentId: f.agent.id,
        now,
      });
      await f.runtime.saveRun(runA);
      await f.runtime.saveRun(runB);
      const expires = new Date(now.getTime() + 10_000);
      const winners = await Promise.all([
        f.runtime.acquireTaskLock(
          f.task.snapshot().id,
          runA.snapshot().id,
          now,
          expires,
        ),
        f.runtime.acquireTaskLock(
          f.task.snapshot().id,
          runB.snapshot().id,
          now,
          expires,
        ),
      ]);
      expect(winners.filter(Boolean)).toHaveLength(1);
      const winner = (await f.runtime.findTaskLock(f.task.snapshot().id))
        ?.runId;
      expect([runA.snapshot().id, runB.snapshot().id]).toContain(winner);
      const loser =
        winner === runA.snapshot().id ? runB.snapshot().id : runA.snapshot().id;
      expect(
        await f.runtime.renewTaskLock(
          loser,
          now,
          new Date(now.getTime() + 20_000),
        ),
      ).toBe(false);
      expect(await f.runtime.releaseTaskLock(loser)).toBe(false);
      expect(await f.runtime.releaseTaskLock(winner!)).toBe(true);
    });

    test("admits a queued run through an atomic concurrent CAS", async () => {
      const f = await fixture();
      const run = AgentRun.create({
        id: `admit-${randomUUID()}`,
        projectId: f.projectId,
        taskId: f.task.snapshot().id,
        agentId: f.agent.id,
        now,
      });
      await f.runtime.saveRun(run);
      await f.runtime.acquireTaskLock(
        f.task.snapshot().id,
        run.snapshot().id,
        now,
        new Date(now.getTime() + 10_000),
      );
      const authority = {
        taskStatus: f.task.snapshot().status,
        taskUpdatedAt: f.task.snapshot().updatedAt,
        agentRoleId: f.agent.roleId,
        agentUpdatedAt: f.agent.updatedAt,
        pipelineId: null,
        pipelineStageRunId: null,
        pipelineVersion: null,
      };
      const [first, second] = await Promise.all([
        f.runtime.admitQueuedRun({ runId: run.snapshot().id, now, authority }),
        f.runtime.admitQueuedRun({ runId: run.snapshot().id, now, authority }),
      ]);
      expect([first, second].filter((value) => value !== null)).toHaveLength(1);
      expect(
        [first, second].filter(
          (value) => value?.snapshot().status === "preparing",
        ),
      ).toHaveLength(1);
      expect(
        (await f.runtime.listRunEvents(run.snapshot().id)).map(
          (event) => event.status,
        ),
      ).toEqual(["queued", "preparing"]);
    });

    test("rejects stale task, agent, role, and pipeline fences", async () => {
      const prepare = async (withPipeline = false) => {
        const f = await fixture();
        const pipelineId = `pipeline-${randomUUID()}`;
        const stageRunId = `stage-${randomUUID()}`;
        const pipeline = withPipeline
          ? {
              id: pipelineId,
              stageRunId,
              version: 1,
              currentStageIndex: 0,
              stageId: "stage-0",
              stageRoleId: f.role.snapshot().key,
              assignedAgentId: f.agent.id,
            }
          : null;
        if (pipeline !== null) {
          await database.query(
            `INSERT INTO core.pipeline_run(
               id, project_id, task_id, status, current_stage_index, version,
               created_at, updated_at
             ) VALUES ($1, $2, $3, 'active', 0, 1, $4, $4)`,
            [pipeline.id, f.projectId, f.task.snapshot().id, now],
          );
          await database.query(
            `INSERT INTO core.pipeline_stage_run(
               id, pipeline_run_id, project_id, stage_id, stage_index, role_id,
               status, assigned_agent_id
             ) VALUES ($1, $2, $3, $4, 0, $5, 'active', $6)`,
            [
              pipeline.stageRunId,
              pipeline.id,
              f.projectId,
              pipeline.stageId,
              pipeline.stageRoleId,
              pipeline.assignedAgentId,
            ],
          );
        }
        const queued = AgentRun.create({
          id: `fenced-${randomUUID()}`,
          projectId: f.projectId,
          taskId: f.task.snapshot().id,
          agentId: f.agent.id,
          ...(pipeline === null
            ? {}
            : {
                pipelineRunId: pipeline.id,
                pipelineStageRunId: pipeline.stageRunId,
              }),
          now,
        });
        await f.runtime.saveRun(queued);
        await f.runtime.acquireTaskLock(
          f.task.snapshot().id,
          queued.snapshot().id,
          now,
          new Date(now.getTime() + 10_000),
        );
        const preparing = await f.runtime.findRun(queued.snapshot().id);
        preparing!.transition("preparing", now);
        await f.runtime.saveRun(preparing!);
        const running = await f.runtime.findRun(queued.snapshot().id);
        const execution = {
          kind: "worker" as const,
          adapterId: "worker.test",
          adapterVersion: "1",
          inputHash: "b".repeat(64),
        };
        running!.transition("running", now, { execution });
        await f.runtime.saveRun(running!);
        const role = f.role.snapshot();
        const task = f.task.snapshot();
        return {
          f,
          run: await f.runtime.findRun(queued.snapshot().id),
          result: { summary: "done", artifacts: [] },
          fence: {
            runId: queued.snapshot().id,
            projectId: f.projectId,
            taskId: task.id,
            taskStatus: task.status,
            taskUpdatedAt: task.updatedAt,
            agentId: f.agent.id,
            agentRoleId: f.agent.roleId,
            agentUpdatedAt: f.agent.updatedAt,
            roleId: role.id,
            roleKey: role.key,
            roleVersion: role.version,
            roleLimits: { ...role.limits },
            roleUpdatedAt: role.updatedAt,
            pipeline,
            execution,
          },
        };
      };

      const taskChanged = await prepare();
      await taskChanged.f.tasks.save(
        Task.restore({
          ...taskChanged.f.task.snapshot(),
          status: "running",
          updatedAt: new Date(now.getTime() + 1),
        }),
      );
      expect(
        await taskChanged.f.runtime.acceptWorkerResult({
          fence: taskChanged.fence,
          run: taskChanged.run!,
          result: taskChanged.result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
      ).toBe(false);

      const agentChanged = await prepare();
      await agentChanged.f.runtime.saveAgent({
        ...agentChanged.f.agent,
        updatedAt: new Date(now.getTime() + 1),
      });
      expect(
        await agentChanged.f.runtime.acceptWorkerResult({
          fence: agentChanged.fence,
          run: agentChanged.run!,
          result: agentChanged.result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
      ).toBe(false);

      const roleChanged = await prepare();
      await roleChanged.f.runtime.saveRole(
        Role.create({
          ...roleChanged.f.role.snapshot(),
          version: 2,
          now: new Date(now.getTime() + 1),
        }),
      );
      expect(
        await roleChanged.f.runtime.acceptWorkerResult({
          fence: roleChanged.fence,
          run: roleChanged.run!,
          result: roleChanged.result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
      ).toBe(false);

      const pipelineAdvanced = await prepare(true);
      await database.query(
        "UPDATE core.pipeline_run SET current_stage_index = 1, version = 2, updated_at = $2 WHERE id = $1",
        [pipelineAdvanced.fence.pipeline!.id, new Date(now.getTime() + 1)],
      );
      expect(
        await pipelineAdvanced.f.runtime.acceptWorkerResult({
          fence: pipelineAdvanced.fence,
          run: pipelineAdvanced.run!,
          result: pipelineAdvanced.result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
      ).toBe(false);

      const assignmentChanged = await prepare(true);
      await database.query(
        "UPDATE core.pipeline_stage_run SET assigned_agent_id = NULL WHERE id = $1",
        [assignmentChanged.fence.pipeline!.stageRunId],
      );
      expect(
        await assignmentChanged.f.runtime.acceptWorkerResult({
          fence: assignmentChanged.fence,
          run: assignmentChanged.run!,
          result: assignmentChanged.result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
      ).toBe(false);
    });

    test("accepts exactly one concurrent worker result only with the complete fence", async () => {
      const f = await fixture();
      const queued = AgentRun.create({
        id: `accept-${randomUUID()}`,
        projectId: f.projectId,
        taskId: f.task.snapshot().id,
        agentId: f.agent.id,
        now,
      });
      await f.runtime.saveRun(queued);
      await f.runtime.acquireTaskLock(
        f.task.snapshot().id,
        queued.snapshot().id,
        now,
        new Date(now.getTime() + 10_000),
      );
      const preparing = await f.runtime.findRun(queued.snapshot().id);
      preparing!.transition("preparing", now);
      await f.runtime.saveRun(preparing!);
      const running = await f.runtime.findRun(queued.snapshot().id);
      const execution = {
        kind: "worker" as const,
        adapterId: "worker.test",
        adapterVersion: "1",
        inputHash: "a".repeat(64),
      };
      running!.transition("running", now, { execution });
      await f.runtime.saveRun(running!);
      const runForFence = await f.runtime.findRun(queued.snapshot().id);
      const role = f.role.snapshot();
      const task = f.task.snapshot();
      const fence = {
        runId: queued.snapshot().id,
        projectId: f.projectId,
        taskId: task.id,
        taskStatus: task.status,
        taskUpdatedAt: task.updatedAt,
        agentId: f.agent.id,
        agentRoleId: f.agent.roleId,
        agentUpdatedAt: f.agent.updatedAt,
        roleId: role.id,
        roleKey: role.key,
        roleVersion: role.version,
        roleLimits: { ...role.limits },
        roleUpdatedAt: role.updatedAt,
        pipeline: null,
        execution,
      };
      const result = { summary: "done", artifacts: [] };
      const [first, second] = await Promise.all([
        f.runtime.acceptWorkerResult({
          fence,
          run: runForFence!,
          result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
        f.runtime.acceptWorkerResult({
          fence,
          run: runForFence!,
          result,
          acceptedAt: new Date(now.getTime() + 1000),
        }),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(
        (await f.runtime.findRun(queued.snapshot().id))?.snapshot().status,
      ).toBe("reviewing");
      expect(
        (await f.runtime.listRunEvents(queued.snapshot().id)).map(
          (event) => event.status,
        ),
      ).toEqual(["queued", "preparing", "running", "reviewing"]);
    });

    test("rolls back runtime and audit writes in one external transaction", async () => {
      const f = await fixture();
      const role = Role.create({
        id: `rollback-role-${randomUUID()}`,
        projectId: f.projectId,
        key: "rollback",
        name: "Rollback",
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "mock",
        limits: { maxIterations: 1, maxCostMicros: 1n, timeoutSeconds: 1 },
        sourcePath: "rollback.yaml",
        now,
      });
      const auditId = `rollback-audit-${randomUUID()}`;
      const transactions = new PostgresTransactionRunner(database);
      await expect(
        transactions.run(async () => {
          await f.runtime.saveRole(role);
          await f.auditEvents.append(
            AuditEvent.create({
              id: auditId,
              eventType: "rollback.event",
              actorType: "system",
              projectId: f.projectId,
              payload: {},
              occurredAt: now,
            }),
          );
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        await f.runtime.findRole(role.snapshot().id, f.projectId),
      ).toBeNull();
      expect(
        await database.query("SELECT id FROM core.audit_event WHERE id = $1", [
          auditId,
        ]),
      ).toEqual([]);
    });

    test("keeps reviewed agent_run ownership immutable", async () => {
      const f = await fixture();
      const otherProject = `review-project-${randomUUID()}`;
      await database.query(
        "INSERT INTO core.project(id, name, tenant_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        [otherProject, otherProject, f.tenantId, now],
      );
      const run = AgentRun.create({
        id: `reviewed-${randomUUID()}`,
        projectId: f.projectId,
        taskId: f.task.snapshot().id,
        agentId: f.agent.id,
        now,
      });
      await f.runtime.saveRun(run);
      await database.query(
        "INSERT INTO core.review(id, project_id, subject_type, subject_id, reviewer_actor_type, reviewer_actor_id, status, created_at) VALUES ($1, $2, 'agent_run', $3, 'user', 'reviewer', 'pending', $4)",
        [`review-${randomUUID()}`, f.projectId, run.snapshot().id, now],
      );
      await expect(
        database.query(
          "UPDATE core.agent_run SET project_id = $1 WHERE id = $2",
          [otherProject, run.snapshot().id],
        ),
      ).rejects.toThrow();
    });
  },
);

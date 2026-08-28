import { afterEach, describe, expect, test } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteControlledExecutionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-controlled-execution.repository.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { EvaluatePipelineAuthorization } from "@ai-office/application/pipeline/evaluate-pipeline-authorization.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { InvokeControlledConnectorAction } from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { StaleActionAuthorizationError } from "@ai-office/application/capability-errors.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { OperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import { AgentRunProvenanceError } from "@ai-office/application/pipeline-errors.ts";

const roots: string[] = [];
const now = new Date("2026-08-28T10:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class SequenceIds implements IdGenerator {
  private next = 0;
  generate(): string {
    this.next += 1;
    return `generated-${this.next}`;
  }
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Enforce delivery",
    goals: ["Ship safely"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Enforced office",
    roles: [
      {
        id: "architect",
        title: "Architect",
        purpose: "Design",
        responsibilities: ["Design"],
      },
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
      {
        id: "reviewer",
        title: "Reviewer",
        purpose: "Review",
        responsibilities: ["Review"],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Enforced delivery",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "architecture",
          name: "Architecture",
          roleId: "architect",
          objective: "Design",
          checks: ["Approved design"],
          requiresApproval: false,
          capabilities: ["fake.read", "fake.admin"],
        },
        {
          id: "implementation",
          name: "Implementation",
          roleId: "developer",
          objective: "Build",
          checks: ["Tests pass"],
          requiresApproval: false,
          capabilities: ["fake.read", "fake.write"],
        },
        {
          id: "review",
          name: "Review",
          roleId: "reviewer",
          objective: "Review",
          checks: ["Review approved"],
          requiresApproval: true,
          requiresIndependentApproval: true,
          capabilities: ["fake.read"],
          requiresDifferentAgentFrom: ["implementation"],
        },
        {
          id: "merge",
          name: "Merge",
          roleId: "developer",
          objective: "Merge",
          checks: ["All gates complete"],
          requiresApproval: false,
          capabilities: ["fake.delete"],
          requiresDifferentAgentFrom: ["review"],
        },
      ],
    },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-pipeline-"));
  roots.push(root);
  const path = join(root, "project.sqlite");
  const database = openDatabase(path);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const capabilities = new SqliteCapabilityPolicyRepository(database);
  const clock = new FixedClock();
  const ids = new SequenceIds();
  const transactions = new SqliteTransactionRunner(database);
  const audit = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    ids,
    clock,
  );

  await projects.save(Project.create({ id: "project", name: "Project", now }));
  await tasks.save(
    Task.create({ id: "task", projectId: "project", title: "Feature", now }),
  );
  await manifests.save({
    id: "manifest-1",
    projectId: "project",
    revision: 1,
    manifest,
    appliedAt: now,
  });
  for (const key of ["architect", "developer", "reviewer"] as const) {
    await runtime.saveRole(
      Role.create({
        id: `role-${key}`,
        projectId: "project",
        key,
        name: key,
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "default",
        limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
        sourcePath: `${key}.yaml`,
        now,
      }),
    );
  }
  const agents: Agent[] = [
    {
      id: "architect-agent",
      projectId: "project",
      roleId: "role-architect",
      name: "Architect",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "developer-agent",
      projectId: "project",
      roleId: "role-developer",
      name: "Developer",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "reviewer-agent",
      projectId: "project",
      roleId: "role-reviewer",
      name: "Reviewer",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
  for (const agent of agents) await runtime.saveAgent(agent);
  database
    .prepare(
      `INSERT INTO resources(
       id, project_id, type, provider, external_ref, display_name,
       configuration_json, credential_ref, status, created_at, updated_at
     ) VALUES ('resource', 'project', 'filesystem_scope', 'fake', NULL,
       'Fake resource', '{}', NULL, 'active', ?, ?)`,
    )
    .run(now.toISOString(), now.toISOString());
  database
    .prepare(
      `INSERT INTO capability_grants(
       id, project_id, principal_type, principal_id, resource_id, actions_json,
       constraints_json, valid_from, expires_at, revoked_at, granted_by, reason, created_at
     ) VALUES ('grant', 'project', 'role', 'role-architect', 'resource', ?,
       '{}', ?, NULL, NULL, 'operator', 'Pipeline test', ?)`,
    )
    .run(
      JSON.stringify(["fake.read", "fake.delete"]),
      now.toISOString(),
      now.toISOString(),
    );

  const manager = new ManagePipelineRuns(
    manifests,
    pipelines,
    tasks,
    runtime,
    audit,
    ids,
    clock,
    transactions,
  );
  return {
    root,
    path,
    database,
    projects,
    tasks,
    runtime,
    pipelines,
    capabilities,
    manager,
    ids,
    clock,
    transactions,
    audit,
  };
}

describe("pipeline enforcement persistence and authorization", () => {
  test("caller labels cannot impersonate operators or switch agent pipeline provenance", async () => {
    const context = await fixture();
    const forged = {
      kind: "operator",
      source: "local_cli",
      id: "operator",
    } as unknown as OperatorPrincipal;
    await expect(
      context.manager.start({
        projectId: "project",
        taskId: "task",
        pipelineId: "delivery",
        principal: forged,
        actorLabel: "operator",
      }),
    ).rejects.toThrow("not authorized");

    const started = await context.manager.start({
      projectId: "project",
      taskId: "task",
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    await context.manager.assign({
      projectId: "project",
      pipelineRunId: started.snapshot().id,
      agentId: "architect-agent",
      principal: localOperatorPrincipal,
    });
    const agentRunId = await new ScheduleAgentRun(
      context.projects,
      context.tasks,
      context.runtime,
      context.ids,
      context.clock,
      context.transactions,
      context.pipelines,
    ).execute({
      projectId: "project",
      taskId: "task",
      agentId: "architect-agent",
      actionIntent: {
        resourceId: "resource",
        operation: "fake.read",
        arguments: {},
      },
    });
    const agentRun = await context.runtime.findRun(agentRunId);
    agentRun!.transition("preparing", now);
    agentRun!.transition("running", now);
    await context.runtime.saveRun(agentRun!);
    const evaluator = new EvaluateActionPolicy(
      context.runtime,
      context.capabilities,
      context.clock,
      createDefaultConnectorRegistry(),
      new EvaluatePipelineAuthorization(context.pipelines),
    );
    await expect(
      new RequestControlledAction(
        evaluator,
        context.capabilities,
        context.audit,
        context.ids,
        context.clock,
        context.transactions,
        context.runtime,
      ).execute({
        projectId: "project",
        agentId: "architect-agent",
        resourceId: "resource",
        operation: "fake.read",
        arguments: {},
        agentRunId,
        pipelineRunId: "another-pipeline",
      }),
    ).rejects.toBeInstanceOf(AgentRunProvenanceError);
  });

  test("rejects half-null pipeline action bindings at the SQLite boundary", async () => {
    const context = await fixture();
    const insert = context.database.prepare(
      `INSERT INTO action_requests(
        id, project_id, agent_id, resource_id, connector, connector_version,
        operation, normalized_arguments_json, effective_constraints_json,
        payload_hash, decision, risk_level, matched_grant_ids_json,
        reasons_json, status, created_at, updated_at,
        pipeline_run_id, pipeline_stage_run_id
      ) VALUES (?, 'project', 'architect-agent', 'resource', 'fake', '1',
        'fake.read', '{}', '{}', ?, 'deny', 'low', '[]', '[]', 'requested', ?, ?, ?, ?)`,
    );
    const values = ["0".repeat(64), now.toISOString(), now.toISOString()];
    expect(() =>
      insert.run("half-null-run", ...values, null, "missing-stage"),
    ).toThrow("action request pipeline binding is inconsistent");
    expect(() =>
      insert.run("half-null-stage", ...values, "missing-run", null),
    ).toThrow("action request pipeline binding is inconsistent");
  });

  test("upgrades an existing project database without deleting historical state", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pipeline-upgrade-"));
    roots.push(root);
    const partial = join(root, "partial");
    mkdirSync(partial);
    const migrations = join(process.cwd(), "migrations", "project");
    for (const file of readdirSync(migrations).sort())
      if (file <= "0019_repository_identity.sql")
        copyFileSync(join(migrations, file), join(partial, file));
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, partial);
    database
      .prepare(
        `INSERT INTO project(id, name, description, created_at, updated_at)
       VALUES ('existing', 'Existing', NULL, ?, ?)`,
      )
      .run(now.toISOString(), now.toISOString());

    expect(migrate(database, migrations).applied).toEqual([
      "0020_pipeline_enforcement.sql",
      "0021_agent_action_provenance.sql",
    ]);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM project WHERE id = 'existing'",
        )
        .get()?.name,
    ).toBe("Existing");
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_run'",
        )
        .get()?.name,
    ).toBe("pipeline_run");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  test("intersects base grants with active stage state and preserves structured denials", async () => {
    const context = await fixture();
    const pipelinePolicy = new EvaluatePipelineAuthorization(context.pipelines);
    const evaluator = new EvaluateActionPolicy(
      context.runtime,
      context.capabilities,
      context.clock,
      createDefaultConnectorRegistry(),
      pipelinePolicy,
    );
    expect(
      (
        await evaluator.execute({
          projectId: "project",
          agentId: "architect-agent",
          resourceId: "resource",
          operation: "fake.read",
          arguments: {},
        })
      ).decision.decision,
    ).toBe("allow");
    const run = await context.manager.start({
      projectId: "project",
      taskId: "task",
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    const runId = run.snapshot().id;

    const unassigned = await evaluator.execute({
      projectId: "project",
      agentId: "architect-agent",
      resourceId: "resource",
      operation: "fake.read",
      arguments: {},
      pipelineRunId: runId,
    });
    expect(unassigned.decision).toMatchObject({
      decision: "deny",
      reasons: expect.arrayContaining(["pipeline_agent_not_assigned"]),
    });

    await context.manager.assign({
      projectId: "project",
      pipelineRunId: runId,
      agentId: "architect-agent",
      principal: localOperatorPrincipal,
    });
    const allowed = await evaluator.execute({
      projectId: "project",
      agentId: "architect-agent",
      resourceId: "resource",
      operation: "fake.read",
      arguments: {},
      pipelineRunId: runId,
    });
    expect(allowed.decision.decision).toBe("allow");
    expect(allowed.pipeline).toMatchObject({
      pipelineRunId: runId,
      pipelineStageId: "architecture",
    });
    const agentRunId = await new ScheduleAgentRun(
      context.projects,
      context.tasks,
      context.runtime,
      context.ids,
      context.clock,
      context.transactions,
      context.pipelines,
    ).execute({
      projectId: "project",
      taskId: "task",
      agentId: "architect-agent",
      actionIntent: {
        resourceId: "resource",
        operation: "fake.read",
        arguments: {},
      },
    });
    expect(
      (await context.runtime.findRun(agentRunId))?.snapshot().pipelineRunId,
    ).toBe(runId);
    const executingRun = await context.runtime.findRun(agentRunId);
    executingRun!.transition("preparing", now);
    executingRun!.transition("running", now);
    await context.runtime.saveRun(executingRun!);

    const future = await evaluator.execute({
      projectId: "project",
      agentId: "architect-agent",
      resourceId: "resource",
      operation: "fake.delete",
      arguments: { target: "future" },
      pipelineRunId: runId,
    });
    expect(future.decision.reasons).toContain(
      "pipeline_prerequisite_incomplete",
    );

    const omitted = await evaluator.execute({
      projectId: "project",
      agentId: "architect-agent",
      resourceId: "resource",
      operation: "fake.read",
      arguments: {},
    });
    expect(omitted.decision.decision).toBe("allow");

    const baseDenied = await evaluator.execute({
      projectId: "project",
      agentId: "architect-agent",
      resourceId: "resource",
      operation: "fake.admin",
      arguments: { target: "admin" },
      pipelineRunId: runId,
    });
    expect(baseDenied.decision.decision).toBe("deny");
    expect(baseDenied.pipeline.decision).toBe("allow");

    const requested = await new RequestControlledAction(
      evaluator,
      context.capabilities,
      context.audit,
      context.ids,
      context.clock,
      context.transactions,
      context.runtime,
    ).execute({
      projectId: "project",
      agentId: "architect-agent",
      resourceId: "resource",
      operation: "fake.read",
      arguments: {},
      agentRunId,
    });
    expect(requested.request.snapshot()).toMatchObject({
      pipelineRunId: runId,
      pipelineStageRunId: run.currentStage()!.id,
      status: "authorized",
    });
    await context.manager.completeStageFromAgentRun({
      projectId: "project",
      agentRunId,
    });
    const invoke = new InvokeControlledConnectorAction(
      new RequestControlledAction(
        evaluator,
        context.capabilities,
        context.audit,
        context.ids,
        context.clock,
        context.transactions,
        context.runtime,
      ),
      context.capabilities,
      context.audit,
      context.ids,
      context.clock,
      context.transactions,
      createDefaultConnectorRegistry(),
      evaluator,
      new SqliteControlledExecutionRepository(context.database),
      {},
      context.runtime,
    );
    await expect(
      invoke.invokeAuthorized({
        projectId: "project",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    expect(
      context.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM audit_event WHERE event_type = 'pipeline.started'",
        )
        .get()?.count,
    ).toBe(1);
    context.database.close();
  });

  test("round-trips an active run across restart and persists immutable overrides", async () => {
    const context = await fixture();
    const started = await context.manager.start({
      projectId: "project",
      taskId: "task",
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    const runId = started.snapshot().id;
    const stale = await context.pipelines.findById(runId, "project");
    expect(stale).not.toBeNull();
    const result = await context.manager.override({
      projectId: "project",
      pipelineRunId: runId,
      principal: localOperatorPrincipal,
      actorLabel: "incident-commander",
      reason: "Documented emergency exception",
    });
    expect(result.override.previousRule).toBe("pipeline_agent_not_assigned");
    stale!.assign("architect-agent", "architect", now);
    expect(await context.pipelines.save(stale!, 1)).toBe(false);
    context.database.close();

    const reopened = openDatabase(context.path);
    const repository = new SqlitePipelineRunRepository(reopened);
    const restored = await repository.findById(runId, "project");
    const snapshot = restored?.snapshot();
    expect(snapshot).toMatchObject({
      currentStageIndex: 1,
      status: "active",
    });
    expect(snapshot?.stages[0]?.status).toBe("completed");
    expect(snapshot?.stages[1]?.status).toBe("active");
    expect(await repository.listOverrides(runId, "project")).toMatchObject([
      {
        actorId: "local-operator",
        reason: "Documented emergency exception",
        resultingAuthorization: "stage_completed",
      },
    ]);
    expect(() =>
      reopened.prepare("UPDATE pipeline_override SET reason='hidden'").run(),
    ).toThrow("pipeline overrides are immutable");
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import {
  CapabilityPrincipalNotFoundError,
  ConcurrentActionTransitionError,
} from "@ai-office/application/capability-errors.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const roots: string[] = [];
const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const now = new Date("2026-08-05T12:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class SequenceIds implements IdGenerator {
  private next = 0;
  generate(): string {
    return `hardening-${++this.next}`;
  }
}

class FailingAuditRepository implements AuditEventRepository {
  async append(_event: AuditEvent): Promise<void> {
    throw new Error("audit unavailable");
  }
}

class LosingActionTransitionRepository extends SqliteCapabilityPolicyRepository {
  override async transitionActionRequest(
    _input: Parameters<
      SqliteCapabilityPolicyRepository["transitionActionRequest"]
    >[0],
  ): Promise<boolean> {
    return false;
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function createDatabase() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-m6a-hardening-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrationDirectory);
  return database;
}

async function seedProjectsAndPrincipals(
  database: ReturnType<typeof openDatabase>,
) {
  const projects = new SqliteProjectRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  for (const projectId of ["project-1", "project-2"]) {
    await projects.save(
      Project.create({ id: projectId, name: projectId, now }),
    );
    await runtime.saveRole(
      Role.create({
        id: `role-${projectId}`,
        projectId,
        key: "developer",
        name: "Developer",
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "mock",
        limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
        sourcePath: `${projectId}/role`,
        now,
      }),
    );
    await runtime.saveAgent({
      id: `agent-${projectId}`,
      projectId,
      roleId: `role-${projectId}`,
      name: "Agent",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    database
      .prepare(
        `INSERT INTO resources(
          id, project_id, type, provider, display_name, configuration_json,
          status, created_at, updated_at
        ) VALUES (?, ?, 'filesystem_scope', 'fake', ?, '{}', 'active', ?, ?)`,
      )
      .run(
        `resource-${projectId}`,
        projectId,
        projectId,
        now.toISOString(),
        now.toISOString(),
      );
  }
  return { projects, runtime };
}

function requestedAction(id: string, projectId = "project-1"): ActionRequest {
  return ActionRequest.create({
    id,
    projectId,
    agentId: `agent-${projectId}`,
    resourceId: `resource-${projectId}`,
    connector: "fake",
    connectorVersion: "1",
    operation: "fake.read",
    normalizedArguments: { target: "readme" },
    effectiveConstraints: { allowMutation: false, deniedTargets: [] },
    payloadHash: "a".repeat(64),
    decision: "allow",
    riskLevel: "low",
    matchedGrantIds: ["grant"],
    reasons: ["operation risk is low"],
    now,
  });
}

describe("M6A SQLite hardening", () => {
  test("uses conditional action transitions with at most one winner", async () => {
    const database = createDatabase();
    await seedProjectsAndPrincipals(database);
    const repository = new SqliteCapabilityPolicyRepository(database);

    await repository.insertActionRequest(requestedAction("authorize-wins"));
    await expect(
      repository.transitionActionRequest({
        id: "authorize-wins",
        projectId: "project-1",
        expectedStatus: "requested",
        status: "authorized",
        updatedAt: new Date(now.getTime() + 1),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.transitionActionRequest({
        id: "authorize-wins",
        projectId: "project-1",
        expectedStatus: "requested",
        status: "denied",
        updatedAt: new Date(now.getTime() + 1),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.transitionActionRequest({
        id: "authorize-wins",
        projectId: "project-1",
        expectedStatus: "authorized",
        status: "simulating",
        updatedAt: new Date(now.getTime() + 2),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.transitionActionRequest({
        id: "authorize-wins",
        projectId: "project-1",
        expectedStatus: "simulating",
        status: "simulated",
        updatedAt: new Date(now.getTime() + 3),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.transitionActionRequest({
        id: "authorize-wins",
        projectId: "project-1",
        expectedStatus: "simulated",
        status: "approval_pending",
        updatedAt: new Date(now.getTime() + 4),
      }),
    ).resolves.toBe(true);
    expect(
      (await repository.findActionRequest("authorize-wins"))?.snapshot(),
    ).toMatchObject({
      status: "approval_pending",
      updatedAt: new Date(now.getTime() + 4),
    });

    await repository.insertActionRequest(requestedAction("deny-wins"));
    await expect(
      repository.transitionActionRequest({
        id: "deny-wins",
        projectId: "project-1",
        expectedStatus: "requested",
        status: "denied",
        updatedAt: new Date(now.getTime() + 1),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.transitionActionRequest({
        id: "deny-wins",
        projectId: "project-1",
        expectedStatus: "requested",
        status: "authorized",
        updatedAt: new Date(now.getTime() + 1),
      }),
    ).resolves.toBe(false);

    expect(() =>
      database
        .prepare(
          "UPDATE action_requests SET status='authorized' WHERE id='deny-wins'",
        )
        .run(),
    ).toThrow("invalid action request status transition");
    expect(() =>
      database
        .prepare(
          "UPDATE action_requests SET operation='fake.admin' WHERE id='deny-wins'",
        )
        .run(),
    ).toThrow("action request payload is immutable");
    expect(() =>
      database
        .prepare("DELETE FROM action_requests WHERE id='deny-wins'")
        .run(),
    ).toThrow("action requests cannot be deleted");
    expect(() =>
      database
        .prepare(
          `INSERT INTO action_requests(
            id, project_id, agent_id, resource_id, connector, connector_version,
            operation, normalized_arguments_json, effective_constraints_json,
            payload_hash, decision, risk_level, matched_grant_ids_json,
            reasons_json, status, created_at, updated_at
          ) SELECT 'starts-authorized', project_id, agent_id, resource_id,
            connector, connector_version, operation, normalized_arguments_json,
            effective_constraints_json, payload_hash, decision, risk_level,
            matched_grant_ids_json, reasons_json, 'authorized', created_at, updated_at
          FROM action_requests WHERE id='authorize-wins'`,
        )
        .run(),
    ).toThrow("action request must start requested");
    database.close();
  });

  test("enforces project ownership, non-empty actions, and project-scoped role lookup", async () => {
    const database = createDatabase();
    const { runtime } = await seedProjectsAndPrincipals(database);
    expect(
      database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
        ?.foreign_keys,
    ).toBe(1);
    expect(
      await runtime.findRole("role-project-1", "project-1"),
    ).not.toBeNull();
    expect(await runtime.findRole("role-project-1", "project-2")).toBeNull();
    await expect(
      new EvaluateActionPolicy(
        runtime,
        new SqliteCapabilityPolicyRepository(database),
        new FixedClock(),
      ).execute({
        projectId: "project-1",
        agentId: "agent-project-2",
        resourceId: "resource-project-1",
        operation: "fake.read",
        arguments: {},
      }),
    ).rejects.toBeInstanceOf(CapabilityPrincipalNotFoundError);

    expect(() =>
      database
        .prepare(
          `INSERT INTO capability_grants(
            id, project_id, principal_type, principal_id, resource_id,
            actions_json, constraints_json, valid_from, granted_by, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
        )
        .run(
          "cross-role",
          "project-1",
          "role",
          "role-project-2",
          "resource-project-1",
          '["fake.read"]',
          now.toISOString(),
          "owner",
          "invalid",
          now.toISOString(),
        ),
    ).toThrow("capability principal must belong to the same project");
    expect(() =>
      database
        .prepare(
          `INSERT INTO capability_grants(
            id, project_id, principal_type, principal_id, resource_id,
            actions_json, constraints_json, valid_from, granted_by, reason, created_at
          ) VALUES (?, ?, 'user', 'owner', ?, '[]', '{}', ?, 'owner', 'invalid', ?)`,
        )
        .run(
          "empty-actions",
          "project-1",
          "resource-project-1",
          now.toISOString(),
          now.toISOString(),
        ),
    ).toThrow();
    database
      .prepare(
        `INSERT INTO capability_grants(
          id, project_id, principal_type, principal_id, resource_id,
          actions_json, constraints_json, valid_from, granted_by, reason, created_at
        ) VALUES ('immutable-grant', 'project-1', 'user', 'owner',
          'resource-project-1', '["fake.read"]', '{}', ?, 'owner', 'test', ?)`,
      )
      .run(now.toISOString(), now.toISOString());
    expect(() =>
      database
        .prepare(
          "UPDATE capability_grants SET project_id='project-2' WHERE id='immutable-grant'",
        )
        .run(),
    ).toThrow("capability grant fields are immutable");
    expect(() =>
      database
        .prepare("DELETE FROM capability_grants WHERE id='immutable-grant'")
        .run(),
    ).toThrow("capability grants cannot be deleted");
    expect(() =>
      database
        .prepare(
          "UPDATE resources SET project_id='project-2' WHERE id='resource-project-1'",
        )
        .run(),
    ).toThrow("resource registration fields are immutable");
    expect(() =>
      database
        .prepare("DELETE FROM resources WHERE id='resource-project-1'")
        .run(),
    ).toThrow("resource registry entries cannot be deleted");
    expect(() =>
      database
        .prepare(
          "UPDATE role SET project_id='project-2' WHERE id='role-project-1'",
        )
        .run(),
    ).toThrow("role assigned to agents cannot change identity");
    expect(() =>
      database
        .prepare(
          `INSERT INTO resources(
            id, project_id, type, provider, display_name, configuration_json,
            status, created_at, updated_at
          ) VALUES ('secret-config', 'project-1', 'filesystem_scope', 'fake',
            'Secret', ?, 'active', ?, ?)`,
        )
        .run(
          '{"nested":{"credentialRef":"do-not-store"}}',
          now.toISOString(),
          now.toISOString(),
        ),
    ).toThrow("resource configuration contains a forbidden field");
    expect(() =>
      database
        .prepare(
          `INSERT INTO action_requests(
            id, project_id, agent_id, resource_id, connector, connector_version,
            operation, normalized_arguments_json, effective_constraints_json,
            payload_hash, decision, risk_level, matched_grant_ids_json,
            reasons_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'fake', '1', 'fake.read', '{}', '{}', ?,
            'deny', 'low', '[]', '[]', 'requested', ?, ?)`,
        )
        .run(
          "cross-agent",
          "project-1",
          "agent-project-2",
          "resource-project-1",
          "b".repeat(64),
          now.toISOString(),
          now.toISOString(),
        ),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(() =>
      database
        .prepare(
          `INSERT INTO action_requests(
            id, project_id, agent_id, resource_id, connector, connector_version,
            operation, normalized_arguments_json, effective_constraints_json,
            payload_hash, decision, risk_level, matched_grant_ids_json,
            reasons_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'fake', '1', 'fake.read', '{}', '{}', ?,
            'deny', 'low', '[]', '[]', 'requested', ?, ?)`,
        )
        .run(
          "cross-resource",
          "project-1",
          "agent-project-1",
          "resource-project-2",
          "c".repeat(64),
          now.toISOString(),
          now.toISOString(),
        ),
    ).toThrow("FOREIGN KEY constraint failed");
    database.close();
  });

  test("rolls back action state when its required audit append fails", async () => {
    const database = createDatabase();
    const { runtime } = await seedProjectsAndPrincipals(database);
    database
      .prepare(
        `INSERT INTO capability_grants(
          id, project_id, principal_type, principal_id, resource_id,
          actions_json, constraints_json, valid_from, granted_by, reason, created_at
        ) VALUES ('grant', 'project-1', 'agent', 'agent-project-1',
          'resource-project-1', '["fake.read"]', '{}', ?, 'owner', 'test', ?)`,
      )
      .run(now.toISOString(), now.toISOString());
    const repository = new SqliteCapabilityPolicyRepository(database);
    const ids = new SequenceIds();
    const clock = new FixedClock();
    const service = new RequestControlledAction(
      new EvaluateActionPolicy(runtime, repository, clock),
      repository,
      new RecordAuditEvent(new FailingAuditRepository(), ids, clock),
      ids,
      clock,
      new SqliteTransactionRunner(database),
    );
    await expect(
      service.execute({
        projectId: "project-1",
        agentId: "agent-project-1",
        resourceId: "resource-project-1",
        operation: "fake.read",
        arguments: { target: "readme" },
      }),
    ).rejects.toThrow("audit unavailable");
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM action_requests",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("reports a typed conflict and rolls back when the requested state loses", async () => {
    const database = createDatabase();
    const { runtime } = await seedProjectsAndPrincipals(database);
    database
      .prepare(
        `INSERT INTO capability_grants(
          id, project_id, principal_type, principal_id, resource_id,
          actions_json, constraints_json, valid_from, granted_by, reason, created_at
        ) VALUES ('grant', 'project-1', 'agent', 'agent-project-1',
          'resource-project-1', '["fake.read"]', '{}', ?, 'owner', 'test', ?)`,
      )
      .run(now.toISOString(), now.toISOString());
    const repository = new LosingActionTransitionRepository(database);
    const ids = new SequenceIds();
    const clock = new FixedClock();
    const service = new RequestControlledAction(
      new EvaluateActionPolicy(runtime, repository, clock),
      repository,
      new RecordAuditEvent(
        new SqliteAuditEventRepository(database),
        ids,
        clock,
      ),
      ids,
      clock,
      new SqliteTransactionRunner(database),
    );
    await expect(
      service.execute({
        projectId: "project-1",
        agentId: "agent-project-1",
        resourceId: "resource-project-1",
        operation: "fake.read",
        arguments: { target: "readme" },
      }),
    ).rejects.toBeInstanceOf(ConcurrentActionTransitionError);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM action_requests",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM audit_event WHERE event_type LIKE 'action.%'",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });
});

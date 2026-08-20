import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const roots: string[] = [];
const migrationSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const now = new Date("2026-08-11T00:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = realpathSync(
    mkdtempSync(join(tmpdir(), "ai-office-m6c-migration-")),
  );
  roots.push(value);
  return value;
}

function migrationsThrough(directory: string, last: string): string {
  const target = join(directory, `through-${last}`);
  mkdirSync(target);
  for (const file of readdirSync(migrationSource).sort()) {
    if (file.endsWith(".sql") && file <= last)
      copyFileSync(join(migrationSource, file), join(target, file));
  }
  return target;
}

async function seedM6B(
  database: ReturnType<typeof openDatabase>,
): Promise<void> {
  const projects = new SqliteProjectRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  await projects.save(Project.create({ id: "project-1", name: "M6B", now }));
  await runtime.saveRole(
    Role.create({
      id: "role-1",
      projectId: "project-1",
      key: "developer",
      name: "Developer",
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "mock",
      limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
      sourcePath: "agents/developer",
      now,
    }),
  );
  await runtime.saveAgent({
    id: "agent-1",
    projectId: "project-1",
    roleId: "role-1",
    name: "Agent",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  database
    .prepare(
      `INSERT INTO resources(
        id, project_id, type, provider, external_ref, display_name,
        configuration_json, status, created_at, updated_at
      ) VALUES ('resource-1', 'project-1', 'filesystem_scope', 'filesystem',
        '/tmp/m6b-history', 'History', '{}', 'active', ?, ?)`,
    )
    .run(now.toISOString(), now.toISOString());
  database
    .prepare(
      `INSERT INTO capability_grants(
        id, project_id, principal_type, principal_id, resource_id,
        actions_json, constraints_json, valid_from, granted_by, reason, created_at
      ) VALUES ('grant-1', 'project-1', 'agent', 'agent-1', 'resource-1',
        '["filesystem.write"]', '{"allowMutation":true}', ?, 'owner',
        'preserved M6B grant', ?)`,
    )
    .run(now.toISOString(), now.toISOString());
  for (const item of [
    {
      id: "action-simulated",
      operation: "filesystem.write",
      decision: "allow_simulation_only",
      status: "simulated",
      artifact: "b".repeat(64),
    },
    {
      id: "action-pending",
      operation: "filesystem.delete",
      decision: "allow_with_approval",
      status: "approval_pending",
      artifact: "c".repeat(64),
    },
  ] as const) {
    database
      .prepare(
        `INSERT INTO action_requests(
          id, project_id, agent_id, resource_id, connector, connector_version,
          operation, normalized_arguments_json, effective_constraints_json,
          payload_hash, decision, risk_level, matched_grant_ids_json,
          reasons_json, status, created_at, updated_at
        ) VALUES (?, 'project-1', 'agent-1', 'resource-1', 'filesystem', '1',
          ?, '{"path":"src/index.ts"}', '{"allowMutation":true}', ?, ?,
          'medium', '["grant-1"]', '["M6B history"]', 'requested', ?, ?)`,
      )
      .run(
        item.id,
        item.operation,
        "a".repeat(64),
        item.decision,
        now.toISOString(),
        now.toISOString(),
      );
    database
      .prepare(
        "UPDATE action_requests SET status='authorized', updated_at=? WHERE id=?",
      )
      .run(now.toISOString(), item.id);
    database
      .prepare(
        "UPDATE action_requests SET status='simulating', updated_at=? WHERE id=?",
      )
      .run(now.toISOString(), item.id);
    database
      .prepare(
        `INSERT INTO action_simulations(
          id, project_id, action_request_id, authorization_payload_hash,
          connector, connector_version, operation, preconditions_json, diff,
          diff_sha256, artifact_sha256, created_at
        ) VALUES (?, 'project-1', ?, ?, 'filesystem', '1', ?,
          '[{"kind":"file","path":"src/index.ts","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}]',
          'legacy diff', ?, ?, ?)`,
      )
      .run(
        `simulation-${item.id}`,
        item.id,
        "a".repeat(64),
        item.operation,
        "d".repeat(64),
        item.artifact,
        now.toISOString(),
      );
    database
      .prepare(
        "UPDATE action_requests SET status='simulated', updated_at=? WHERE id=?",
      )
      .run(now.toISOString(), item.id);
    if (item.status === "approval_pending")
      database
        .prepare(
          "UPDATE action_requests SET status='approval_pending', updated_at=? WHERE id=?",
        )
        .run(now.toISOString(), item.id);
  }
  database
    .prepare(
      `INSERT INTO audit_event(
        id, project_id, event_type, actor_type, payload_json, occurred_at
      ) VALUES ('audit-1', 'project-1', 'action.simulated', 'system',
        '{"safe":true}', ?)`,
    )
    .run(now.toISOString());
}

describe("M6C-lite migration", () => {
  test("creates a fresh database with valid integrity and lifecycle tables", () => {
    const directory = root();
    const database = openDatabase(join(directory, "fresh.sqlite"));
    expect(migrate(database, migrationSource).applied.at(-1)).toBe(
      "0016_agent_controlled_actions.sql",
    );
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check,
    ).toBe("ok");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name='m6b_legacy_simulation_upgrade_guard'",
        )
        .all(),
    ).toEqual([]);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('action_approvals','action_executions') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "action_approvals" }, { name: "action_executions" }]);
    database.close();
  });

  test("preserves populated M6B v1 history and refuses to make it executable", async () => {
    const directory = root();
    const database = openDatabase(join(directory, "upgrade.sqlite"));
    migrate(
      database,
      migrationsThrough(directory, "0013_filesystem_connector.sql"),
    );
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name='m6b_legacy_simulation_upgrade_guard'",
        )
        .all(),
    ).toEqual([{ name: "m6b_legacy_simulation_upgrade_guard" }]);
    await seedM6B(database);
    const before = database
      .query("SELECT * FROM action_requests ORDER BY id")
      .all();
    expect(migrate(database, migrationSource).applied).toEqual([
      "0014_trusted_local_execution.sql",
      "0015_llm_assisted_onboarding.sql",
      "0016_agent_controlled_actions.sql",
    ]);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name='m6b_legacy_simulation_upgrade_guard'",
        )
        .all(),
    ).toEqual([]);
    expect(
      database.query("SELECT * FROM action_requests ORDER BY id").all(),
    ).toEqual(before);
    const repository = new SqliteCapabilityPolicyRepository(database);
    expect(
      (await repository.findActionRequest("action-simulated"))?.snapshot(),
    ).toMatchObject({ connectorVersion: "1", status: "simulated" });
    expect(
      (await repository.findActionRequest("action-pending"))?.snapshot(),
    ).toMatchObject({ connectorVersion: "1", status: "approval_pending" });
    expect(
      database.query("SELECT id FROM action_simulations ORDER BY id").all(),
    ).toEqual([
      { id: "simulation-action-pending" },
      { id: "simulation-action-simulated" },
    ]);
    expect(database.query("SELECT id FROM audit_event").all()).toEqual([
      { id: "audit-1" },
    ]);
    expect(() =>
      database
        .prepare(
          `INSERT INTO action_executions(
            id, project_id, action_request_id, simulation_id, approval_id,
            status, started_at
          ) VALUES ('execution-legacy', 'project-1', 'action-pending',
            'simulation-action-pending', 'missing', 'executing', ?)`,
        )
        .run(now.toISOString()),
    ).toThrow();
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check,
    ).toBe("ok");
    database.close();
  });
});

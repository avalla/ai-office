import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
const now = new Date("2026-08-06T00:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ai-office-m6b-migration-")),
  );
  roots.push(root);
  return root;
}

function migrationSubset(root: string, last: string, name = last): string {
  const directory = join(root, `migrations-${name}`);
  mkdirSync(directory);
  for (const file of readdirSync(migrationSource).sort()) {
    if (!file.endsWith(".sql") || file > last) continue;
    copyFileSync(join(migrationSource, file), join(directory, file));
  }
  return directory;
}

type LegacyActionStatus =
  | "requested"
  | "authorized"
  | "denied"
  | "simulating"
  | "simulated"
  | "approval_pending";

type LegacyActionDecision =
  "allow" | "deny" | "allow_simulation_only" | "allow_with_approval";

interface LegacyActionOverride {
  operation?: string;
  decision?: LegacyActionDecision;
}

function riskForOperation(
  operation: string,
): "low" | "medium" | "high" | "critical" {
  if (operation === "fake.read") return "low";
  if (operation === "fake.delete") return "high";
  if (operation === "fake.admin") return "critical";
  return "medium";
}

async function seedM6A(
  database: ReturnType<typeof openDatabase>,
  targetStatus: LegacyActionStatus = "requested",
  override: LegacyActionOverride = {},
) {
  const projects = new SqliteProjectRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  await projects.save(Project.create({ id: "project-1", name: "M6A", now }));
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
  await runtime.saveRole(
    Role.create({
      id: "role-2",
      projectId: "project-1",
      key: "reviewer",
      name: "Reviewer",
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "mock",
      limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
      sourcePath: "agents/reviewer",
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
  const denied = targetStatus === "denied";
  const approval = targetStatus === "approval_pending";
  const decision =
    override.decision ??
    (denied
      ? "deny"
      : approval
        ? "allow_with_approval"
        : "allow_simulation_only");
  const operation =
    override.operation ?? (approval ? "fake.delete" : "fake.write");
  const riskLevel = riskForOperation(operation);
  database
    .prepare(
      `INSERT INTO resources(
        id, project_id, type, provider, display_name, configuration_json,
        status, created_at, updated_at
      ) VALUES ('fake-resource', 'project-1', 'filesystem_scope', 'fake',
        'Fake', '{}', 'active', ?, ?)`,
    )
    .run(now.toISOString(), now.toISOString());
  database
    .prepare(
      `INSERT INTO capability_grants(
        id, project_id, principal_type, principal_id, resource_id,
        actions_json, constraints_json, valid_from, expires_at, revoked_at,
        granted_by, reason, created_at
      ) VALUES ('fake-grant', 'project-1', 'agent', 'agent-1', 'fake-resource',
        '["fake.write"]', '{"allowMutation":true}', ?, ?, ?, 'owner',
        'preserve revoked and expired grant', ?)`,
    )
    .run(
      "2025-01-01T00:00:00.000Z",
      "2025-02-01T00:00:00.000Z",
      "2025-01-15T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO capability_grants(
        id, project_id, principal_type, principal_id, resource_id,
        actions_json, constraints_json, valid_from, granted_by, reason,
        created_at
      ) VALUES ('role-grant', 'project-1', 'role', 'role-2', 'fake-resource',
        '["fake.read"]', '{}', ?, 'owner', 'preserve role guard', ?)`,
    )
    .run(now.toISOString(), now.toISOString());
  database
    .prepare(
      `INSERT INTO action_requests(
        id, project_id, agent_id, resource_id, connector, connector_version,
        operation, normalized_arguments_json, effective_constraints_json,
        payload_hash, decision, risk_level, matched_grant_ids_json,
        reasons_json, status, created_at, updated_at
      ) VALUES ('fake-action', 'project-1', 'agent-1', 'fake-resource', 'fake',
        '1', ?, '{"target":"a"}', '{"allowMutation":true}', ?,
        ?, ?, '["fake-grant"]',
        '["simulation is required"]', 'requested', ?, ?)`,
    )
    .run(
      operation,
      "a".repeat(64),
      decision,
      riskLevel,
      now.toISOString(),
      now.toISOString(),
    );
  const transitions: LegacyActionStatus[] =
    targetStatus === "denied"
      ? ["denied"]
      : targetStatus === "requested"
        ? []
        : targetStatus === "authorized"
          ? ["authorized"]
          : targetStatus === "simulating"
            ? ["authorized", "simulating"]
            : targetStatus === "simulated"
              ? ["authorized", "simulating", "simulated"]
              : ["authorized", "simulating", "simulated", "approval_pending"];
  for (const status of transitions)
    database
      .prepare(
        "UPDATE action_requests SET status=?, updated_at=? WHERE id='fake-action'",
      )
      .run(status, now.toISOString());
  database
    .prepare(
      `INSERT INTO audit_event(
        id, project_id, event_type, actor_type, actor_id, aggregate_type,
        aggregate_id, payload_json, occurred_at
      ) VALUES ('audit-1', 'project-1', 'action.requested', 'system', 'agent-1',
        'action_request', 'fake-action', '{"safe":true}', ?)`,
    )
    .run(now.toISOString());
}

function snapshotM6ASchemaAndData(
  database: ReturnType<typeof openDatabase>,
): string {
  return JSON.stringify({
    schema: database
      .query(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all(),
    migrations: database
      .query(
        "SELECT version, applied_at FROM schema_migration ORDER BY version",
      )
      .all(),
    projects: database.query("SELECT * FROM project ORDER BY id").all(),
    roles: database.query("SELECT * FROM role ORDER BY id").all(),
    agents: database.query("SELECT * FROM agent ORDER BY id").all(),
    resources: database.query("SELECT * FROM resources ORDER BY id").all(),
    grants: database.query("SELECT * FROM capability_grants ORDER BY id").all(),
    actions: database.query("SELECT * FROM action_requests ORDER BY id").all(),
    audit: database.query("SELECT * FROM audit_event ORDER BY id").all(),
  });
}

describe("M6B filesystem migration", () => {
  test("upgrades an empty M6A database", () => {
    const root = temporaryRoot();
    const database = openDatabase(join(root, "empty.sqlite"));
    migrate(database, migrationSubset(root, "0012_capability_policy.sql"));
    expect(
      migrate(
        database,
        migrationSubset(root, "0013_filesystem_connector.sql", "m6b-upgrade"),
      ).applied,
    ).toEqual([
      "0013_filesystem_connector.sql",
    ]);
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check,
    ).toBe("ok");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  test("preserves populated M6A fake resources, grants, actions, and audit", async () => {
    const root = temporaryRoot();
    const database = openDatabase(join(root, "populated.sqlite"));
    migrate(database, migrationSubset(root, "0012_capability_policy.sql"));
    await seedM6A(database);
    expect(
      migrate(
        database,
        migrationSubset(root, "0013_filesystem_connector.sql", "m6b-upgrade"),
      ).applied,
    ).toEqual([
      "0013_filesystem_connector.sql",
    ]);
    expect(
      database
        .query<{ id: string; provider: string }, []>(
          "SELECT id, provider FROM resources",
        )
        .all(),
    ).toEqual([{ id: "fake-resource", provider: "fake" }]);
    expect(
      database
        .query<
          { id: string; expires_at: string | null; revoked_at: string | null },
          []
        >(
          "SELECT id, expires_at, revoked_at FROM capability_grants WHERE id='fake-grant'",
        )
        .get(),
    ).toEqual({
      id: "fake-grant",
      expires_at: "2025-02-01T00:00:00.000Z",
      revoked_at: "2025-01-15T00:00:00.000Z",
    });
    expect(
      database
        .query<{ id: string; connector: string; status: string }, []>(
          "SELECT id, connector, status FROM action_requests",
        )
        .get(),
    ).toEqual({ id: "fake-action", connector: "fake", status: "requested" });
    expect(
      database
        .query<{ id: string; payload_json: string }, []>(
          "SELECT id, payload_json FROM audit_event",
        )
        .get(),
    ).toEqual({ id: "audit-1", payload_json: '{"safe":true}' });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check,
    ).toBe("ok");
    const indexes = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'action_simulations_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual([
      "action_simulations_action_idx",
      "action_simulations_project_created_idx",
    ]);
    const schemaSql = database
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL",
      )
      .all()
      .map((row) => row.sql ?? "")
      .join("\n");
    expect(schemaSql).not.toContain("resources_m6b");
    expect(schemaSql).not.toContain("capability_grants_m6b");
    expect(schemaSql).not.toContain("action_requests_m6b");
    for (const table of [
      "capability_grants",
      "action_requests",
      "action_simulations",
    ]) {
      const targets = database
        .query<{ table: string }, []>(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => row.table);
      expect(targets.some((target) => target.endsWith("_m6b"))).toBe(false);
    }
    expect(
      database
        .query<{ created_at: string; updated_at: string }, []>(
          "SELECT created_at, updated_at FROM action_requests WHERE id='fake-action'",
        )
        .get(),
    ).toEqual({
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    expect(() =>
      database.prepare("DELETE FROM agent WHERE id='agent-1'").run(),
    ).toThrow("agent has capability grants");
    expect(() =>
      database.prepare("DELETE FROM role WHERE id='role-2'").run(),
    ).toThrow("role has capability grants");
    expect(() =>
      database
        .prepare("UPDATE agent SET id='agent-renamed' WHERE id='agent-1'")
        .run(),
    ).toThrow("agent with capability grants cannot change identity");
    expect(() =>
      database
        .prepare("UPDATE role SET id='role-renamed' WHERE id='role-2'")
        .run(),
    ).toThrow("role with capability grants cannot change identity");
    expect(() =>
      database
        .prepare("UPDATE role SET id='assigned-role' WHERE id='role-1'")
        .run(),
    ).toThrow("role assigned to agents cannot change identity");
    database.close();
  });

  test("accepts only M6B-compatible M6A action state semantics", async () => {
    const compatible = [
      { status: "requested", operation: "fake.read", decision: "allow" },
      { status: "authorized", operation: "fake.read", decision: "allow" },
      { status: "denied", operation: "fake.read", decision: "deny" },
      {
        status: "simulating",
        operation: "fake.write",
        decision: "allow_simulation_only",
      },
      {
        status: "simulating",
        operation: "fake.delete",
        decision: "allow_with_approval",
      },
      {
        status: "simulating",
        operation: "fake.admin",
        decision: "allow_with_approval",
      },
    ] as const;

    for (const [index, entry] of compatible.entries()) {
      const root = temporaryRoot();
      const database = openDatabase(join(root, `compatible-${index}.sqlite`));
      migrate(database, migrationSubset(root, "0012_capability_policy.sql"));
      await seedM6A(database, entry.status, {
        operation: entry.operation,
        decision: entry.decision,
      });
      expect(
        migrate(
          database,
          migrationSubset(root, "0013_filesystem_connector.sql", "m6b-upgrade"),
        ).applied,
      ).toEqual([
        "0013_filesystem_connector.sql",
      ]);
      const restored = await new SqliteCapabilityPolicyRepository(
        database,
      ).findActionRequest("fake-action");
      expect(restored?.snapshot()).toMatchObject(entry);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get()?.integrity_check,
      ).toBe("ok");
      database.close();
    }
  });

  test("rejects incompatible M6A simulating and artifact-less states atomically", async () => {
    const incompatible = [
      { status: "simulating", operation: "fake.read", decision: "allow" },
      { status: "simulating", operation: "fake.write", decision: "allow" },
      {
        status: "simulating",
        operation: "fake.write",
        decision: "allow_with_approval",
      },
      {
        status: "simulating",
        operation: "fake.delete",
        decision: "allow_simulation_only",
      },
      {
        status: "simulating",
        operation: "fake.unknown",
        decision: "allow_simulation_only",
      },
      {
        status: "simulated",
        operation: "fake.write",
        decision: "allow_simulation_only",
      },
      {
        status: "approval_pending",
        operation: "fake.delete",
        decision: "allow_with_approval",
      },
    ] as const;

    for (const [index, entry] of incompatible.entries()) {
      const root = temporaryRoot();
      const database = openDatabase(join(root, `incompatible-${index}.sqlite`));
      migrate(database, migrationSubset(root, "0012_capability_policy.sql"));
      await seedM6A(database, entry.status, {
        operation: entry.operation,
        decision: entry.decision,
      });
      const before = snapshotM6ASchemaAndData(database);
      expect(() =>
        migrate(
          database,
          migrationSubset(root, "0013_filesystem_connector.sql", "m6b-upgrade"),
        ),
      ).toThrow(
        "M6B upgrade requires remediation of legacy simulated action requests",
      );
      expect(snapshotM6ASchemaAndData(database)).toBe(before);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) count FROM schema_migration WHERE version='0013_filesystem_connector.sql'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ count: number }, []>(
            `SELECT COUNT(*) count FROM sqlite_master
             WHERE type='table' AND name='action_simulations'`,
          )
          .get()?.count,
      ).toBe(0);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get()?.integrity_check,
      ).toBe("ok");
      database.close();
    }
  });

  test("rolls back the table rebuild when migration execution fails", async () => {
    const root = temporaryRoot();
    const database = openDatabase(join(root, "rollback.sqlite"));
    migrate(database, migrationSubset(root, "0012_capability_policy.sql"));
    await seedM6A(database);
    const broken = migrationSubset(
      root,
      "0012_capability_policy.sql",
      "broken",
    );
    writeFileSync(
      join(broken, "0013_filesystem_connector.sql"),
      `${readFileSync(join(migrationSource, "0013_filesystem_connector.sql"), "utf8")}\nTHIS IS NOT SQL;\n`,
    );
    expect(() => migrate(database, broken)).toThrow();
    expect(
      database.query<{ id: string }, []>("SELECT id FROM resources").get()?.id,
    ).toBe("fake-resource");
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM schema_migration WHERE version='0013_filesystem_connector.sql'",
        )
        .get()?.count,
    ).toBe(0);
    expect(() =>
      database.query("SELECT * FROM action_simulations").all(),
    ).toThrow();
    expect(() =>
      database.prepare("DELETE FROM agent WHERE id='agent-1'").run(),
    ).toThrow("agent has capability grants");
    expect(() =>
      database.prepare("DELETE FROM role WHERE id='role-2'").run(),
    ).toThrow("role has capability grants");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check,
    ).toBe("ok");
    database.close();
  });
});

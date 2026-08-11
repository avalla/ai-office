import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { hashCanonicalActionPayload } from "@ai-office/application/capability/canonical-action.ts";
import {
  hashActionSimulationArtifact,
  sha256Text,
} from "@ai-office/application/capability/action-simulation-hash.ts";
import {
  InvalidConnectorInvocationStateError,
  StaleActionAuthorizationError,
} from "@ai-office/application/capability-errors.ts";
import { CreateCapabilityGrant } from "@ai-office/application/capability/create-capability-grant.ts";
import { DisableResource } from "@ai-office/application/capability/disable-resource.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import {
  InvokeControlledConnectorAction,
  type AuthorizationLeaseHooks,
} from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { RegisterResource } from "@ai-office/application/capability/register-resource.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { RevokeCapabilityGrant } from "@ai-office/application/capability/revoke-capability-grant.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { ActionSimulation } from "@ai-office/domain/capability/action-simulation.ts";
import type { Resource } from "@ai-office/domain/capability/capability.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import type { ConnectorDefinition } from "@ai-office/connector-sdk/connector.ts";
import { filesystemConnectorDefinition } from "@ai-office/filesystem-connector/filesystem-connector.ts";
import { parseEffectiveFilesystemConstraints } from "@ai-office/filesystem-connector/filesystem-constraints.ts";
import { FilesystemSandbox } from "@ai-office/filesystem-connector/filesystem-sandbox.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteControlledExecutionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-controlled-execution.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const roots: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);

class TestClock implements Clock {
  private value = Date.parse("2026-08-06T12:00:00.000Z");
  now(): Date {
    this.value += 1;
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

class TestIds implements IdGenerator {
  private value = 0;
  generate(): string {
    this.value += 1;
    return `m6b-${this.value}`;
  }
}

class FailOnSimulatedAudit implements AuditEventRepository {
  constructor(private readonly delegate: AuditEventRepository) {}
  async append(event: AuditEvent): Promise<void> {
    if (event.snapshot().eventType === "action.simulated")
      throw new Error("simulated audit unavailable");
    await this.delegate.append(event);
  }
}

class FailSimulationInsertRepository extends SqliteCapabilityPolicyRepository {
  override async insertActionSimulation(
    _value: ActionSimulation,
  ): Promise<boolean> {
    return false;
  }
}

class FailSimulatedTransitionRepository extends SqliteCapabilityPolicyRepository {
  override async transitionActionRequest(
    input: Parameters<
      SqliteCapabilityPolicyRepository["transitionActionRequest"]
    >[0],
  ): Promise<boolean> {
    if (input.expectedStatus === "simulating" && input.status === "simulated")
      return false;
    return super.transitionActionRequest(input);
  }
}

class FailSimulationAndRecoveryRepository extends SqliteCapabilityPolicyRepository {
  override async transitionActionRequest(
    input: Parameters<
      SqliteCapabilityPolicyRepository["transitionActionRequest"]
    >[0],
  ): Promise<boolean> {
    if (
      input.expectedStatus === "simulating" &&
      (input.status === "simulated" || input.status === "failed")
    )
      return false;
    return super.transitionActionRequest(input);
  }
}

interface FixtureOptions {
  failSimulatedAudit?: boolean;
  repositoryFailure?:
    "simulation-insert" | "simulated-transition" | "simulation-and-recovery";
  connectors?: ConnectorRegistry;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(options: FixtureOptions = {}) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "ai-office-filesystem-integration-")),
  );
  roots.push(directory);
  const database = openDatabase(join(directory, "project.sqlite"));
  migrate(database, migrations);
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "index.ts"),
    "export const value = 1;\n",
  );
  const clock = new TestClock();
  const ids = new TestIds();
  const projects = new SqliteProjectRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const capabilities =
    options.repositoryFailure === "simulation-insert"
      ? new FailSimulationInsertRepository(database)
      : options.repositoryFailure === "simulated-transition"
        ? new FailSimulatedTransitionRepository(database)
        : options.repositoryFailure === "simulation-and-recovery"
          ? new FailSimulationAndRecoveryRepository(database)
          : new SqliteCapabilityPolicyRepository(database);
  const auditStorage = new SqliteAuditEventRepository(database);
  const audit = new RecordAuditEvent(
    options.failSimulatedAudit
      ? new FailOnSimulatedAudit(auditStorage)
      : auditStorage,
    ids,
    clock,
  );
  const transactions = new SqliteTransactionRunner(database);
  const controlled = new SqliteControlledExecutionRepository(database);
  const connectors = options.connectors ?? createDefaultConnectorRegistry();
  await projects.save(
    Project.create({ id: "project-1", name: "M6B", now: clock.now() }),
  );
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
      now: clock.now(),
    }),
  );
  await runtime.saveAgent({
    id: "agent-1",
    projectId: "project-1",
    roleId: "role-1",
    name: "Agent",
    enabled: true,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  const resource = await new RegisterResource(
    projects,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
    connectors,
  ).execute({
    projectId: "project-1",
    type: "filesystem_scope",
    provider: "filesystem",
    externalRef: workspace,
    displayName: "Workspace",
    configuration: {},
  });
  const createGrant = new CreateCapabilityGrant(
    projects,
    runtime,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
    connectors,
  );
  const evaluator = new EvaluateActionPolicy(
    runtime,
    capabilities,
    clock,
    connectors,
  );
  const request = new RequestControlledAction(
    evaluator,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
  );
  const invoke = new InvokeControlledConnectorAction(
    request,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
    connectors,
    evaluator,
    controlled,
  );
  return {
    database,
    workspace,
    clock,
    resource,
    capabilities,
    audit,
    transactions,
    createGrant,
    evaluator,
    request,
    invoke,
    connectors,
    runtime,
    ids,
    controlled,
  };
}

async function grant(
  context: Awaited<ReturnType<typeof fixture>>,
  actions: readonly string[],
  constraints: Readonly<Record<string, unknown>> = {},
  expiresAt?: Date,
) {
  return context.createGrant.execute({
    projectId: "project-1",
    principalType: "agent",
    principalId: "agent-1",
    resourceId: context.resource.id,
    actions,
    constraints,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    grantedBy: "owner",
    reason: "M6B integration test",
  });
}

function invokeWithHooks(
  context: Awaited<ReturnType<typeof fixture>>,
  hooks: AuthorizationLeaseHooks,
): InvokeControlledConnectorAction {
  return new InvokeControlledConnectorAction(
    context.request,
    context.capabilities,
    context.audit,
    context.ids,
    context.clock,
    context.transactions,
    context.connectors,
    context.evaluator,
    context.controlled,
    hooks,
  );
}

function input(
  resource: Resource,
  operation: string,
  arguments_: Readonly<Record<string, unknown>>,
) {
  return {
    projectId: "project-1",
    agentId: "agent-1",
    resourceId: resource.id,
    operation,
    arguments: arguments_,
  };
}

describe("M6B controlled filesystem invocation", () => {
  test("executes an authorized read and persists only metadata audit", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const result = await context.invoke.execute(
      input(context.resource, "filesystem.read", { path: "src/index.ts" }),
    );
    expect(result).toMatchObject({ outcome: "allowed", status: "completed" });
    expect(result.result).toMatchObject({
      path: "src/index.ts",
      content: "export const value = 1;\n",
      byteLength: 24,
    });
    const persisted = await context.capabilities.findActionRequest(
      result.requestId,
    );
    expect(persisted?.snapshot()).toMatchObject({
      connector: "filesystem",
      connectorVersion: "2",
      operation: "filesystem.read",
      status: "completed",
    });
    const snapshot = persisted!.snapshot();
    expect(snapshot.payloadHash).toBe(
      hashCanonicalActionPayload(persisted!.canonicalPayload()).hash,
    );
    expect(JSON.stringify(snapshot.normalizedArguments)).not.toContain(
      "export const value",
    );
    expect(
      await context.capabilities.findActionSimulationByAction(
        result.requestId,
        "project-1",
      ),
    ).toBeNull();
    const auditRows = context.database
      .query<{ event_type: string; payload_json: string }, []>(
        "SELECT event_type, payload_json FROM audit_event WHERE event_type LIKE 'action.%' ORDER BY occurred_at, id",
      )
      .all();
    expect(auditRows.map((row) => row.event_type)).toEqual([
      "action.requested",
      "action.authorized",
      "action.executing",
      "action.completed",
    ]);
    const auditText = JSON.stringify(auditRows);
    expect(auditText).not.toContain("export const value");
    expect(auditText).not.toContain(context.workspace);
    expect(auditText).toContain(
      createHash("sha256").update("export const value = 1;\n").digest("hex"),
    );
    context.database.close();
  });

  test("passes an already-aborted signal through the connector boundary", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      context.invoke.execute({
        ...input(context.resource, "filesystem.read", {
          path: "src/index.ts",
        }),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Filesystem operation was aborted");
    expect(
      (await context.capabilities.listActionRequests("project-1"))
        .at(-1)
        ?.snapshot().status,
    ).toBe("failed");
    context.database.close();
  });

  test("moves a controlled read failure to failed", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
      ),
    ).rejects.toThrow("Filesystem entry is unavailable");
    expect(
      (await context.capabilities.listActionRequests("project-1"))
        .at(-1)
        ?.snapshot().status,
    ).toBe("failed");
    context.database.close();
  });

  test("denies action:request when a normalized path exceeds effective limits", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"], { maxPathBytes: 5 });
    const result = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    expect(result).toMatchObject({ outcome: "denied" });
    expect(result.request.snapshot()).toMatchObject({
      status: "denied",
      decision: "deny",
      reasons: ["filesystem path exceeds effective path limits"],
    });
    expect(
      context.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM action_simulations",
        )
        .get()?.count,
    ).toBe(0);
    context.database.close();
  });

  test("simulates writes immutably and stores a distinct canonical artifact hash", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.write"], { allowMutation: true });
    const result = await context.invoke.execute(
      input(context.resource, "filesystem.write", {
        path: "src/index.ts",
        content: "export const value = 2;\n",
      }),
    );
    expect(result).toMatchObject({
      outcome: "approval_required",
      status: "approval_pending",
    });
    expect(
      readFileSync(join(context.workspace, "src", "index.ts"), "utf8"),
    ).toBe("export const value = 1;\n");
    const request = await context.capabilities.findActionRequest(
      result.requestId,
    );
    const simulation = await context.capabilities.findActionSimulationByAction(
      result.requestId,
      "project-1",
    );
    expect(simulation?.snapshot()).toMatchObject({
      actionRequestId: result.requestId,
      connector: "filesystem",
      connectorVersion: "2",
      operation: "filesystem.write",
    });
    expect(simulation?.snapshot().artifactSha256).not.toBe(
      request?.snapshot().payloadHash,
    );
    const persistedArtifact = simulation!.snapshot();
    expect(persistedArtifact.diffSha256).toBe(
      sha256Text(persistedArtifact.diff),
    );
    expect(persistedArtifact.artifactSha256).toBe(
      hashActionSimulationArtifact({
        schemaVersion: 1,
        actionRequestId: persistedArtifact.actionRequestId,
        authorizationPayloadHash: persistedArtifact.authorizationPayloadHash,
        connector: persistedArtifact.connector,
        connectorVersion: persistedArtifact.connectorVersion,
        operation: persistedArtifact.operation,
        preconditions: persistedArtifact.preconditions,
        diffSha256: persistedArtifact.diffSha256,
      }),
    );
    expect(simulation?.snapshot().preconditions).toEqual([
      {
        kind: "file",
        path: "src/index.ts",
        sha256: createHash("sha256")
          .update("export const value = 1;\n")
          .digest("hex"),
        size: 24,
      },
    ]);
    expect(
      context.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM action_simulations",
        )
        .get()?.count,
    ).toBe(1);
    expect(() =>
      context.database
        .prepare("UPDATE action_simulations SET diff='changed'")
        .run(),
    ).toThrow("action simulations are immutable");
    expect(() =>
      context.database.prepare("DELETE FROM action_simulations").run(),
    ).toThrow("action simulations cannot be deleted");
    await new SqliteProjectRepository(context.database).save(
      Project.create({
        id: "project-2",
        name: "Other",
        now: context.clock.now(),
      }),
    );
    expect(() =>
      context.database
        .prepare(
          `INSERT INTO action_simulations(
            id, project_id, action_request_id, authorization_payload_hash,
            connector, connector_version, operation, preconditions_json, diff,
            diff_sha256, artifact_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "cross-project-simulation",
          "project-2",
          persistedArtifact.actionRequestId,
          persistedArtifact.authorizationPayloadHash,
          persistedArtifact.connector,
          persistedArtifact.connectorVersion,
          persistedArtifact.operation,
          JSON.stringify(persistedArtifact.preconditions),
          persistedArtifact.diff,
          persistedArtifact.diffSha256,
          persistedArtifact.artifactSha256,
          persistedArtifact.createdAt.toISOString(),
        ),
    ).toThrow();
    context.database.close();
  });

  test("simulates delete through approval_pending and never executes a mutation", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.delete"], { allowMutation: true });
    const result = await context.invoke.execute(
      input(context.resource, "filesystem.delete", { path: "src/index.ts" }),
    );
    expect(result).toMatchObject({
      outcome: "approval_required",
      status: "approval_pending",
    });
    expect(
      readFileSync(join(context.workspace, "src", "index.ts"), "utf8"),
    ).toBe("export const value = 1;\n");
    const events = context.database
      .query<{ event_type: string }, [string]>(
        "SELECT event_type FROM audit_event WHERE aggregate_id=? ORDER BY occurred_at, id",
      )
      .all(result.requestId)
      .map((row) => row.event_type);
    expect(events).not.toContain("action.executing");
    expect(events).toContain("action.approval_pending");
    context.database.close();
  });

  test("denies by default, after revocation, and after resource disable", async () => {
    const context = await fixture();
    expect(
      await context.invoke.execute(
        input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
      ),
    ).toMatchObject({ outcome: "denied", status: "denied" });
    const capability = await grant(context, ["filesystem.read"]);
    await new RevokeCapabilityGrant(
      context.capabilities,
      context.audit,
      context.clock,
      context.transactions,
    ).execute({
      projectId: "project-1",
      grantId: capability.id,
      revokedBy: "owner",
    });
    expect(
      await context.invoke.execute(
        input(context.resource, "filesystem.read", { path: "src/index.ts" }),
      ),
    ).toMatchObject({ outcome: "denied", status: "denied" });
    await new DisableResource(
      context.capabilities,
      context.audit,
      context.clock,
      context.transactions,
    ).execute({ projectId: "project-1", resourceId: context.resource.id });
    expect(
      await context.invoke.execute(
        input(context.resource, "filesystem.read", { path: "src/index.ts" }),
      ),
    ).toMatchObject({ outcome: "denied", status: "denied" });
    context.database.close();
  });

  test("rolls back simulation artifact and state when its audit append fails", async () => {
    const context = await fixture({ failSimulatedAudit: true });
    await grant(context, ["filesystem.write"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/index.ts",
          content: "changed\n",
        }),
      ),
    ).rejects.toThrow("simulated audit unavailable");
    expect(
      context.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM action_simulations",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      (await context.capabilities.listActionRequests("project-1"))
        .at(-1)
        ?.snapshot().status,
    ).toBe("failed");
    expect(
      readFileSync(join(context.workspace, "src", "index.ts"), "utf8"),
    ).toBe("export const value = 1;\n");
    context.database.close();
  });

  test("database blocks mode bypasses and simulated state without an artifact", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.write"], { allowMutation: true });
    const request = new RequestControlledAction(
      new EvaluateActionPolicy(
        new SqliteAgentRuntimeRepository(context.database),
        context.capabilities,
        context.clock,
        createDefaultConnectorRegistry(),
      ),
      context.capabilities,
      context.audit,
      new TestIds(),
      context.clock,
      context.transactions,
    );
    const requested = await request.execute(
      input(context.resource, "filesystem.write", {
        path: "src/index.ts",
        content: "changed\n",
      }),
    );
    const id = requested.request.snapshot().id;
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='executing', updated_at=? WHERE id=?",
        )
        .run(context.clock.now().toISOString(), id),
    ).toThrow("invalid action request status transition");
    context.database
      .prepare(
        "UPDATE action_requests SET status='simulating', updated_at=? WHERE id=?",
      )
      .run(context.clock.now().toISOString(), id);
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='simulated', updated_at=? WHERE id=?",
        )
        .run(context.clock.now().toISOString(), id),
    ).toThrow("simulated action requires a matching artifact");
    expect(() =>
      context.database
        .prepare(
          `INSERT INTO action_simulations(
            id, project_id, action_request_id, authorization_payload_hash,
            connector, connector_version, operation, preconditions_json, diff,
            diff_sha256, artifact_sha256, created_at
          ) SELECT 'contradictory', project_id, id, payload_hash, connector,
            connector_version, operation, ?, 'diff', ?, ?, ?
          FROM action_requests WHERE id=?`,
        )
        .run(
          JSON.stringify([
            {
              kind: "file",
              path: "src/index.ts",
              sha256: "b".repeat(64),
              size: 1,
            },
            { kind: "absent", path: "src/index.ts" },
          ]),
          "c".repeat(64),
          "d".repeat(64),
          context.clock.now().toISOString(),
          id,
        ),
    ).toThrow("simulation preconditions contain a forbidden field");
    context.database.close();
  });

  test("database binds lifecycle transitions to descriptor decision semantics", async () => {
    const context = await fixture();
    const insert = (
      id: string,
      operation: string,
      decision: "allow" | "allow_simulation_only" | "allow_with_approval",
    ) => {
      context.database
        .prepare(
          `INSERT INTO action_requests(
            id, project_id, agent_id, resource_id, connector, connector_version,
            operation, normalized_arguments_json, effective_constraints_json,
            payload_hash, decision, risk_level, matched_grant_ids_json,
            reasons_json, status, created_at, updated_at
          ) VALUES (?, 'project-1', 'agent-1', ?, 'filesystem', '1', ?, '{}',
            '{}', ?, ?, 'medium', '[]', '[]', 'requested', ?, ?)`,
        )
        .run(
          id,
          context.resource.id,
          operation,
          "a".repeat(64),
          decision,
          context.clock.now().toISOString(),
          context.clock.now().toISOString(),
        );
      context.database
        .prepare(
          "UPDATE action_requests SET status='authorized', updated_at=? WHERE id=?",
        )
        .run(context.clock.now().toISOString(), id);
    };
    insert("wrong-read", "filesystem.read", "allow_simulation_only");
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='executing', updated_at=? WHERE id='wrong-read'",
        )
        .run(context.clock.now().toISOString()),
    ).toThrow("invalid action request status transition");

    insert("wrong-mutation", "filesystem.create", "allow");
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='simulating', updated_at=? WHERE id='wrong-mutation'",
        )
        .run(context.clock.now().toISOString()),
    ).toThrow("invalid action request status transition");

    insert("wrong-delete", "filesystem.delete", "allow_simulation_only");
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='simulating', updated_at=? WHERE id='wrong-delete'",
        )
        .run(context.clock.now().toISOString()),
    ).toThrow("invalid action request status transition");

    insert("wrong-approval", "filesystem.create", "allow_with_approval");
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='simulating', updated_at=? WHERE id='wrong-approval'",
        )
        .run(context.clock.now().toISOString()),
    ).toThrow("invalid action request status transition");

    insert(
      "no-approval-operation",
      "filesystem.create",
      "allow_simulation_only",
    );
    context.database
      .prepare(
        "UPDATE action_requests SET status='simulating', updated_at=? WHERE id='no-approval-operation'",
      )
      .run(context.clock.now().toISOString());
    context.database
      .prepare(
        `INSERT INTO action_simulations(
          id, project_id, action_request_id, authorization_payload_hash,
          connector, connector_version, operation, preconditions_json, diff,
          diff_sha256, artifact_sha256, created_at
        ) VALUES ('no-approval-artifact', 'project-1', 'no-approval-operation', ?,
          'filesystem', '1', 'filesystem.create', '[{"kind":"absent","path":"x"}]',
          'diff', ?, ?, ?)`,
      )
      .run(
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        context.clock.now().toISOString(),
      );
    context.database
      .prepare(
        "UPDATE action_requests SET status='simulated', updated_at=? WHERE id='no-approval-operation'",
      )
      .run(context.clock.now().toISOString());
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='approval_pending', updated_at=? WHERE id='no-approval-operation'",
        )
        .run(context.clock.now().toISOString()),
    ).toThrow("invalid action request status transition");
    context.database.close();
  });
});

async function expectNoSimulationAndStatus(
  context: Awaited<ReturnType<typeof fixture>>,
  status: string,
): Promise<void> {
  expect(
    context.database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM action_simulations",
      )
      .get()?.count,
  ).toBe(0);
  expect(
    (await context.capabilities.listActionRequests("project-1"))
      .at(-1)
      ?.snapshot().status,
  ).toBe(status);
}

describe("M6B simulation failure lifecycle", () => {
  test("precondition validation failure becomes failed", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.create"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.create", {
          path: "missing/new.ts",
          content: "new\n",
        }),
      ),
    ).rejects.toThrow("Filesystem entry is unavailable");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("file open failure becomes failed", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.write"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/missing.ts",
          content: "new\n",
        }),
      ),
    ).rejects.toThrow("Filesystem entry is unavailable");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("UTF-8 validation failure becomes failed", async () => {
    const context = await fixture();
    writeFileSync(
      join(context.workspace, "src", "invalid.ts"),
      Buffer.from([0xc3, 0x28]),
    );
    await grant(context, ["filesystem.write"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/invalid.ts",
          content: "new\n",
        }),
      ),
    ).rejects.toThrow("Filesystem content is not valid UTF-8 text");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("diff limit failure becomes failed", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.write"], {
      allowMutation: true,
      maxDiffBytes: 20,
    });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/index.ts",
          content: "replacement that cannot fit\n",
        }),
      ),
    ).rejects.toThrow("simulation diff exceeds");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("source hash calculation failure becomes failed", async () => {
    const hashFailureDefinition: ConnectorDefinition = {
      ...filesystemConnectorDefinition,
      invoke: async (invocation) => {
        if (invocation.resource.externalRef === undefined)
          throw new Error("missing test root");
        return new FilesystemSandbox(
          invocation.resource.externalRef,
          parseEffectiveFilesystemConstraints(invocation.effectiveConstraints),
          {
            hashBytes: () => {
              throw new Error("source hash calculation failed");
            },
          },
        ).invoke(invocation.operation, invocation.arguments);
      },
    };
    const context = await fixture({
      connectors: new ConnectorRegistry([hashFailureDefinition]),
    });
    await grant(context, ["filesystem.write"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/index.ts",
          content: "new\n",
        }),
      ),
    ).rejects.toThrow("source hash calculation failed");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("artifact persistence failure occurs before transition and becomes failed", async () => {
    const context = await fixture({ repositoryFailure: "simulation-insert" });
    await grant(context, ["filesystem.write"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/index.ts",
          content: "new\n",
        }),
      ),
    ).rejects.toThrow("already has a simulation");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("transition failure after artifact insert rolls both writes back", async () => {
    const context = await fixture({
      repositoryFailure: "simulated-transition",
    });
    await grant(context, ["filesystem.write"], { allowMutation: true });
    await expect(
      context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/index.ts",
          content: "new\n",
        }),
      ),
    ).rejects.toThrow("cannot transition to simulated");
    await expectNoSimulationAndStatus(context, "failed");
    context.database.close();
  });

  test("leaves a recoverable simulating action when artifact and failure CAS both fail", async () => {
    const context = await fixture({
      repositoryFailure: "simulation-and-recovery",
    });
    await grant(context, ["filesystem.write"], { allowMutation: true });
    const secret = "recovery-secret-must-not-leak";
    let caught: unknown;
    try {
      await context.invoke.execute(
        input(context.resource, "filesystem.write", {
          path: "src/index.ts",
          content: secret,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("cannot transition to failed");
    expect((caught as Error).message).not.toContain(secret);
    expect((caught as Error).message).not.toContain(context.workspace);
    await expectNoSimulationAndStatus(context, "simulating");
    const audit = context.database
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM audit_event",
      )
      .all()
      .map((row) => row.payload_json)
      .join("\n");
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain(context.workspace);
    context.database.close();
  });
});

describe("M6B fresh authorization before invocation", () => {
  test("revocation between evaluation and CAS denies the lease without I/O", async () => {
    const context = await fixture();
    const capability = await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    const invoke = invokeWithHooks(context, {
      afterEvaluationBeforeCas: async () => {
        expect(
          await context.capabilities.revokeGrant(
            capability.id,
            "project-1",
            context.clock.now(),
          ),
        ).toBe(true);
      },
    });
    await expect(
      invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    await expectNoSimulationAndStatus(context, "authorized");
    expect(
      (await context.capabilities.findGrant(capability.id))?.revokedAt,
    ).toBeDefined();
    context.database.close();
  });

  test("resource disable between evaluation and CAS denies the lease", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    const invoke = invokeWithHooks(context, {
      afterEvaluationBeforeCas: async () => {
        expect(
          await context.capabilities.disableResource(
            context.resource.id,
            "project-1",
            context.clock.now(),
          ),
        ).toBe(true);
      },
    });
    await expect(
      invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    await expectNoSimulationAndStatus(context, "authorized");
    expect(
      (await context.capabilities.findResource(context.resource.id))?.status,
    ).toBe("disabled");
    context.database.close();
  });

  test("revocation after CAS does not cancel the acquired in-flight lease", async () => {
    const context = await fixture();
    const capability = await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/index.ts" }),
    );
    const invoke = invokeWithHooks(context, {
      afterCas: async () => {
        expect(
          await context.capabilities.revokeGrant(
            capability.id,
            "project-1",
            context.clock.now(),
          ),
        ).toBe(true);
      },
    });
    await expect(
      invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(
      (await context.capabilities.findGrant(capability.id))?.revokedAt,
    ).toBeDefined();
    context.database.close();
  });

  test("revoked matched grant blocks mutation before filesystem access", async () => {
    const context = await fixture();
    const capability = await grant(context, ["filesystem.write"], {
      allowMutation: true,
    });
    const requested = await context.request.execute(
      input(context.resource, "filesystem.write", {
        path: "src/index.ts",
        content: "changed\n",
      }),
    );
    await new RevokeCapabilityGrant(
      context.capabilities,
      context.audit,
      context.clock,
      context.transactions,
    ).execute({
      projectId: "project-1",
      grantId: capability.id,
      revokedBy: "owner",
    });
    await expect(
      context.invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    await expectNoSimulationAndStatus(context, "authorized");
    expect(
      readFileSync(join(context.workspace, "src", "index.ts"), "utf8"),
    ).toBe("export const value = 1;\n");
    context.database.close();
  });

  test("expired matched grant blocks read before opening the file", async () => {
    const context = await fixture();
    const expiresAt = new Date(context.clock.now().getTime() + 100);
    await grant(context, ["filesystem.read"], {}, expiresAt);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    context.clock.advance(1000);
    await expect(
      context.invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    await expectNoSimulationAndStatus(context, "authorized");
    context.database.close();
  });

  test("disabled resource blocks read before opening the file", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    await new DisableResource(
      context.capabilities,
      context.audit,
      context.clock,
      context.transactions,
    ).execute({ projectId: "project-1", resourceId: context.resource.id });
    await expect(
      context.invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    await expectNoSimulationAndStatus(context, "authorized");
    context.database.close();
  });

  test("missing connector definition blocks invocation before file access", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    const emptyRegistry = new ConnectorRegistry([]);
    const emptyEvaluator = new EvaluateActionPolicy(
      context.runtime,
      context.capabilities,
      context.clock,
      emptyRegistry,
    );
    const withoutConnector = new InvokeControlledConnectorAction(
      context.request,
      context.capabilities,
      context.audit,
      context.ids,
      context.clock,
      context.transactions,
      emptyRegistry,
      emptyEvaluator,
      context.controlled,
    );
    await expect(
      withoutConnector.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toThrow("Unsupported connector provider: filesystem");
    await expectNoSimulationAndStatus(context, "authorized");
    context.database.close();
  });

  test("a replaced connector version invalidates the stored authorization", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/missing.ts" }),
    );
    const replacement: ConnectorDefinition = {
      ...filesystemConnectorDefinition,
      descriptor: {
        ...filesystemConnectorDefinition.descriptor,
        version: "3",
      },
    };
    const replacementRegistry = new ConnectorRegistry([replacement]);
    const replacementEvaluator = new EvaluateActionPolicy(
      context.runtime,
      context.capabilities,
      context.clock,
      replacementRegistry,
    );
    const replacedConnector = new InvokeControlledConnectorAction(
      context.request,
      context.capabilities,
      context.audit,
      context.ids,
      context.clock,
      context.transactions,
      replacementRegistry,
      replacementEvaluator,
      context.controlled,
    );

    await expect(
      replacedConnector.invokeAuthorized({
        projectId: "project-1",
        actionRequestId: requested.request.snapshot().id,
      }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    await expectNoSimulationAndStatus(context, "authorized");
    context.database.close();
  });

  test("the same action cannot be invoked twice", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/index.ts" }),
    );
    const actionRequestId = requested.request.snapshot().id;
    await expect(
      context.invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      context.invoke.invokeAuthorized({
        projectId: "project-1",
        actionRequestId,
      }),
    ).rejects.toBeInstanceOf(InvalidConnectorInvocationStateError);
    expect(
      context.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM action_requests WHERE id=? AND status='completed'",
        )
        .get(actionRequestId)?.count,
    ).toBe(1);
    context.database.close();
  });

  test("two concurrent invokes acquire at most one authorization lease", async () => {
    const context = await fixture();
    await grant(context, ["filesystem.read"]);
    const requested = await context.request.execute(
      input(context.resource, "filesystem.read", { path: "src/index.ts" }),
    );
    const invocation = {
      projectId: "project-1",
      actionRequestId: requested.request.snapshot().id,
    };
    const results = await Promise.allSettled([
      context.invoke.invokeAuthorized(invocation),
      context.invoke.invokeAuthorized(invocation),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        await context.capabilities.findActionRequest(invocation.actionRequestId)
      )?.snapshot().status,
    ).toBe("completed");
    context.database.close();
  });
});

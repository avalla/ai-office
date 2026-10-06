import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateCapabilityGrant } from "@ai-office/application/capability/create-capability-grant.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { RegisterResource } from "@ai-office/application/capability/register-resource.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { CapabilityPrincipalNotFoundError } from "@ai-office/application/capability-errors.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { EvaluatePipelineAuthorization } from "@ai-office/application/pipeline/evaluate-pipeline-authorization.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import { fakeConnectorDescriptor } from "@ai-office/connector-sdk/fake-connector.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { createOperationProviderCatalog } from "@ai-office/runtime-host/operation-provider-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

// GP-16 criterion 11 and 12: a pack binding grants nothing. The real policy
// engine, gateway and SQLite storage run twice, once with a pack bound whose
// capability requires the requested operations and once without any pack.
// The same differential runs inside an enforced pipeline stage, where the
// pipeline gate is conjunctive with the policy engine.
// PostgreSQL has no `capabilities` or `controlled` storage port, so this
// evidence is SQLite-only.

const now = new Date("2026-10-06T00:00:00.000Z");
const encoder = new TextEncoder();
const noGrant = "no valid grant permits the operation";
const packRoleId = "pack:org.example.ops/roles/operator";

const draft = {
  schemaVersion: 1,
  id: "org.example.ops",
  version: "1.0.0",
  manifestDigest: `sha256:${"0".repeat(64)}`,
  coreContract: { minInclusive: 1, maxExclusive: 3 },
  metadata: { name: "ops", description: "Requires fake operations" },
  dependencies: [],
  contributions: {
    ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
    roles: [{ id: "operator", capabilities: ["operate"] }],
    agents: [{ id: "bot", role: "operator", capabilities: ["operate"] }],
    capabilities: [
      {
        id: "operate",
        operations: [
          { operation: "fake.read", mode: "read" },
          { operation: "fake.write", mode: "mutation" },
          { operation: "fake.delete", mode: "mutation" },
          { operation: "fake.admin", mode: "mutation" },
        ],
      },
    ],
  },
};
const packBytes = encoder.encode(
  JSON.stringify({
    ...draft,
    manifestDigest: computeManifestDigest(
      parseDomainPackManifest(encoder.encode(JSON.stringify(draft))),
    ),
  }),
);
const { id, version, manifestDigest } = parseDomainPackManifest(packBytes);
const pack: PackIdentity = { id, version, manifestDigest };

// One enforced stage for the Runtime role. Its legacy stage `capabilities`
// are what the pipeline gate matches; the pack requires more operations than
// the stage permits, and the stage permits one the agent holds no grant for.
const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Operate",
    goals: ["Operate safely"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Gated office",
    roles: [
      {
        id: "operator",
        title: "Operator",
        purpose: "Operate",
        responsibilities: ["Operate"],
      },
    ],
  },
  pipelines: [
    {
      id: "operation",
      name: "Operation",
      description: "One enforced stage",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "operate",
          name: "Operate",
          roleId: "operator",
          objective: "Operate",
          checks: ["Done"],
          requiresApproval: false,
          capabilities: ["fake.read", "fake.admin"],
        },
      ],
    },
  ],
};

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const sequence = (prefix: string) => {
  let next = 0;
  return { generate: () => `${prefix}-${++next}` };
};

/** One project with a Runtime role, an agent and a fake resource. */
async function world(bound: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp16-grants-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  closers.push(() => database.close());
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const capabilities = new SqliteCapabilityPolicyRepository(database);
  const connectors = createDefaultConnectorRegistry();
  const clock = { now: () => new Date(now) };
  const ids = sequence("action");
  const audit = new RecordAuditEvent(storage.auditEvents, ids, clock);
  await storage.projects.save(
    Project.create({ id: "project-1", name: "One", now }),
  );
  await runtime.saveRole(
    Role.create({
      id: "role-1",
      projectId: "project-1",
      // The Runtime role shares the pack role's local ID on purpose.
      key: "operator",
      name: "Operator",
      version: 1,
      capabilities: ["operate"],
      tools: [],
      modelPolicy: "mock",
      limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
      sourcePath: "agents/operator",
      now,
    }),
  );
  await runtime.saveAgent({
    id: "agent-1",
    projectId: "project-1",
    roleId: "role-1",
    name: "bot",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const resource = await new RegisterResource(
    storage.projects,
    capabilities,
    audit,
    ids,
    clock,
    storage.transactions,
    connectors,
  ).execute({
    projectId: "project-1",
    type: "filesystem_scope",
    provider: "fake",
    displayName: "Logical fake",
    configuration: {},
  });

  if (bound) {
    const catalog = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    catalog.register({
      bytes: packBytes,
      artifactDigest: computeArtifactDigest(packBytes),
      provenance: { installerId: "local-distribution", reference: "fixture" },
    });
    const ports = {
      projects: storage.projects,
      bindings: storage.packBindings,
      definitions: storage.definitions,
      catalog,
      // The catalog the host builds from the registry the gateway uses.
      providers: createOperationProviderCatalog(connectors),
      auditEvents: storage.auditEvents,
      transactions: storage.transactions,
      clock,
      ids: sequence("pack"),
    };
    await new ManageProjectPackBinding(ports).apply({
      projectId: "project-1",
      desired: [pack],
      expectedRevision: 0,
      actorId: "local-operator",
    });
    // The binding resolves: every required operation has its provider.
    const configuration = await new ReadProjectConfiguration(ports).read(
      "project-1",
    );
    expect(configuration.capabilities).toEqual([
      {
        capabilityId: "pack:org.example.ops/capabilities/operate",
        requirement: "required",
        operations: ["admin", "delete", "read", "write"].map((name) => ({
          operation: `fake.${name}`,
          mode: name === "read" ? "read" : "mutation",
          binding: "bound",
          provider: { id: "fake", version: "1" },
        })),
      },
    ]);
    expect(configuration.roles).toMatchObject([{ roleId: packRoleId }]);
  }

  const request = new RequestControlledAction(
    new EvaluateActionPolicy(runtime, capabilities, clock, connectors),
    capabilities,
    audit,
    ids,
    clock,
    storage.transactions,
  );
  const grants = new CreateCapabilityGrant(
    storage.projects,
    runtime,
    capabilities,
    audit,
    ids,
    clock,
    storage.transactions,
    connectors,
  );
  const summary = (result: { request: ActionRequest; outcome: string }) => {
    const {
      decision,
      riskLevel,
      reasons,
      matchedGrantIds,
      status,
      pipelineRunId,
      pipelineStageRunId,
    } = result.request.snapshot();
    return {
      outcome: result.outcome,
      decision,
      riskLevel,
      reasons,
      matchedGrantIds,
      status,
      pipelineRunId,
      pipelineStageRunId,
    };
  };
  const ask = async (operation: string) =>
    summary(
      await request.execute({
        projectId: "project-1",
        agentId: "agent-1",
        resourceId: resource.id,
        operation,
        arguments: { target: "readme" },
      }),
    );
  // The agent-run gateway with the pipeline gate, as the Runtime host
  // composes it: the pipeline context comes from the persisted AgentRun.
  const gated = new RequestControlledAction(
    new EvaluateActionPolicy(
      runtime,
      capabilities,
      clock,
      connectors,
      new EvaluatePipelineAuthorization(storage.pipelines),
    ),
    capabilities,
    audit,
    ids,
    clock,
    storage.transactions,
    runtime,
  );
  const pipelineRuns = new ManagePipelineRuns(
    storage.officeManifests,
    storage.pipelines,
    storage.tasks,
    runtime,
    audit,
    ids,
    clock,
    storage.transactions,
  );
  let tasks = 0;
  /**
   * One request from an AgentRun of the agent assigned to the active stage
   * of a fresh enforced pipeline run, so every call meets the pipeline gate.
   */
  const askInPipeline = async (operation: string) => {
    if (tasks === 0)
      await storage.officeManifests.save({
        id: "manifest-1",
        projectId: "project-1",
        revision: 1,
        manifest,
        appliedAt: now,
      });
    const taskId = `task-${++tasks}`;
    await storage.tasks.save(
      Task.create({ id: taskId, projectId: "project-1", title: taskId, now }),
    );
    const pipelineRun = await pipelineRuns.start({
      projectId: "project-1",
      taskId,
      pipelineId: "operation",
      principal: localOperatorPrincipal,
    });
    await pipelineRuns.assign({
      projectId: "project-1",
      pipelineRunId: pipelineRun.snapshot().id,
      agentId: "agent-1",
      principal: localOperatorPrincipal,
    });
    const agentRunId = await new ScheduleAgentRun(
      storage.projects,
      storage.tasks,
      runtime,
      ids,
      clock,
      storage.transactions,
      storage.pipelines,
    ).execute({
      projectId: "project-1",
      taskId,
      agentId: "agent-1",
      actionIntent: {
        resourceId: resource.id,
        operation,
        arguments: { target: "readme" },
      },
    });
    const agentRun = (await runtime.findRun(agentRunId))!;
    agentRun.transition("preparing", now);
    agentRun.transition("running", now);
    await runtime.saveRun(agentRun);
    return summary(await gated.executeFromAgentRun(agentRunId));
  };
  const grant = (
    principalType: "agent" | "role",
    principalId: string,
    actions: string[],
    constraints: Record<string, unknown> = {},
  ) =>
    grants.execute({
      projectId: "project-1",
      principalType,
      principalId,
      resourceId: resource.id,
      actions,
      constraints,
      grantedBy: "owner",
      reason: "GP-16 test",
    });
  /** Everything but the binding's own audit event, in order. */
  const securityAudit = () =>
    database
      .query<Record<string, string>, []>(
        `SELECT id, event_type, actor_type, actor_id, aggregate_type,
                aggregate_id, payload_json
           FROM audit_event
          WHERE event_type NOT LIKE 'project.pack_%' ORDER BY rowid`,
      )
      .all();
  const rows = (table: string) =>
    database
      .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
      .get()!.count;
  return {
    database,
    resource,
    ask,
    askInPipeline,
    grant,
    securityAudit,
    rows,
  };
}

const operations = ["fake.read", "fake.write", "fake.delete", "fake.admin"];

describe("GP-16: a pack binding grants nothing (SQLite, real gateway)", () => {
  test("without a grant every bound required operation is denied, exactly as without the pack", async () => {
    const plain = await world(false);
    const bound = await world(true);
    for (const operation of operations) {
      const expected = await plain.ask(operation);
      const actual = await bound.ask(operation);
      expect(actual, operation).toEqual(expected);
      expect(actual, operation).toMatchObject({
        outcome: "denied",
        decision: "deny",
        matchedGrantIds: [],
        reasons: [noGrant],
      });
    }
    expect(bound.securityAudit()).toEqual(plain.securityAudit());
    expect(bound.securityAudit().length).toBeGreaterThan(operations.length);
    // The binding registered no resource and created no grant.
    expect(bound.rows("resources")).toBe(1);
    expect(bound.rows("capability_grants")).toBe(0);
    expect(bound.rows("action_requests")).toBe(operations.length);
    expect(bound.rows("action_requests")).toBe(plain.rows("action_requests"));
  });

  test("with a grant the existing policy decides, identically with and without the pack", async () => {
    const plain = await world(false);
    const bound = await world(true);
    for (const host of [plain, bound])
      await host.grant("agent", "agent-1", operations);
    const decisions: Record<string, unknown> = {};
    for (const operation of operations) {
      const expected = await plain.ask(operation);
      const actual = await bound.ask(operation);
      expect(actual, operation).toEqual(expected);
      expect(actual.reasons, operation).not.toContain(noGrant);
      decisions[operation] = actual.riskLevel;
    }
    // Naming an operation in a pack changes no risk level: the descriptor's.
    expect(decisions).toEqual(
      Object.fromEntries(
        fakeConnectorDescriptor.operations.map(({ operation, riskLevel }) => [
          operation,
          riskLevel,
        ]),
      ),
    );
    expect(bound.securityAudit()).toEqual(plain.securityAudit());
  });

  test("inside an enforced pipeline stage the pipeline gate decides, identically with and without the pack", async () => {
    const plain = await world(false);
    const bound = await world(true);
    // No grant for fake.admin; fake.write is granted but is not a stage
    // capability. The pack requires both, bound to the fake connector.
    for (const host of [plain, bound])
      await host.grant("agent", "agent-1", ["fake.read", "fake.write"], {
        allowMutation: true,
      });
    const decided: Record<string, Awaited<ReturnType<typeof bound.ask>>> = {};
    for (const operation of ["fake.read", "fake.write", "fake.admin"]) {
      const expected = await plain.askInPipeline(operation);
      const actual = await bound.askInPipeline(operation);
      expect(actual, operation).toEqual(expected);
      // The request really carried the pipeline context of its AgentRun.
      expect(actual.pipelineRunId, operation).toEqual(expect.any(String));
      expect(actual.pipelineStageRunId, operation).toEqual(expect.any(String));
      decided[operation] = actual;
    }
    expect(decided["fake.read"]).toMatchObject({
      outcome: "allowed",
      decision: "allow",
      reasons: ["operation risk is low"],
    });
    // Granted, required by the bound pack and provided, yet outside the
    // stage: the gate denies it. The policy engine alone would not have.
    expect(decided["fake.write"]).toMatchObject({
      outcome: "denied",
      decision: "deny",
    });
    expect(decided["fake.write"]!.reasons).toContain(
      "pipeline_capability_denied",
    );
    expect(decided["fake.write"]!.reasons).not.toContain(noGrant);
    const direct = await bound.ask("fake.write");
    expect(direct).toEqual(await plain.ask("fake.write"));
    expect(direct.outcome).not.toBe("denied");
    expect(direct.pipelineRunId).toBeUndefined();
    // A stage capability the pack also requires, with no grant: the stage
    // and the binding together still grant nothing.
    expect(decided["fake.admin"]).toMatchObject({
      outcome: "denied",
      matchedGrantIds: [],
      reasons: [noGrant],
    });
    const audit = bound.securityAudit();
    expect(audit).toEqual(plain.securityAudit());
    expect(audit.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(["pipeline.started", "action.requested"]),
    );
  });

  test("a critical operation named by a pack keeps its risk and approval requirement", async () => {
    const plain = await world(false);
    const bound = await world(true);
    // The fake connector denies a mutation unless a grant constraint allows
    // it; the pack's declared mode does not stand in for that constraint.
    for (const host of [plain, bound])
      await host.grant("agent", "agent-1", ["fake.admin", "fake.delete"], {
        allowMutation: true,
      });
    const admin = await bound.ask("fake.admin");
    expect(admin).toEqual(await plain.ask("fake.admin"));
    expect(admin).toMatchObject({
      riskLevel: "critical",
      decision: "allow_with_approval",
      reasons: ["operation risk is critical", "approval is required"],
    });
    expect(admin.outcome).not.toBe("allowed");
    const remove = await bound.ask("fake.delete");
    expect(remove).toEqual(await plain.ask("fake.delete"));
    expect(remove).toMatchObject({
      riskLevel: "high",
      decision: "allow_with_approval",
    });
    // A wildcard grant never covers a critical operation, pack or not.
    const wide = await world(true);
    await wide.grant("agent", "agent-1", ["fake.*"]);
    expect(await wide.ask("fake.admin")).toMatchObject({
      outcome: "denied",
      reasons: [noGrant],
    });
  });

  test("a grant whose principal is a pack roleId matches nothing", async () => {
    const bound = await world(true);
    for (const principalType of ["role", "agent"] as const)
      await expect(
        bound.grant(principalType, packRoleId, operations),
      ).rejects.toBeInstanceOf(CapabilityPrincipalNotFoundError);
    for (const principalId of [
      "pack:org.example.ops/agents/bot",
      "pack:org.example.ops/capabilities/operate",
      "operator",
    ])
      await expect(
        bound.grant("role", principalId, operations),
      ).rejects.toBeInstanceOf(CapabilityPrincipalNotFoundError);
    // A row written past the service, if storage lets it in at all.
    for (const principalType of ["role", "agent", "user"]) {
      try {
        bound.database
          .prepare(
            `INSERT INTO capability_grants(
               id, project_id, principal_type, principal_id, resource_id,
               actions_json, constraints_json, valid_from, granted_by, reason,
               created_at
             ) VALUES (?, 'project-1', ?, ?, ?, ?, '{}', ?, 'owner', 'forged', ?)`,
          )
          .run(
            `forged-${principalType}`,
            principalType,
            packRoleId,
            bound.resource.id,
            JSON.stringify(operations),
            now.toISOString(),
            now.toISOString(),
          );
      } catch {
        // Rejected by a storage constraint: it matches nothing either way.
      }
    }
    for (const operation of operations)
      expect(await bound.ask(operation), operation).toMatchObject({
        outcome: "denied",
        matchedGrantIds: [],
        reasons: [noGrant],
      });
  });
});

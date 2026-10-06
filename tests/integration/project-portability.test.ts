import { afterEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import type { CapabilityPolicyRepository } from "@ai-office/application/ports/capability-policy-repository.port.ts";
import {
  ManageProjectPortability,
  ProjectRestorePartialError,
} from "@ai-office/application/project-portability/manage-project-portability.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import {
  createPortableProjectArchive,
  portableProjectArchiveSchemaV6,
  portableProjectArchiveSchemaV7,
  portableProjectArchiveSchemaV8,
  portableProjectArchiveSchemaV9,
  portableProjectFormatVersionFor,
  portableProjectFormatVersions,
  portableProjectManifestFor,
  portableStateAtFormatVersion,
  portableStateChecksum,
  parsePortableProjectArchive,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import { SqliteProjectDefinitionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-definition.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteTaskRequirementRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-requirement.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { LocalProjectBindingAdapter } from "@ai-office/runtime-host/local-project-binding-adapter.ts";
import { LocalProjectScanner } from "@ai-office/runtime-host/local-project-scanner.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackId,
  parseDomainPackManifest,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";

const roots: string[] = [];
const migrations = join(process.cwd(), "migrations", "project");

class ExactTestRootBindingAdapter extends LocalProjectBindingAdapter {
  override async resolveProjectRoot(inputPath: string): Promise<string> {
    // Fixture roots are standalone even if the host has an unrelated ancestor .git.
    return realpathSync(inputPath);
  }
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function openRuntime(root: string) {
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrations);
  const projects = new SqliteProjectRepository(database);
  const profiles = new SqliteProjectProfileRepository(database);
  const identities = new SqliteRepositoryIdentityRepository(database);
  const states = new SqliteProjectStateRepository(database);
  const governance = new SqliteGovernanceRepository(database);
  const agentRuntime = new SqliteAgentRuntimeRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const ids = new CryptoIdGenerator();
  const clock = new SystemClock();
  const service = new ManageProjectPortability({
    projects,
    profiles,
    identities,
    states,
    bindings: new ExactTestRootBindingAdapter(),
    scanner: new LocalProjectScanner(),
    transactions,
    ids,
    clock,
  });
  return {
    database,
    projects,
    profiles,
    identities,
    states,
    governance,
    agentRuntime,
    transactions,
    ids,
    clock,
    service,
  };
}

async function importProject(
  runtime: ReturnType<typeof openRuntime>,
  source: string,
) {
  return new ImportProject(
    runtime.projects,
    runtime.profiles,
    new LocalProjectScanner(),
    runtime.identities,
    runtime.ids,
    runtime.clock,
    runtime.transactions,
  ).execute({ rootPath: source });
}

async function createTask(
  runtime: ReturnType<typeof openRuntime>,
  projectId: string,
  title: string,
): Promise<string> {
  return new CreateTask(
    runtime.projects,
    new SqliteTaskRepository(runtime.database),
    runtime.ids,
    runtime.clock,
  ).execute({ projectId, title });
}

async function createAgent(
  runtime: ReturnType<typeof openRuntime>,
  projectId: string,
  suffix: string,
) {
  const now = runtime.clock.now();
  const roleId = `role-${suffix}`;
  const agentId = `agent-${suffix}`;
  await runtime.agentRuntime.saveRole(
    Role.create({
      id: roleId,
      projectId,
      key: `role-${suffix}`,
      name: `Role ${suffix}`,
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "default",
      limits: {
        maxIterations: 1,
        maxCostMicros: 0n,
        timeoutSeconds: 60,
      },
      sourcePath: `/machine-local/${suffix}.json`,
      now,
    }),
  );
  await runtime.agentRuntime.saveAgent({
    id: agentId,
    projectId,
    roleId,
    name: `Agent ${suffix}`,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return { roleId, agentId };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project portability", () => {
  test("format-6 definition text uses GP-07's Unicode contract", () => {
    const schema = portableProjectArchiveSchemaV6.shape.state.shape.definitions;
    const owned = (kind: "roles" | "workflows", payload: object) => ({
      revision: 1,
      owned: [
        {
          origin: "project_owned",
          kind,
          id: "custom",
          revision: 1,
          enabled: true,
          payload,
          actorId: "operator",
          changedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
      overrides: [],
    });
    const override = (operation: "replace" | "extend", payload: object) => ({
      revision: 1,
      owned: [],
      overrides: [
        {
          origin: "project_override",
          source: {
            id: "org.example.legal",
            version: "1.0.0",
            manifestDigest: `sha256:${"a".repeat(64)}`,
            kind: "roles",
            localId: "custom",
          },
          operation,
          revision: 1,
          payload,
          actorId: "operator",
          changedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
    });
    const workflow = (fields: object) => ({
      id: "custom",
      taskType: "task",
      stages: [],
      ...fields,
    });

    for (const state of [
      owned("roles", { id: "custom", title: "\ud800" }),
      owned("roles", { id: "custom", description: "\udc00" }),
      owned("workflows", workflow({ title: "\ud800" })),
      owned("workflows", workflow({ description: "\udc00" })),
      override("replace", { id: "custom", title: "\ud800" }),
      override("replace", { id: "custom", description: "\udc00" }),
      override("extend", { title: "\ud800" }),
      override("extend", { description: "\udc00" }),
      owned("roles", { id: "custom", title: "a\u0000" }),
      owned("roles", { id: "custom", description: "\u0000" }),
      owned("workflows", workflow({ title: "a\u0000" })),
      owned("workflows", workflow({ description: "a\u0000b" })),
      override("replace", { id: "custom", title: "a\u0000" }),
      override("replace", { id: "custom", description: "a\u0000" }),
      override("extend", { title: "a\u0000" }),
      override("extend", { description: "a\u0000" }),
    ])
      expect(schema.safeParse(state).success).toBe(false);

    for (const state of [
      owned("roles", { id: "custom", title: "😀", description: "😀" }),
      owned("workflows", workflow({ title: "😀", description: "😀" })),
      override("replace", { id: "custom", title: "😀", description: "😀" }),
      override("extend", { title: "😀", description: "😀" }),
      owned("roles", { id: "custom", title: "a".repeat(16_000) }),
    ])
      expect(schema.safeParse(state).success).toBe(true);
    expect(
      schema.safeParse(
        owned("roles", { id: "custom", title: "a".repeat(16_001) }),
      ).success,
    ).toBe(false);
  });

  test("format 7 carries a role omission; format 6 keeps its prompt-only disable rule", () => {
    const v6 = portableProjectArchiveSchemaV6.shape.state.shape.definitions;
    const v7 = portableProjectArchiveSchemaV7.shape.state.shape.definitions;
    const override = (
      kind: string,
      operation: "replace" | "extend" | "disable",
      payload?: object,
    ) => ({
      revision: 1,
      owned: [],
      overrides: [
        {
          origin: "project_override",
          source: {
            id: "org.example.legal",
            version: "1.0.0",
            manifestDigest: `sha256:${"a".repeat(64)}`,
            kind,
            localId: "custom",
          },
          operation,
          revision: 1,
          ...(payload === undefined ? {} : { payload }),
          actorId: "operator",
          changedAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    });
    const owned = (payload: object) => ({
      revision: 1,
      owned: [
        {
          origin: "project_owned",
          kind: "roles",
          id: "custom",
          revision: 1,
          enabled: true,
          payload,
          actorId: "operator",
          changedAt: "2026-10-05T00:00:00.000Z",
        },
      ],
      overrides: [],
    });
    expect(portableProjectFormatVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(v6.safeParse(override("roles", "disable")).success).toBe(false);
    expect(v7.safeParse(override("roles", "disable")).success).toBe(true);
    for (const schema of [v6, v7]) {
      expect(schema.safeParse(override("prompts", "disable")).success).toBe(
        true,
      );
      // Every other kind stays without an omission contract in both formats.
      for (const kind of [
        "taskTypes",
        "agents",
        "artifactTypes",
        "evidenceTypes",
        "knowledge",
      ])
        expect(schema.safeParse(override(kind, "disable")).success).toBe(false);
      // An omission carries no payload.
      expect(
        schema.safeParse(override("roles", "disable", { id: "custom" }))
          .success,
      ).toBe(false);
      // Capabilities belong to the pack: no project payload may carry them.
      for (const state of [
        override("roles", "replace", { id: "custom", capabilities: ["file"] }),
        override("roles", "replace", { id: "custom", capabilities: [] }),
        override("roles", "extend", { title: "T", capabilities: ["file"] }),
        owned({ id: "custom", capabilities: ["file"] }),
      ])
        expect(schema.safeParse(state).success).toBe(false);
      expect(
        schema.safeParse(override("roles", "replace", { id: "custom" }))
          .success,
      ).toBe(true);
      expect(schema.safeParse(owned({ id: "custom" })).success).toBe(true);
    }
  });

  test("a role omission is exported as format 7, round-trips, and cannot be written as format 6", async () => {
    const source = temporaryRoot("ai-office-gp11-portable-project-");
    writeFileSync(join(source, "package.json"), '{"name":"gp11"}\n');
    const origin = openRuntime(
      temporaryRoot("ai-office-gp11-portable-source-"),
    );
    const projectId = (await importProject(origin, source)).projectId;
    const now = new Date("2026-10-05T00:00:00.000Z");
    const tuple = {
      id: parseDomainPackId("org.example.legal"),
      version: parseDomainPackVersion("1.0.0"),
      manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
    };
    const definitions = new SqliteProjectDefinitionRepository(origin.database);
    const entry = (
      kind: "roles" | "prompts",
      localId: string,
      operation: "replace" | "disable",
    ) => ({
      origin: "project_override" as const,
      source: { ...tuple, kind, localId },
      operation,
      revision: 1,
      ...(operation === "replace" ? { payload: { id: localId } } : {}),
      actorId: "operator",
      changedAt: now.toISOString(),
    });
    // Without a role omission the state is still written as format 6.
    await definitions.replace(
      {
        projectId,
        revision: 0,
        owned: [],
        overrides: [
          entry("roles", "counsel", "replace"),
          entry("prompts", "greeting", "disable"),
        ],
      },
      0,
      now,
    );
    const plain = await origin.service.backup(projectId);
    expect(plain.archive.manifest.formatVersion).toBe(6);
    expect(portableProjectFormatVersionFor(plain.archive.state)).toBe(6);

    const omitted = await definitions.replace(
      {
        projectId,
        revision: 1,
        owned: [],
        overrides: [
          entry("roles", "clerk", "disable"),
          entry("roles", "counsel", "replace"),
          entry("prompts", "greeting", "disable"),
        ],
      },
      1,
      now,
    );
    const backup = await origin.service.backup(projectId);
    expect(backup.archive.manifest.formatVersion).toBe(7);
    expect(backup.archive.manifest.contents).toEqual(
      plain.archive.manifest.contents,
    );
    expect(backup.archive.state.definitions).toEqual({
      revision: 2,
      owned: [],
      overrides: omitted.overrides,
    });

    // Format 6 cannot carry the omission, as a producer or as a reader.
    const asFormat = (formatVersion: 6 | 7) =>
      portableProjectManifestFor({
        formatVersion,
        projectIdentity: backup.archive.manifest.projectIdentity,
        createdAt: backup.archive.manifest.createdAt,
        revision: backup.archive.manifest.revision,
      });
    expect(() =>
      createPortableProjectArchive({
        manifest: asFormat(6),
        state: backup.archive.state,
      }),
    ).toThrow(
      "Portable project archive format version 6 cannot carry a role omission; write format version 7",
    );
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(() =>
      parsePortableProjectArchive(
        serialized.replace('"formatVersion":7', '"formatVersion":6'),
      ),
    ).toThrow(/Portable project archive state\.definitions\.overrides/u);
    // The format-6 archive of the earlier state is still readable as written.
    expect(
      parsePortableProjectArchive(
        serializePortableProjectArchive(plain.archive),
      ),
    ).toEqual(plain.archive);

    const destination = openRuntime(
      temporaryRoot("ai-office-gp11-portable-destination-"),
    );
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: source,
    });
    expect(
      await new SqliteProjectDefinitionRepository(destination.database).get(
        restored.projectId,
      ),
    ).toEqual({ ...omitted, projectId: restored.projectId });
    const again = await destination.service.backup(restored.projectId);
    expect(again.archive.manifest.formatVersion).toBe(7);
    expect(again.archive.state).toEqual(backup.archive.state);
    // Restoring the same archive over identical local state is idempotent.
    await expect(
      destination.service.restore({
        archive: parsePortableProjectArchive(serialized),
        rootPath: source,
      }),
    ).resolves.toMatchObject({ projectId: restored.projectId });
    origin.database.close();
    destination.database.close();
  });

  test("format 8 carries an agent disable and agent references; format 7 rejects both", () => {
    const v6 = portableProjectArchiveSchemaV6.shape.state.shape.definitions;
    const v7 = portableProjectArchiveSchemaV7.shape.state.shape.definitions;
    const v8 = portableProjectArchiveSchemaV8.shape.state.shape.definitions;
    const entry = {
      revision: 1,
      actorId: "operator",
      changedAt: "2026-10-06T00:00:00.000Z",
    };
    const override = (
      kind: string,
      operation: "replace" | "extend" | "disable",
      payload?: object,
    ) => ({
      revision: 1,
      owned: [],
      overrides: [
        {
          origin: "project_override",
          source: {
            id: "org.example.legal",
            version: "1.0.0",
            manifestDigest: `sha256:${"a".repeat(64)}`,
            kind,
            localId: "custom",
          },
          operation,
          ...(payload === undefined ? {} : { payload }),
          ...entry,
        },
      ],
    });
    const owned = (kind: string, payload: object) => ({
      revision: 1,
      owned: [
        {
          origin: "project_owned",
          kind,
          id: "custom",
          enabled: true,
          payload,
          ...entry,
        },
      ],
      overrides: [],
    });
    const many = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `p${String(index).padStart(4, "0")}`,
      );
    const references = {
      id: "custom",
      title: "Custom",
      role: "counsel",
      prompts: ["brief", "tone"],
      knowledge: ["statutes"],
    };

    // What only format 8 can carry.
    for (const state of [
      override("agents", "disable"),
      override("agents", "replace", { ...references, capabilities: ["draft"] }),
      override("agents", "replace", { id: "custom", role: "counsel" }),
      override("agents", "replace", { id: "custom", prompts: ["brief"] }),
      override("agents", "replace", { id: "custom", knowledge: ["statutes"] }),
      owned("agents", references),
      owned("agents", { id: "custom", role: "auditor" }),
    ]) {
      expect(v8.safeParse(state).success, JSON.stringify(state)).toBe(true);
      expect(v7.safeParse(state).success, JSON.stringify(state)).toBe(false);
      expect(v6.safeParse(state).success, JSON.stringify(state)).toBe(false);
    }
    // Format 8 has the format-7 contents.
    for (const state of [
      override("roles", "disable"),
      override("prompts", "disable"),
      override("agents", "replace", { id: "custom", title: "Custom" }),
      override("agents", "extend", { title: "Custom" }),
      owned("agents", { id: "custom" }),
      owned("roles", { id: "custom", title: "Custom" }),
    ]) {
      expect(v8.safeParse(state).success, JSON.stringify(state)).toBe(true);
      expect(v7.safeParse(state).success, JSON.stringify(state)).toBe(true);
    }
    for (const state of [
      override("agents", "replace", { id: "custom", prompts: many(1_000) }),
      override("agents", "replace", { id: "custom", prompts: ["B", "a"] }),
      owned("agents", { id: "custom", knowledge: many(1_000) }),
    ])
      expect(v8.safeParse(state).success).toBe(true);
    // Forged format-8 state is rejected.
    for (const state of [
      // A disable carries no payload; other kinds have no disable contract.
      override("agents", "disable", { id: "custom" }),
      override("taskTypes", "disable"),
      override("knowledge", "disable"),
      // Requested capabilities need a role and never sit on a project agent.
      override("agents", "replace", { id: "custom", capabilities: ["draft"] }),
      owned("agents", { id: "custom", capabilities: ["draft"] }),
      owned("agents", {
        id: "custom",
        role: "auditor",
        capabilities: ["draft"],
      }),
      // List rules: non-empty, unique, valid local IDs.
      override("agents", "replace", { id: "custom", prompts: [] }),
      override("agents", "replace", {
        id: "custom",
        prompts: ["brief", "brief"],
      }),
      override("agents", "replace", { id: "custom", knowledge: ["no id"] }),
      override("agents", "replace", { id: "custom", role: "no id" }),
      override("agents", "replace", { id: "custom", role: ["counsel"] }),
      owned("agents", { id: "custom", knowledge: [] }),
      // One order only: ascending by code unit, as the mutation contract
      // stores it.
      override("agents", "replace", { id: "custom", prompts: ["z", "a"] }),
      override("agents", "replace", {
        id: "custom",
        knowledge: ["a", "c", "b"],
      }),
      override("agents", "replace", {
        id: "custom",
        role: "counsel",
        capabilities: ["review", "draft"],
      }),
      // Code units, not a locale: uppercase sorts first.
      override("agents", "replace", { id: "custom", prompts: ["a", "B"] }),
      owned("agents", { id: "custom", prompts: ["voice", "house"] }),
      // At most 1,000 references per list.
      override("agents", "replace", { id: "custom", prompts: many(1_001) }),
      owned("agents", { id: "custom", knowledge: many(1_001) }),
      // The fields exist on agents only and never on an extension.
      override("agents", "extend", { title: "Custom", role: "counsel" }),
      override("roles", "replace", { id: "custom", role: "counsel" }),
      override("roles", "replace", { id: "custom", capabilities: ["draft"] }),
      override("knowledge", "replace", { id: "custom", prompts: ["brief"] }),
      owned("roles", { id: "custom", prompts: ["brief"] }),
      owned("prompts", { id: "custom", role: "counsel" }),
      // Nothing beyond the GP-12 fields.
      override("agents", "replace", { id: "custom", model: "large" }),
      owned("agents", { id: "custom", tools: ["shell"] }),
    ])
      expect(v8.safeParse(state).success, JSON.stringify(state)).toBe(false);
  });

  test("an agent disable or reference is exported as format 8, round-trips, and cannot be written as format 7", async () => {
    const source = temporaryRoot("ai-office-gp12-portable-project-");
    writeFileSync(join(source, "package.json"), '{"name":"gp12"}\n');
    const origin = openRuntime(
      temporaryRoot("ai-office-gp12-portable-source-"),
    );
    const projectId = (await importProject(origin, source)).projectId;
    const now = new Date("2026-10-06T00:00:00.000Z");
    const tuple = {
      id: parseDomainPackId("org.example.legal"),
      version: parseDomainPackVersion("1.0.0"),
      manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
    };
    const definitions = new SqliteProjectDefinitionRepository(origin.database);
    const entry = (
      kind: "roles" | "agents",
      localId: string,
      operation: "replace" | "disable",
      payload: object = { id: localId },
    ) => ({
      origin: "project_override" as const,
      source: { ...tuple, kind, localId },
      operation,
      revision: 1,
      ...(operation === "replace"
        ? { payload: payload as { id: string } }
        : {}),
      actorId: "operator",
      changedAt: now.toISOString(),
    });
    const helper = (payload: object) => ({
      origin: "project_owned" as const,
      kind: "agents" as const,
      id: "helper",
      revision: 1,
      enabled: true,
      payload: payload as { id: string },
      actorId: "operator",
      changedAt: now.toISOString(),
    });
    let revision = 0;
    const store = (
      owned: ReturnType<typeof helper>[],
      overrides: ReturnType<typeof entry>[],
    ) =>
      definitions.replace(
        { projectId, revision, owned, overrides },
        revision++,
        now,
      );

    // Descriptive agent entries and a role omission need nothing new.
    await store(
      [helper({ id: "helper", title: "Helper" })],
      [
        entry("agents", "drafter", "replace"),
        entry("roles", "clerk", "disable"),
      ],
    );
    const plain = await origin.service.backup(projectId);
    expect(plain.archive.manifest.formatVersion).toBe(7);
    expect(portableProjectFormatVersionFor(plain.archive.state)).toBe(7);

    // Each of these alone needs format 8.
    for (const [owned, overrides] of [
      [[], [entry("agents", "drafter", "disable")]],
      [
        [],
        [
          entry("agents", "drafter", "replace", {
            id: "drafter",
            role: "counsel",
          }),
        ],
      ],
      [[helper({ id: "helper", knowledge: ["handbook"] })], []],
    ] as const) {
      await store([...owned], [...overrides]);
      expect(
        (await origin.service.backup(projectId)).archive.manifest.formatVersion,
      ).toBe(8);
    }

    const stored = await store(
      [helper({ id: "helper", role: "auditor", prompts: ["house"] })],
      [
        entry("agents", "drafter", "disable"),
        entry("agents", "filer", "replace", {
          id: "filer",
          title: "Our filer",
          role: "counsel",
          prompts: ["brief", "tone"],
          knowledge: ["statutes"],
          capabilities: ["draft"],
        }),
        entry("roles", "clerk", "disable"),
      ],
    );
    const backup = await origin.service.backup(projectId);
    expect(backup.archive.manifest.formatVersion).toBe(8);
    expect(backup.archive.manifest.contents).toEqual(
      plain.archive.manifest.contents,
    );
    expect(backup.archive.state.definitions).toEqual({
      revision: stored.revision,
      owned: stored.owned,
      overrides: stored.overrides,
    });

    // Format 7 cannot carry it, as a producer or as a reader.
    const asFormat = (formatVersion: 7 | 8) =>
      portableProjectManifestFor({
        formatVersion,
        projectIdentity: backup.archive.manifest.projectIdentity,
        createdAt: backup.archive.manifest.createdAt,
        revision: backup.archive.manifest.revision,
      });
    expect(() =>
      createPortableProjectArchive({
        manifest: asFormat(7),
        state: backup.archive.state,
      }),
    ).toThrow(
      "Portable project archive format version 7 cannot carry an agent disable or agent references; write format version 8",
    );
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(() =>
      parsePortableProjectArchive(
        serialized.replace('"formatVersion":8', '"formatVersion":7'),
      ),
    ).toThrow(/Portable project archive state\.definitions\./u);
    // A forged format-8 archive is rejected by the same schema.
    expect(() =>
      parsePortableProjectArchive(serialized.replace('"role":"counsel",', "")),
    ).toThrow(/Portable project archive/u);
    // The format-7 archive of the earlier state is still readable as written.
    expect(
      parsePortableProjectArchive(
        serializePortableProjectArchive(plain.archive),
      ),
    ).toEqual(plain.archive);

    const destination = openRuntime(
      temporaryRoot("ai-office-gp12-portable-destination-"),
    );
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: source,
    });
    expect(
      await new SqliteProjectDefinitionRepository(destination.database).get(
        restored.projectId,
      ),
    ).toEqual({ ...stored, projectId: restored.projectId });
    const again = await destination.service.backup(restored.projectId);
    expect(again.archive.manifest.formatVersion).toBe(8);
    expect(again.archive.state).toEqual(backup.archive.state);
    // Restoring the same archive over identical local state is idempotent.
    await expect(
      destination.service.restore({
        archive: parsePortableProjectArchive(serialized),
        rootPath: source,
      }),
    ).resolves.toMatchObject({ projectId: restored.projectId });
    origin.database.close();
    destination.database.close();
  });

  test("format 9 carries workflow overrides with their stage order; format 8 rejects them", () => {
    const v6 = portableProjectArchiveSchemaV6.shape.state.shape.definitions;
    const v7 = portableProjectArchiveSchemaV7.shape.state.shape.definitions;
    const v8 = portableProjectArchiveSchemaV8.shape.state.shape.definitions;
    const v9 = portableProjectArchiveSchemaV9.shape.state.shape.definitions;
    const entry = {
      revision: 1,
      actorId: "operator",
      changedAt: "2026-10-06T00:00:00.000Z",
    };
    const override = (
      kind: string,
      operation: "replace" | "extend" | "disable",
      payload?: object,
    ) => ({
      revision: 1,
      owned: [],
      overrides: [
        {
          origin: "project_override",
          source: {
            id: "org.example.legal",
            version: "1.0.0",
            manifestDigest: `sha256:${"a".repeat(64)}`,
            kind,
            localId: "custom",
          },
          operation,
          ...(payload === undefined ? {} : { payload }),
          ...entry,
        },
      ],
    });
    const owned = (kind: string, payload: object) => ({
      revision: 1,
      owned: [
        {
          origin: "project_owned",
          kind,
          id: "custom",
          enabled: true,
          payload,
          ...entry,
        },
      ],
      overrides: [],
    });
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `s${index}`,
        role: "counsel",
      }));
    const envelope = {
      id: "custom",
      title: "Custom",
      description: "House procedure",
      taskType: "matter",
      // In no sort order: the archive keeps the list as given.
      stages: [
        { id: "z-last", role: "paralegal" },
        { id: "a-first", role: "counsel" },
      ],
    };

    // What only format 9 can carry: every operation on a workflow.
    for (const state of [
      override("workflows", "replace", envelope),
      override("workflows", "replace", {
        id: "custom",
        taskType: "matter",
        stages: [],
      }),
      override("workflows", "replace", {
        id: "custom",
        taskType: "matter",
        stages: many(1_000),
      }),
      override("workflows", "extend", { title: "Custom" }),
      override("workflows", "extend", { description: "House procedure" }),
      override("workflows", "disable"),
    ]) {
      expect(v9.safeParse(state).success, JSON.stringify(state)).toBe(true);
      for (const schema of [v8, v7, v6])
        expect(schema.safeParse(state).success, JSON.stringify(state)).toBe(
          false,
        );
    }
    // The stage order survives parsing.
    const parsed = v9.parse(override("workflows", "replace", envelope));
    expect(parsed.overrides[0]?.payload).toEqual(envelope);
    expect(
      (
        parsed.overrides[0]?.payload as unknown as { stages: { id: string }[] }
      ).stages.map((stage) => stage.id),
    ).toEqual(["z-last", "a-first"]);
    // Format 9 has the format-8 contents.
    for (const state of [
      override("agents", "disable"),
      override("agents", "replace", { id: "custom", role: "counsel" }),
      override("roles", "disable"),
      override("prompts", "disable"),
      override("roles", "replace", { id: "custom", title: "Custom" }),
      owned("agents", { id: "custom", prompts: ["house"] }),
      owned("workflows", envelope),
    ]) {
      expect(v9.safeParse(state).success, JSON.stringify(state)).toBe(true);
      expect(v8.safeParse(state).success, JSON.stringify(state)).toBe(true);
    }
    // Forged format-9 state is rejected.
    for (const state of [
      // A replacement of a workflow is the typed envelope, nothing less.
      override("workflows", "replace", { id: "custom", title: "Custom" }),
      override("workflows", "replace", { id: "custom", taskType: "matter" }),
      override("workflows", "replace", { id: "custom", stages: [] }),
      override("workflows", "replace", { ...envelope, id: "other" }),
      override("workflows", "replace"),
      // Nothing beyond the schema-1 workflow fields.
      override("workflows", "replace", { ...envelope, approvals: ["x"] }),
      override("workflows", "replace", { ...envelope, role: "counsel" }),
      override("workflows", "replace", {
        ...envelope,
        stages: [{ id: "check", role: "counsel", guard: "x" }],
      }),
      // Stage rules: local IDs, unique stage IDs, at most 1,000 stages.
      override("workflows", "replace", {
        ...envelope,
        stages: [{ id: "check", role: "no id" }],
      }),
      override("workflows", "replace", {
        ...envelope,
        stages: [{ id: "check" }],
      }),
      override("workflows", "replace", {
        ...envelope,
        stages: [
          { id: "check", role: "counsel" },
          { id: "check", role: "paralegal" },
        ],
      }),
      override("workflows", "replace", { ...envelope, stages: many(1_001) }),
      override("workflows", "replace", { ...envelope, taskType: "no id" }),
      // An extension stays descriptive and a disable carries no payload.
      override("workflows", "extend", { title: "Custom", stages: [] }),
      override("workflows", "extend", { title: "Custom", taskType: "matter" }),
      override("workflows", "extend", envelope),
      override("workflows", "extend", {}),
      override("workflows", "disable", envelope),
      override("workflows", "disable", { id: "custom" }),
      // The workflow fields exist on workflows only.
      override("roles", "replace", envelope),
      override("agents", "replace", envelope),
      override("taskTypes", "replace", envelope),
      // Kinds without an override contract stay out of every format.
      override("policies", "replace", { id: "custom" }),
      override("capabilities", "extend", { title: "Custom" }),
      override("validators", "disable"),
      override("taskTypes", "disable"),
    ])
      expect(v9.safeParse(state).success, JSON.stringify(state)).toBe(false);
  });

  test("a workflow override is exported as format 9, round-trips in stage order, and cannot be written as format 8", async () => {
    const source = temporaryRoot("ai-office-gp13-portable-project-");
    writeFileSync(join(source, "package.json"), '{"name":"gp13"}\n');
    const origin = openRuntime(
      temporaryRoot("ai-office-gp13-portable-source-"),
    );
    const projectId = (await importProject(origin, source)).projectId;
    const now = new Date("2026-10-06T00:00:00.000Z");
    const tuple = {
      id: parseDomainPackId("org.example.legal"),
      version: parseDomainPackVersion("1.0.0"),
      manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
    };
    const definitions = new SqliteProjectDefinitionRepository(origin.database);
    const entry = (
      kind: "roles" | "agents" | "workflows",
      localId: string,
      operation: "replace" | "extend" | "disable",
      payload: object = { id: localId },
    ) => ({
      origin: "project_override" as const,
      source: { ...tuple, kind, localId },
      operation,
      revision: 1,
      ...(operation === "disable"
        ? {}
        : { payload: payload as { id: string } }),
      actorId: "operator",
      changedAt: now.toISOString(),
    });
    const house = {
      origin: "project_owned" as const,
      kind: "workflows" as const,
      id: "house",
      revision: 1,
      enabled: true,
      payload: {
        id: "house",
        taskType: "errand",
        stages: [
          { id: "second", role: "liaison" },
          { id: "first", role: "liaison" },
        ],
      },
      actorId: "operator",
      changedAt: now.toISOString(),
    };
    let revision = 0;
    const store = (
      owned: (typeof house)[],
      overrides: ReturnType<typeof entry>[],
    ) =>
      definitions.replace(
        { projectId, revision, owned, overrides },
        revision++,
        now,
      );

    // A project-owned workflow and the GP-12 entries need nothing new.
    await store([house], [entry("agents", "drafter", "disable")]);
    const plain = await origin.service.backup(projectId);
    expect(plain.archive.manifest.formatVersion).toBe(8);
    expect(portableProjectFormatVersionFor(plain.archive.state)).toBe(8);
    await store([house], []);
    expect(
      (await origin.service.backup(projectId)).archive.manifest.formatVersion,
    ).toBe(6);

    const review = {
      id: "review",
      title: "Our review",
      taskType: "matter",
      stages: [
        { id: "z-last", role: "paralegal" },
        { id: "a-first", role: "counsel" },
        { id: "m-middle", role: "auditor" },
      ],
    };
    // Each of these alone needs format 9.
    for (const overrides of [
      [entry("workflows", "review", "replace", review)],
      [entry("workflows", "review", "extend", { description: "Ours" })],
      [entry("workflows", "review", "disable")],
    ]) {
      await store([], overrides);
      expect(
        (await origin.service.backup(projectId)).archive.manifest.formatVersion,
      ).toBe(9);
    }

    const stored = await store(
      [house],
      [
        entry("agents", "drafter", "disable"),
        entry("roles", "clerk", "disable"),
        entry("workflows", "audit", "disable"),
        entry("workflows", "intake", "extend", { title: "Our intake" }),
        entry("workflows", "review", "replace", review),
      ],
    );
    const backup = await origin.service.backup(projectId);
    expect(backup.archive.manifest.formatVersion).toBe(9);
    expect(backup.archive.manifest.contents).toEqual(
      plain.archive.manifest.contents,
    );
    expect(backup.archive.state.definitions).toEqual({
      revision: stored.revision,
      owned: stored.owned,
      overrides: stored.overrides,
    });
    const serialized = serializePortableProjectArchive(backup.archive);
    // The stage list is serialized in the order given.
    expect(serialized).toContain(
      '"stages":[{"id":"z-last","role":"paralegal"},{"id":"a-first","role":"counsel"},{"id":"m-middle","role":"auditor"}]',
    );

    // Format 8 cannot carry it, as a producer or as a reader.
    const asFormat = (formatVersion: 8 | 9) =>
      portableProjectManifestFor({
        formatVersion,
        projectIdentity: backup.archive.manifest.projectIdentity,
        createdAt: backup.archive.manifest.createdAt,
        revision: backup.archive.manifest.revision,
      });
    expect(() =>
      createPortableProjectArchive({
        manifest: asFormat(8),
        state: backup.archive.state,
      }),
    ).toThrow(
      "Portable project archive format version 8 cannot carry a workflow override; write format version 9",
    );
    expect(() =>
      parsePortableProjectArchive(
        serialized.replace('"formatVersion":9', '"formatVersion":8'),
      ),
    ).toThrow(/Portable project archive state\.definitions\./u);
    // A forged format-9 archive is rejected by the same schema.
    expect(() =>
      parsePortableProjectArchive(
        serialized.replace('"taskType":"matter",', ""),
      ),
    ).toThrow(/Portable project archive/u);
    expect(() =>
      parsePortableProjectArchive(
        serialized.replace('"id":"a-first"', '"id":"z-last"'),
      ),
    ).toThrow(/Portable project archive/u);
    // Reordering the stages of a valid archive breaks its checksums.
    expect(() =>
      parsePortableProjectArchive(
        serialized
          .replace('{"id":"z-last","role":"paralegal"}', "@")
          .replace(
            '{"id":"a-first","role":"counsel"}',
            '{"id":"z-last","role":"paralegal"}',
          )
          .replace("@", '{"id":"a-first","role":"counsel"}'),
      ),
    ).toThrow("checksum mismatch");
    // The format-8 archive of the earlier state is still readable as written.
    expect(
      parsePortableProjectArchive(
        serializePortableProjectArchive(plain.archive),
      ),
    ).toEqual(plain.archive);

    const destination = openRuntime(
      temporaryRoot("ai-office-gp13-portable-destination-"),
    );
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: source,
    });
    const restoredState = await new SqliteProjectDefinitionRepository(
      destination.database,
    ).get(restored.projectId);
    expect(restoredState).toEqual({ ...stored, projectId: restored.projectId });
    expect(
      (
        restoredState.overrides.at(-1)?.payload as unknown as {
          stages: { id: string }[];
        }
      ).stages.map((stage) => stage.id),
    ).toEqual(["z-last", "a-first", "m-middle"]);
    const again = await destination.service.backup(restored.projectId);
    expect(again.archive.manifest.formatVersion).toBe(9);
    expect(again.archive.state).toEqual(backup.archive.state);
    // Restoring the same archive over identical local state is idempotent.
    await expect(
      destination.service.restore({
        archive: parsePortableProjectArchive(serialized),
        rootPath: source,
      }),
    ).resolves.toMatchObject({ projectId: restored.projectId });
    origin.database.close();
    destination.database.close();
  });

  test("v6 restore recomputes the same derived configuration with a different installer reference", async () => {
    const source = temporaryRoot("ai-office-gp06-portable-project-");
    writeFileSync(join(source, "package.json"), '{"name":"gp06"}\n');
    const origin = openRuntime(
      temporaryRoot("ai-office-gp06-portable-source-"),
    );
    const projectId = (await importProject(origin, source)).projectId;
    const bytes = readFileSync(
      new URL("../fixtures/domain-pack/legal.json", import.meta.url),
    );
    const makeCatalog = (reference: string) => {
      const catalog = new InMemoryInstalledDomainPackCatalog(1, [
        "local-distribution",
      ]);
      const tuple = catalog.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: { installerId: "local-distribution", reference },
      });
      return { catalog, tuple };
    };
    const original = makeCatalog("source-install");
    const now = new Date("2026-10-03T00:00:00.000Z");
    await new SqliteProjectPackBindingRepository(origin.database).replace(
      projectId,
      0,
      [original.tuple],
      now,
    );
    await new SqliteProjectDefinitionRepository(origin.database).replace(
      {
        projectId,
        revision: 0,
        owned: [
          {
            origin: "project_owned",
            kind: "roles",
            id: "operator",
            revision: 1,
            enabled: true,
            payload: { id: "operator" },
            actorId: "operator",
            changedAt: now.toISOString(),
          },
        ],
        overrides: [
          {
            origin: "project_override",
            source: { ...original.tuple, kind: "roles", localId: "counsel" },
            operation: "replace",
            revision: 1,
            payload: { id: "counsel", title: "Lead counsel" },
            actorId: "operator",
            changedAt: now.toISOString(),
          },
        ],
      },
      0,
      now,
    );
    const reader = (
      runtime: ReturnType<typeof openRuntime>,
      catalog: InMemoryInstalledDomainPackCatalog,
    ) =>
      new ReadProjectConfiguration({
        projects: runtime.projects,
        bindings: new SqliteProjectPackBindingRepository(runtime.database),
        definitions: new SqliteProjectDefinitionRepository(runtime.database),
        transactions: runtime.transactions,
        catalog,
      });
    const before = await reader(origin, original.catalog).read(projectId);
    const backup = await origin.service.backup(projectId);
    expect(serializePortableProjectArchive(backup.archive)).not.toContain(
      "configurationDigest",
    );
    const destination = openRuntime(
      temporaryRoot("ai-office-gp06-portable-destination-"),
    );
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(
        serializePortableProjectArchive(backup.archive),
      ),
      rootPath: source,
    });
    const installedAgain = makeCatalog("destination-install");
    const after = await reader(destination, installedAgain.catalog).read(
      restored.projectId,
    );
    expect(after.configurationDigest).toBe(before.configurationDigest);
    expect(after.effectiveDefinitions).toEqual(before.effectiveDefinitions);
    expect(after.origins).toEqual(before.origins);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(/-install/u);

    // A destination without the exact pack, or with different content under
    // the same ID and version, fails instead of deriving another configuration.
    const writes = () =>
      destination.database
        .query<{ changes: number }, []>("SELECT total_changes() AS changes")
        .get()!.changes;
    const writesBefore = writes();
    const emptyCatalog = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    await expect(
      reader(destination, emptyCatalog).read(restored.projectId),
    ).rejects.toMatchObject({ code: "pack_unavailable" });
    const draft = parseDomainPackManifest(bytes);
    const changedManifest = {
      ...draft,
      metadata: { ...draft.metadata, description: "Changed after restore" },
    };
    const changedBytes = new TextEncoder().encode(
      JSON.stringify({
        ...changedManifest,
        manifestDigest: computeManifestDigest(changedManifest),
      }),
    );
    const changedCatalog = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    changedCatalog.register({
      bytes: changedBytes,
      artifactDigest: computeArtifactDigest(changedBytes),
      provenance: { installerId: "local-distribution", reference: "changed" },
    });
    await expect(
      reader(destination, changedCatalog).read(restored.projectId),
    ).rejects.toMatchObject({ code: "pack_unavailable" });
    expect(
      await reader(destination, installedAgain.catalog).read(
        restored.projectId,
      ),
    ).toEqual(before);
    // Neither successful nor failed resolution writes a single row.
    expect(writes()).toBe(writesBefore);
    expect(
      await new SqliteProjectDefinitionRepository(destination.database).get(
        restored.projectId,
      ),
    ).toMatchObject({ revision: 1, owned: [{ id: "operator" }] });
    origin.database.close();
    destination.database.close();
  });

  test("v6 round-trips authoritative owned definitions and pinned unresolved overrides", async () => {
    const sourceRuntime = temporaryRoot("ai-office-gp07-portable-source-");
    const source = temporaryRoot("ai-office-gp07-portable-project-");
    writeFileSync(join(source, "package.json"), '{"name":"gp07"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const projectId = imported.projectId;
    const now = new Date("2026-10-03T00:00:00.000Z");
    const definitions = new SqliteProjectDefinitionRepository(origin.database);
    const exact = {
      id: parseDomainPackId("org.example.legal"),
      version: parseDomainPackVersion("1.0.0"),
      manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
      kind: "roles" as const,
      localId: "counsel",
    };
    await new SqliteProjectPackBindingRepository(origin.database).replace(
      projectId,
      0,
      [
        {
          id: exact.id,
          version: exact.version,
          manifestDigest: exact.manifestDigest,
        },
      ],
      now,
    );
    await definitions.replace(
      {
        projectId,
        revision: 0,
        owned: [
          {
            origin: "project_owned",
            kind: "roles",
            id: "custom",
            revision: 1,
            enabled: true,
            payload: { id: "custom", title: "Custom" },
            actorId: "operator",
            changedAt: now.toISOString(),
          },
          {
            origin: "project_owned",
            kind: "roles",
            id: "alpha",
            revision: 1,
            enabled: true,
            payload: { id: "alpha" },
            actorId: "operator",
            changedAt: now.toISOString(),
          },
          {
            origin: "project_owned",
            kind: "roles",
            id: "B",
            revision: 1,
            enabled: true,
            payload: { id: "B" },
            actorId: "operator",
            changedAt: now.toISOString(),
          },
        ],
        overrides: [
          {
            origin: "project_override",
            source: exact,
            operation: "replace",
            revision: 1,
            payload: { id: "counsel", title: "Counsel" },
            actorId: "operator",
            changedAt: now.toISOString(),
          },
        ],
      },
      0,
      now,
    );
    const firstRevision = await definitions.get(projectId);
    await definitions.replace(
      {
        ...firstRevision,
        owned: firstRevision.owned.map((entry) =>
          entry.id === "custom"
            ? {
                ...entry,
                revision: 2,
                payload: { id: "custom", title: "Updated" },
              }
            : entry,
        ),
        overrides: firstRevision.overrides.map((entry) => ({
          ...entry,
          revision: 2,
          payload: { id: "counsel", title: "Updated counsel" },
        })),
      },
      1,
      now,
    );
    const backup = await origin.service.backup(projectId);
    expect(backup.archive.manifest.formatVersion).toBe(6);
    expect(backup.archive.state.definitions).toMatchObject({
      revision: 2,
      owned: [
        { id: "B", revision: 1 },
        { id: "alpha", revision: 1 },
        { id: "custom", revision: 2, payload: { title: "Updated" } },
      ],
      overrides: [{ source: exact, revision: 2 }],
    });
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).not.toMatch(
      /artifactDigest|installerId|credentials|runtime_resolved|configurationDigest/u,
    );
    const destinationRuntime = temporaryRoot(
      "ai-office-gp07-portable-destination-",
    );
    const destination = openRuntime(destinationRuntime);
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: source,
    });
    expect(
      await new SqliteProjectDefinitionRepository(destination.database).get(
        restored.projectId,
      ),
    ).toMatchObject({
      revision: 2,
      owned: [
        { id: "B", revision: 1 },
        { id: "alpha", revision: 1 },
        { id: "custom", revision: 2, payload: { title: "Updated" } },
      ],
      overrides: [{ source: exact, revision: 2 }],
    });
    const absentCatalog = new InMemoryInstalledDomainPackCatalog(1, []);
    expect(absentCatalog.list()).toEqual([]);
    const inspector = new ManageProjectDefinitions({
      projects: destination.projects,
      definitions: new SqliteProjectDefinitionRepository(destination.database),
      bindings: new SqliteProjectPackBindingRepository(destination.database),
      catalog: absentCatalog,
      auditEvents: new SqliteAuditEventRepository(destination.database),
      transactions: destination.transactions,
      clock: destination.clock,
      ids: destination.ids,
    });
    expect((await inspector.inspect(restored.projectId)).issues).toMatchObject([
      { code: "source_unavailable", source: exact },
    ]);

    const v5State = portableStateAtFormatVersion(backup.archive.state, 5);
    const v5Archive = createPortableProjectArchive({
      state: v5State,
      manifest: portableProjectManifestFor({
        formatVersion: 5,
        projectIdentity: backup.archive.manifest.projectIdentity,
        createdAt: backup.archive.manifest.createdAt,
        revision: {
          id: backup.archive.manifest.revision.id,
          stateChecksum: portableStateChecksum(v5State),
        },
      }),
    });
    const oldDestination = openRuntime(
      temporaryRoot("ai-office-gp07-v5-target-"),
    );
    const oldRestored = await oldDestination.service.restore({
      archive: parsePortableProjectArchive(
        serializePortableProjectArchive(v5Archive),
      ),
      rootPath: temporaryRoot("ai-office-gp07-v5-project-"),
    });
    expect(
      await new SqliteProjectDefinitionRepository(oldDestination.database).get(
        oldRestored.projectId,
      ),
    ).toEqual({
      projectId: oldRestored.projectId,
      revision: 0,
      owned: [],
      overrides: [],
    });
    oldDestination.database.close();
    origin.database.close();
    destination.database.close();
  });
  test("v5 carries exact selection to an unavailable host; v4 restores empty", async () => {
    const sourceRuntime = temporaryRoot("ai-office-gp05-portable-source-");
    const targetRuntime = temporaryRoot("ai-office-gp05-portable-target-");
    const source = temporaryRoot("ai-office-gp05-source-");
    const target = temporaryRoot("ai-office-gp05-target-");
    writeFileSync(join(source, "package.json"), '{"name":"pack-source"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const pack = {
      id: parseDomainPackId("org.example.custom"),
      version: parseDomainPackVersion("1.0.0"),
      manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
    };
    await new SqliteProjectPackBindingRepository(origin.database).replace(
      imported.projectId,
      0,
      [pack],
      new Date("2026-10-02T00:00:00.000Z"),
    );
    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.manifest.formatVersion).toBe(6);
    expect(backup.archive.state.packBinding).toEqual({
      configurationRevision: 1,
      packs: [pack],
    });
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).not.toContain("artifactDigest");
    expect(serialized).not.toContain("installerId");
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: target,
    });
    expect(
      (await destination.states.loadPortableState(restored.projectId))
        .packBinding,
    ).toEqual({ configurationRevision: 1, packs: [pack] });
    const absentCatalog = new InMemoryInstalledDomainPackCatalog(1, []);
    const validator = new ManageProjectPackBinding({
      projects: destination.projects,
      bindings: new SqliteProjectPackBindingRepository(destination.database),
      catalog: absentCatalog,
      auditEvents: new SqliteAuditEventRepository(destination.database),
      transactions: destination.transactions,
      clock: destination.clock,
      ids: destination.ids,
    });
    expect(absentCatalog.list()).toEqual([]);
    expect(
      (await validator.preview(restored.projectId, [pack])).issues,
    ).toMatchObject([{ code: "missing_pack" }]);
    expect((await validator.read(restored.projectId)).packs).toEqual([pack]);
    destination.database.close();

    for (const version of [1, 2, 3, 4] as const) {
      const oldState = portableStateAtFormatVersion(
        backup.archive.state,
        version,
      );
      const oldArchive = createPortableProjectArchive({
        state: oldState,
        manifest: portableProjectManifestFor({
          formatVersion: version,
          projectIdentity: backup.archive.manifest.projectIdentity,
          createdAt: backup.archive.manifest.createdAt,
          revision: {
            id: backup.archive.manifest.revision.id,
            stateChecksum: portableStateChecksum(oldState),
          },
        }),
      });
      const oldDestination = openRuntime(
        temporaryRoot(`ai-office-gp05-portable-v${version}-`),
      );
      try {
        const oldRestored = await oldDestination.service.restore({
          archive: parsePortableProjectArchive(
            serializePortableProjectArchive(oldArchive),
          ),
          rootPath: temporaryRoot(`ai-office-gp05-v${version}-target-`),
        });
        expect(
          (await oldDestination.states.loadPortableState(oldRestored.projectId))
            .packBinding,
        ).toEqual({ configurationRevision: 0, packs: [] });
      } finally {
        oldDestination.database.close();
      }
    }
  });

  test("backs up and restores one logical project at a different machine path", async () => {
    const machineA = temporaryRoot("ai-office-portable-a-");
    const machineB = temporaryRoot("ai-office-portable-b-");
    const sourceA = temporaryRoot("ai-office-source-a-");
    const sourceB = temporaryRoot("ai-office-source-b-");
    writeFileSync(join(sourceA, "package.json"), '{"name":"portable"}\n');
    writeFileSync(join(sourceB, "package.json"), '{"name":"portable"}\n');

    const a = openRuntime(machineA);
    const imported = await new ImportProject(
      a.projects,
      a.profiles,
      new LocalProjectScanner(),
      a.identities,
      a.ids,
      a.clock,
      a.transactions,
    ).execute({ rootPath: sourceA });
    await new CreateTask(
      a.projects,
      new SqliteTaskRepository(a.database),
      a.ids,
      a.clock,
    ).execute({
      projectId: imported.projectId,
      title: "Portable task",
      priority: 7,
    });

    const first = await a.service.backup(imported.projectId);
    const serialized = serializePortableProjectArchive(first.archive);
    expect(serialized).not.toContain(sourceA);
    expect(serialized).not.toContain("project.sqlite");
    expect(first.archive.state.tasks).toEqual([
      expect.objectContaining({ title: "Portable task", priority: 7 }),
    ]);
    const repeated = await a.service.backup(imported.projectId);
    expect(repeated.revisionId).toBe(first.revisionId);
    expect(serializePortableProjectArchive(repeated.archive)).toBe(serialized);
    a.database.close();

    const b = openRuntime(machineB);
    const restored = await b.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: sourceB,
    });
    expect(restored.outcome).toBe("restored");
    expect(restored.projectId).not.toBe(imported.projectId);
    expect(restored.projectIdentity).toBe(first.projectIdentity);
    expect(
      JSON.parse(
        readFileSync(join(sourceB, ".ai-office", "project.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: first.projectIdentity,
    });
    expect(await b.states.loadPortableState(restored.projectId)).toEqual(
      first.archive.state,
    );
    const duplicate = await b.service.restore({
      archive: first.archive,
      rootPath: sourceB,
    });
    expect(duplicate.outcome).toBe("unchanged");
    b.database.close();
  });

  test.each([
    "Imported from another system as part of a customer migration",
    "Imported from another system",
    "Imported from",
    "imported from",
    "imported from /some/path",
    "Imported from /some/path",
  ])(
    "preserves semantic project description %j exactly",
    async (description) => {
      const sourceRuntime = temporaryRoot("ai-office-description-source-");
      const targetRuntime = temporaryRoot("ai-office-description-target-");
      const source = temporaryRoot("ai-office-description-checkout-a-");
      const target = temporaryRoot("ai-office-description-checkout-b-");
      writeFileSync(join(source, "package.json"), '{"name":"description"}\n');
      writeFileSync(join(target, "package.json"), '{"name":"description"}\n');

      const origin = openRuntime(sourceRuntime);
      const imported = await importProject(origin, source);
      origin.database
        .prepare("UPDATE project SET description = ? WHERE id = ?")
        .run(description, imported.projectId);
      const backup = await origin.service.backup(imported.projectId);
      expect(backup.archive.state.project.description).toBe(description);
      origin.database.close();

      const destination = openRuntime(targetRuntime);
      const restored = await destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      });
      expect(
        (await destination.projects.findById(restored.projectId))?.snapshot()
          .description,
      ).toBe(description);
      expect(
        await destination.states.loadPortableState(restored.projectId),
      ).toEqual(backup.archive.state);
      destination.database.close();
    },
  );

  test("omits only an exact legacy generated description backed by this project's source path", async () => {
    const sourceRuntime = temporaryRoot("ai-office-legacy-description-source-");
    const targetRuntime = temporaryRoot("ai-office-legacy-description-target-");
    const source = temporaryRoot("ai-office-legacy-description-checkout-a-");
    const target = temporaryRoot("ai-office-legacy-description-checkout-b-");
    writeFileSync(
      join(source, "package.json"),
      '{"name":"legacy-description"}\n',
    );
    writeFileSync(
      join(target, "package.json"),
      '{"name":"legacy-description"}\n',
    );

    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const knownSource = (
      await origin.profiles.listSources(imported.projectId)
    )[0]!.localPath;
    origin.database
      .prepare("UPDATE project SET description = ? WHERE id = ?")
      .run(`Imported from ${knownSource}`, imported.projectId);
    expect(
      (await origin.states.loadPortableState(imported.projectId)).project
        .description,
    ).toBeUndefined();
    expect(
      await origin.profiles.removeSource(imported.projectId, knownSource),
    ).toBe(true);
    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.state.project.description).toBeUndefined();
    expect(serializePortableProjectArchive(backup.archive)).not.toContain(
      knownSource,
    );
    expect(
      origin.database
        .query<{ description: string }, [string]>(
          "SELECT description FROM project WHERE id = ?",
        )
        .get(imported.projectId)?.description,
    ).toBe(`Imported from ${knownSource}`);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      (await destination.projects.findById(restored.projectId))?.snapshot()
        .description,
    ).toBeUndefined();
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    destination.database.close();
  });

  test.each(["OPENAI_API_KEY", "github_token"])(
    "rejects structured profile credential key %s before advancing the snapshot head",
    async (key) => {
      const runtimeRoot = temporaryRoot("ai-office-sensitive-profile-");
      const source = temporaryRoot("ai-office-sensitive-profile-source-");
      writeFileSync(
        join(source, "package.json"),
        '{"name":"sensitive-profile"}\n',
      );
      const runtime = openRuntime(runtimeRoot);
      const imported = await importProject(runtime, source);
      const initial = await runtime.service.backup(imported.projectId);
      const createdAt = runtime.clock.now().toISOString();
      runtime.database
        .prepare(
          `INSERT INTO project_profile_entry(
             id, project_id, category, key, value_json, origin, confidence,
             source_reference, confirmed_at, superseded_at, created_at
           ) VALUES (?, ?, 'constraint', ?, ?, 'user', 1, NULL, NULL, NULL, ?)`,
        )
        .run(`profile-${key}`, imported.projectId, key, '"sk-test"', createdAt);

      await expect(runtime.service.backup(imported.projectId)).rejects.toThrow(
        `sensitive credential data (${key})`,
      );
      expect(await runtime.states.findHead(imported.projectId)).toMatchObject({
        revision: { id: initial.revisionId },
      });
      expect(
        runtime.database
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM project_state_revision WHERE project_id = ?",
          )
          .get(imported.projectId)?.count,
      ).toBe(1);
      runtime.database.close();
    },
  );

  test("rejects a nested sensitive profile field while preserving ordinary profile data", async () => {
    const runtimeRoot = temporaryRoot("ai-office-nested-sensitive-profile-");
    const source = temporaryRoot("ai-office-nested-sensitive-source-");
    writeFileSync(
      join(source, "package.json"),
      '{"name":"nested-sensitive"}\n',
    );
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    const createdAt = runtime.clock.now().toISOString();
    const insert = runtime.database.prepare(
      `INSERT INTO project_profile_entry(
         id, project_id, category, key, value_json, origin, confidence,
         source_reference, confirmed_at, superseded_at, created_at
       ) VALUES (?, ?, ?, ?, ?, 'user', 1, NULL, NULL, NULL, ?)`,
    );
    insert.run(
      "profile-preference",
      imported.projectId,
      "preference",
      "review_style",
      '"Prefer concise reviews"',
      createdAt,
    );
    const valid = await runtime.service.backup(imported.projectId);
    expect(valid.archive.state.profileEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "profile-preference",
          value: "Prefer concise reviews",
        }),
      ]),
    );
    insert.run(
      "profile-nested-secret",
      imported.projectId,
      "constraint",
      "provider_configuration",
      '{"token":"secret"}',
      createdAt,
    );
    await expect(runtime.service.backup(imported.projectId)).rejects.toThrow(
      "sensitive field token",
    );
    expect(await runtime.states.findHead(imported.projectId)).toMatchObject({
      revision: { id: valid.revisionId },
    });
    runtime.database.close();
  });

  test("creates parented revisions and rejects rollback over changed local state", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-revision-");
    const source = temporaryRoot("ai-office-portable-source-");
    writeFileSync(join(source, "package.json"), '{"name":"portable"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await new ImportProject(
      runtime.projects,
      runtime.profiles,
      new LocalProjectScanner(),
      runtime.identities,
      runtime.ids,
      runtime.clock,
      runtime.transactions,
    ).execute({ rootPath: source });
    const first = await runtime.service.backup(imported.projectId);
    const independentHead = createPortableProjectArchive({
      state: first.archive.state,
      manifest: {
        ...first.archive.manifest,
        revision: {
          ...first.archive.manifest.revision,
          id: "rev_independent_same_state",
        },
      },
    });
    await expect(
      runtime.service.restore({ archive: independentHead, rootPath: source }),
    ).rejects.toThrow(`local head ${first.revisionId}`);
    await new CreateTask(
      runtime.projects,
      new SqliteTaskRepository(runtime.database),
      runtime.ids,
      runtime.clock,
    ).execute({ projectId: imported.projectId, title: "New local work" });
    const second = await runtime.service.backup(imported.projectId);
    expect(second.parentRevisionId).toBe(first.revisionId);
    await expect(
      runtime.service.restore({ archive: first.archive, rootPath: source }),
    ).rejects.toThrow("Restore conflict");
    runtime.database.close();
  });

  test("enforces globally unique revision IDs and project-local acyclic lineage", async () => {
    const runtimeRoot = temporaryRoot("ai-office-lineage-runtime-");
    const sourceA = temporaryRoot("ai-office-lineage-a-");
    const sourceB = temporaryRoot("ai-office-lineage-b-");
    writeFileSync(join(sourceA, "package.json"), '{"name":"lineage-a"}\n');
    writeFileSync(join(sourceB, "package.json"), '{"name":"lineage-b"}\n');
    const runtime = openRuntime(runtimeRoot);
    const projectA = await importProject(runtime, sourceA);
    const projectB = await importProject(runtime, sourceB);
    const revisionA = await runtime.service.backup(projectA.projectId);
    const revisionB = await runtime.service.backup(projectB.projectId);

    await expect(
      runtime.states.saveRevision({
        id: revisionA.revisionId,
        projectId: projectB.projectId,
        stateChecksum: revisionB.stateChecksum,
        origin: "local_snapshot",
        createdAt: new Date(revisionA.archive.manifest.createdAt),
      }),
    ).rejects.toThrow(
      `Project state revision ${revisionA.revisionId} conflicts`,
    );
    await expect(
      runtime.states.saveRevision({
        id: "rev_cross_project_parent",
        projectId: projectB.projectId,
        parentRevisionId: revisionA.revisionId,
        stateChecksum: revisionB.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      }),
    ).rejects.toThrow("parent from another project");
    await expect(
      runtime.states.saveRevision(
        {
          id: "rev_cross_project_base",
          projectId: projectB.projectId,
          stateChecksum: revisionB.stateChecksum,
          origin: "local_snapshot",
          createdAt: runtime.clock.now(),
        },
        revisionA.revisionId,
      ),
    ).rejects.toThrow("base from another project");

    await runtime.states.saveRevision({
      id: "rev_shallow_child_a",
      projectId: projectA.projectId,
      parentRevisionId: "rev_reserved_parent",
      stateChecksum: revisionA.stateChecksum,
      origin: "local_snapshot",
      createdAt: runtime.clock.now(),
    });
    expect(
      runtime.database
        .query<{ project_id: string }, []>(
          `SELECT project_id FROM project_state_revision_identity
           WHERE revision_id = 'rev_reserved_parent'`,
        )
        .get()?.project_id,
    ).toBe(projectA.projectId);
    expect(() =>
      runtime.database
        .prepare(
          `INSERT INTO project_state_revision(
             id, project_id, parent_revision_id, state_checksum, origin,
             created_at
           ) VALUES ('rev_reserved_parent', ?, NULL, ?, 'local_snapshot', ?)`,
        )
        .run(
          projectB.projectId,
          revisionB.stateChecksum,
          runtime.clock.now().toISOString(),
        ),
    ).toThrow("revision identity belongs to another project");
    await expect(
      runtime.states.saveRevision({
        id: "rev_reserved_parent",
        projectId: projectB.projectId,
        stateChecksum: revisionB.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      }),
    ).rejects.toThrow("conflicts with another project");
    await expect(
      runtime.states.saveRevision({
        id: "rev_reserved_parent",
        projectId: projectA.projectId,
        stateChecksum: revisionA.stateChecksum,
        origin: "portable_import",
        createdAt: runtime.clock.now(),
      }),
    ).resolves.toBeUndefined();

    await runtime.states.saveRevision(
      {
        id: "rev_with_shallow_base",
        projectId: projectA.projectId,
        stateChecksum: revisionA.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      },
      "rev_reserved_base",
    );
    await expect(
      runtime.states.saveRevision({
        id: "rev_reserved_base",
        projectId: projectB.projectId,
        stateChecksum: revisionB.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      }),
    ).rejects.toThrow("conflicts with another project");

    await runtime.states.saveRevision({
      id: "rev_cycle_a",
      projectId: projectA.projectId,
      parentRevisionId: "rev_cycle_b",
      stateChecksum: revisionA.stateChecksum,
      origin: "local_snapshot",
      createdAt: runtime.clock.now(),
    });
    await expect(
      runtime.states.saveRevision({
        id: "rev_cycle_b",
        projectId: projectA.projectId,
        parentRevisionId: "rev_cycle_a",
        stateChecksum: revisionA.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      }),
    ).rejects.toThrow("cyclic lineage");
    runtime.database.close();
  });

  test("restores a shallow lineage anchor and keeps checkout attachment lineage-neutral", async () => {
    const originRuntime = temporaryRoot("ai-office-lineage-origin-");
    const destinationRuntime = temporaryRoot("ai-office-lineage-destination-");
    const source = temporaryRoot("ai-office-lineage-source-");
    const target = temporaryRoot("ai-office-lineage-target-");
    for (const root of [source, target]) {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        '[remote "origin"]\n  url = https://example.test/team/lineage.git\n',
      );
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    const origin = openRuntime(originRuntime);
    const imported = await importProject(origin, source);
    const observed = await origin.service.backup(imported.projectId);
    const beforeAttachment = await origin.states.findHead(imported.projectId);
    const attached = await origin.service.restore({
      archive: observed.archive,
      rootPath: target,
    });
    expect(attached.outcome).toBe("attached");
    expect(await origin.states.findHead(imported.projectId)).toEqual(
      beforeAttachment,
    );
    const forgedTimestamp = createPortableProjectArchive({
      state: observed.archive.state,
      manifest: {
        ...observed.archive.manifest,
        createdAt: "2026-09-01T23:59:59.000Z",
      },
    });
    await expect(
      origin.service.restore({ archive: forgedTimestamp, rootPath: source }),
    ).rejects.toThrow("metadata does not match the local immutable revision");
    origin.database.close();

    const shallow = createPortableProjectArchive({
      state: observed.archive.state,
      manifest: {
        ...observed.archive.manifest,
        revision: {
          ...observed.archive.manifest.revision,
          id: "rev_shallow_head",
          parentRevisionId: "rev_parent_not_stored_here",
        },
      },
    });
    const freshTarget = temporaryRoot("ai-office-lineage-fresh-target-");
    mkdirSync(join(freshTarget, ".git"));
    writeFileSync(
      join(freshTarget, ".git", "config"),
      '[remote "origin"]\n  url = https://example.test/team/lineage.git\n',
    );
    writeFileSync(join(freshTarget, ".git", "HEAD"), "ref: refs/heads/main\n");
    const destination = openRuntime(destinationRuntime);
    const restored = await destination.service.restore({
      archive: shallow,
      rootPath: freshTarget,
    });
    expect(await destination.states.findHead(restored.projectId)).toMatchObject(
      {
        revision: {
          id: "rev_shallow_head",
          parentRevisionId: "rev_parent_not_stored_here",
          origin: "portable_import",
        },
        baseRevisionId: "rev_shallow_head",
      },
    );
    await expect(
      destination.service.restore({ archive: shallow, rootPath: freshTarget }),
    ).resolves.toMatchObject({ outcome: "unchanged" });
    destination.database.close();
  });

  test("round-trips pending, approved, and rejected governance reviews exactly", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-governance-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-governance-b-");
    const source = temporaryRoot("ai-office-portable-governance-source-");
    const target = temporaryRoot("ai-office-portable-governance-target-");
    writeFileSync(join(source, "package.json"), '{"name":"governance"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"governance"}\n');

    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(origin, imported.projectId, "Pending task");
    const governance = new ManageGovernance(
      origin.projects,
      origin.governance,
      origin.ids,
      origin.clock,
    );
    const milestoneId = await governance.createMilestone({
      projectId: imported.projectId,
      title: "Portable milestone",
    });
    const requirementId = await governance.createRequirement({
      projectId: imported.projectId,
      milestoneId,
      key: "PORT-1",
      title: "Portable governance",
      description: "Preserve review and approval semantics.",
    });
    await governance.createReview({
      projectId: imported.projectId,
      subjectType: "task",
      subjectId: taskId,
      reviewer: { type: "user", id: "pending-reviewer" },
    });
    const approvedReview = await governance.createReview({
      projectId: imported.projectId,
      subjectType: "requirement",
      subjectId: requirementId,
      reviewer: { type: "agent", id: "approval-reviewer" },
    });
    await governance.approve({
      projectId: imported.projectId,
      reviewId: approvedReview,
      actor: { type: "user", id: "owner" },
      decision: "approved",
      rationale: "Accepted",
    });
    const rejectedReview = await governance.createReview({
      projectId: imported.projectId,
      subjectType: "milestone",
      subjectId: milestoneId,
      reviewer: { type: "agent", id: "rejection-reviewer" },
    });
    await governance.approve({
      projectId: imported.projectId,
      reviewId: rejectedReview,
      actor: { type: "user", id: "owner" },
      decision: "rejected",
      rationale: "Needs revision",
    });
    const legacyCompletion = "2026-09-01T12:34:56.000Z";
    origin.database
      .prepare(
        "UPDATE review SET completed_at = ? WHERE id = ? AND project_id = ?",
      )
      .run(legacyCompletion, approvedReview, imported.projectId);

    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.state.governance.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "pending" }),
        expect.objectContaining({
          id: approvedReview,
          status: "approved",
          completedAt: legacyCompletion,
        }),
        expect.objectContaining({ id: rejectedReview, status: "rejected" }),
      ]),
    );
    expect(backup.archive.state.governance.approvals).toHaveLength(2);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    destination.database.close();
  });

  test("keeps a run's host-resolved model out of the portable snapshot without a schema change", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-model-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-model-b-");
    const source = temporaryRoot("ai-office-portable-model-source-");
    const target = temporaryRoot("ai-office-portable-model-target-");
    writeFileSync(join(source, "package.json"), '{"name":"model-routing"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"model-routing"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(origin, imported.projectId, "Routed run");
    const { agentId } = await createAgent(origin, imported.projectId, "routed");
    const run = AgentRun.create({
      id: "run-routed",
      projectId: imported.projectId,
      taskId,
      agentId,
      modelRouting: {
        status: "resolved",
        selection: {
          policy: "default",
          profile: "host-private-profile",
          modelRef: "openai:host-private-model",
          providerId: "openai",
          model: "host-private-model",
          reasoningEffort: "high",
          maxOutputTokens: null,
          source: "role_policy",
        },
      },
      now: origin.clock.now(),
    });
    run.transition("cancelled", origin.clock.now(), {
      error: { code: "cancelled-locally" },
    });
    await origin.agentRuntime.saveRun(run);

    const backup = await origin.service.backup(imported.projectId);
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(backup.archive.state.agents.terminalRuns).toEqual([
      expect.objectContaining({ id: "run-routed", status: "cancelled" }),
    ]);
    // The semantic role policy stays portable; the concrete host choice does not.
    expect(backup.archive.state.agents.roles).toEqual([
      expect.objectContaining({ modelPolicy: "default" }),
    ]);
    for (const hostValue of [
      "host-private-model",
      "host-private-profile",
      "modelRouting",
      "role_policy",
    ])
      expect(serialized).not.toContain(hostValue);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    // A restored historical run is explicitly unrecorded, never re-resolved.
    expect(
      (await destination.agentRuntime.findRun("run-routed"))?.snapshot()
        .modelRouting,
    ).toBeUndefined();
    destination.database.close();
  });

  test("excludes active-run governance until its subject becomes portable", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-active-review-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-active-review-b-");
    const source = temporaryRoot("ai-office-portable-active-review-source-");
    const target = temporaryRoot("ai-office-portable-active-review-target-");
    writeFileSync(join(source, "package.json"), '{"name":"active-review"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"active-review"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(origin, imported.projectId, "Reviewed run");
    const { agentId } = await createAgent(origin, imported.projectId, "review");
    const run = AgentRun.create({
      id: "run-reviewed",
      projectId: imported.projectId,
      taskId,
      agentId,
      actionIntent: {
        resourceId: "resource-local",
        operation: "filesystem.read",
        arguments: { path: "README.md" },
      },
      now: origin.clock.now(),
    });
    await origin.agentRuntime.saveRun(run);
    const governance = new ManageGovernance(
      origin.projects,
      origin.governance,
      origin.ids,
      origin.clock,
    );
    const reviewId = await governance.createReview({
      projectId: imported.projectId,
      subjectType: "agent_run",
      subjectId: run.snapshot().id,
      reviewer: { type: "user", id: "reviewer" },
    });
    await governance.approve({
      projectId: imported.projectId,
      reviewId,
      actor: { type: "user", id: "owner" },
      decision: "approved",
    });

    const activeSubset = await origin.states.loadPortableState(
      imported.projectId,
    );
    expect(activeSubset.agents.terminalRuns).toEqual([]);
    expect(activeSubset.governance.reviews).toEqual([]);
    expect(activeSubset.governance.approvals).toEqual([]);
    await expect(origin.service.backup(imported.projectId)).rejects.toThrow(
      "Active agent run run-reviewed: queued",
    );
    expect(await origin.states.findHead(imported.projectId)).toBeNull();

    run.transition("cancelled", origin.clock.now(), {
      worktreePath: "/machine-a/private/worktree",
      error: { code: "cancelled-locally" },
    });
    await origin.agentRuntime.saveRun(run);
    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.state.governance.reviews).toEqual([
      expect.objectContaining({ id: reviewId, subjectId: "run-reviewed" }),
    ]);
    expect(backup.archive.state.governance.approvals).toHaveLength(1);
    expect(backup.archive.state.agents.terminalRuns).toEqual([
      expect.objectContaining({ id: "run-reviewed", status: "cancelled" }),
    ]);
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).not.toContain("machine-a/private/worktree");
    expect(serialized).not.toContain("resource-local");
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    const restoredRun = await destination.agentRuntime.findRun("run-reviewed");
    const restoredSummary = restoredRun!.snapshot();
    expect(restoredSummary.status).toBe("cancelled");
    for (const field of [
      "pipelineRunId",
      "actionIntent",
      "worktreePath",
      "result",
      "error",
    ] as const)
      expect(field in restoredSummary).toBe(false);
    expect(() =>
      restoredRun?.transition("running", destination.clock.now()),
    ).toThrow("Cannot transition agent run from cancelled to running");
    const actionGateway = new RequestControlledAction(
      {} as unknown as EvaluateActionPolicy,
      {} as unknown as CapabilityPolicyRepository,
      {} as unknown as RecordAuditEvent,
      destination.ids,
      destination.clock,
      destination.transactions,
      destination.agentRuntime,
    );
    await expect(
      actionGateway.executeFromAgentRun("run-reviewed"),
    ).rejects.toThrow("Agent run is not executing an action intent");
    expect(
      await destination.agentRuntime.acquireTaskLock(
        restoredSummary.taskId,
        restoredSummary.id,
        destination.clock.now(),
        new Date(destination.clock.now().getTime() + 60_000),
      ),
    ).toBe(false);
    destination.database.close();
  });

  test("restores every terminal run status as non-executable summary state", async () => {
    const sourceRuntime = temporaryRoot("ai-office-terminal-source-");
    const targetRuntime = temporaryRoot("ai-office-terminal-target-");
    const source = temporaryRoot("ai-office-terminal-checkout-a-");
    const target = temporaryRoot("ai-office-terminal-checkout-b-");
    writeFileSync(join(source, "package.json"), '{"name":"terminal"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"terminal"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(
      origin,
      imported.projectId,
      "Terminal runs",
    );
    const { agentId } = await createAgent(
      origin,
      imported.projectId,
      "terminal",
    );
    const statuses = ["completed", "failed", "cancelled"] as const;
    for (const status of statuses) {
      const run = AgentRun.create({
        id: `run-${status}`,
        projectId: imported.projectId,
        taskId,
        agentId,
        actionIntent: {
          resourceId: "machine-local-resource",
          operation: "filesystem.read",
          arguments: { path: "README.md" },
        },
        now: origin.clock.now(),
      });
      if (status === "completed") {
        run.transition("preparing", origin.clock.now());
        run.transition("running", origin.clock.now());
        run.transition("completed", origin.clock.now());
      } else if (status === "failed") {
        run.transition("preparing", origin.clock.now());
        run.transition("failed", origin.clock.now());
      } else run.transition("cancelled", origin.clock.now());
      await origin.agentRuntime.saveRun(run);
    }
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    const actionGateway = new RequestControlledAction(
      {} as unknown as EvaluateActionPolicy,
      {} as unknown as CapabilityPolicyRepository,
      {} as unknown as RecordAuditEvent,
      destination.ids,
      destination.clock,
      destination.transactions,
      destination.agentRuntime,
    );
    const pipelines = new ManagePipelineRuns(
      new SqliteOfficeManifestRepository(destination.database),
      new SqlitePipelineRunRepository(destination.database),
      new SqliteTaskRepository(destination.database),
      destination.agentRuntime,
      new RecordAuditEvent(
        new SqliteAuditEventRepository(destination.database),
        destination.ids,
        destination.clock,
      ),
      destination.ids,
      destination.clock,
      destination.transactions,
    );
    for (const status of statuses) {
      const runId = `run-${status}`;
      const summary = (await destination.agentRuntime.findRun(runId))!;
      expect(summary.snapshot()).toMatchObject({ status });
      expect(() =>
        summary.transition("running", destination.clock.now()),
      ).toThrow(`Cannot transition agent run from ${status} to running`);
      await expect(actionGateway.executeFromAgentRun(runId)).rejects.toThrow(
        "Agent run is not executing an action intent",
      );
      await expect(
        pipelines.completeStageFromAgentRun({
          projectId: restored.projectId,
          agentRunId: runId,
        }),
      ).rejects.toThrow("not authorized");
      expect(
        await destination.agentRuntime.acquireTaskLock(
          taskId,
          runId,
          destination.clock.now(),
          new Date(destination.clock.now().getTime() + 60_000),
        ),
      ).toBe(false);
      const survivingExpiry = new Date(
        destination.clock.now().getTime() + 60_000,
      );
      destination.database
        .prepare(
          `INSERT INTO task_lock(task_id, run_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          taskId,
          runId,
          destination.clock.now().toISOString(),
          survivingExpiry.toISOString(),
        );
      expect(
        await destination.agentRuntime.renewTaskLock(
          runId,
          destination.clock.now(),
          new Date(survivingExpiry.getTime() + 60_000),
        ),
      ).toBe(false);
      destination.database
        .prepare("DELETE FROM task_lock WHERE run_id = ?")
        .run(runId);
    }
    destination.database.close();
  });

  test("requires execution quiescence without advancing the snapshot head", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-quiescence-");
    const source = temporaryRoot("ai-office-portable-quiescence-source-");
    writeFileSync(join(source, "package.json"), '{"name":"quiescence"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    await createTask(runtime, imported.projectId, "Pending portable work");
    const completedTaskId = await createTask(
      runtime,
      imported.projectId,
      "Completed portable work",
    );
    const tasks = new SqliteTaskRepository(runtime.database);
    const completedTask = await tasks.findById(completedTaskId);
    completedTask!.start(runtime.clock.now());
    completedTask!.complete(runtime.clock.now());
    await tasks.save(completedTask!);
    const quiescent = await runtime.service.backup(imported.projectId);
    expect(
      quiescent.archive.state.tasks.map((item) => item.status).sort(),
    ).toEqual(["completed", "pending"]);

    const runningTaskId = await createTask(
      runtime,
      imported.projectId,
      "Operational work",
    );
    const runningTask = await tasks.findById(runningTaskId);
    const now = runtime.clock.now();
    runningTask!.start(now);
    await tasks.save(runningTask!);
    const manifest = {
      schemaVersion: 1 as const,
      provenance: {
        host: "codex",
        skill: "ai-office" as const,
        skillVersion: "1",
      },
      project: {
        mission: "Test portable execution quiescence.",
        goals: ["Preserve coherent snapshots."],
        constraints: [],
        preferences: [],
        permissionPreferences: [],
      },
      office: {
        name: "Test office",
        roles: [
          {
            id: "worker",
            title: "Worker",
            purpose: "Execute work.",
            responsibilities: ["Deliver the task."],
          },
        ],
      },
      pipelines: [
        {
          id: "delivery",
          name: "Delivery",
          description: "One enforced stage.",
          defaultFor: ["feature" as const],
          enforcement: "enforced" as const,
          stages: [
            {
              id: "work",
              name: "Work",
              roleId: "worker",
              objective: "Complete the task.",
              checks: [],
              requiresApproval: false,
              capabilities: [],
            },
          ],
        },
      ],
    };
    runtime.database
      .prepare(
        `INSERT INTO office_manifest_revision(
           id, project_id, revision, schema_version, manifest_json,
           source_host, source_skill, source_skill_version, applied_at
         ) VALUES (?, ?, 1, 1, ?, 'codex', 'ai-office', '1', ?)`,
      )
      .run(
        "manifest-quiescence",
        imported.projectId,
        JSON.stringify(manifest),
        now.toISOString(),
      );
    const pipeline = PipelineRun.create({
      id: "pipeline-active",
      projectId: imported.projectId,
      taskId: runningTaskId,
      manifestRevisionId: "manifest-quiescence",
      manifestRevision: 1,
      definition: manifest.pipelines[0]!,
      startedBy: "operator",
      stageRunIds: ["pipeline-stage-active"],
      now,
    });
    await new SqlitePipelineRunRepository(runtime.database).insert(pipeline);
    const { agentId } = await createAgent(
      runtime,
      imported.projectId,
      "quiescence",
    );
    const run = AgentRun.create({
      id: "run-active",
      projectId: imported.projectId,
      taskId: runningTaskId,
      agentId,
      now,
    });
    await runtime.agentRuntime.saveRun(run);
    await runtime.agentRuntime.acquireTaskLock(
      runningTaskId,
      run.snapshot().id,
      now,
      new Date(now.getTime() + 60_000),
    );

    let failure: unknown;
    try {
      await runtime.service.backup(imported.projectId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const failureMessage = failure instanceof Error ? failure.message : "";
    expect(failureMessage).not.toContain(`Task ${runningTaskId}: running`);
    expect(failureMessage).toContain(
      `Active pipeline pipeline-active (task ${runningTaskId})`,
    );
    expect(failureMessage).toContain(
      `Active agent run run-active: queued (task ${runningTaskId})`,
    );
    expect(failureMessage).toContain(
      `Active task lock for task ${runningTaskId} (run run-active`,
    );
    expect(
      (await runtime.states.findHead(imported.projectId))?.revision.id,
    ).toBe(quiescent.revisionId);
    expect(
      runtime.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM project_state_revision WHERE project_id = ?",
        )
        .get(imported.projectId)?.count,
    ).toBe(1);
    runtime.database.close();
  });

  test("preserves task lifecycle state when no live execution authority exists", async () => {
    const sourceRuntime = temporaryRoot("ai-office-task-state-source-");
    const targetRuntime = temporaryRoot("ai-office-task-state-target-");
    const source = temporaryRoot("ai-office-task-state-checkout-a-");
    const target = temporaryRoot("ai-office-task-state-checkout-b-");
    writeFileSync(join(source, "package.json"), '{"name":"task-state"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"task-state"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const expected = [
      "assigned",
      "running",
      "blocked",
      "waiting_review",
    ] as const;
    for (const status of expected) {
      const taskId = await createTask(
        origin,
        imported.projectId,
        `Semantic ${status}`,
      );
      origin.database
        .prepare("UPDATE task SET status = ? WHERE id = ?")
        .run(status, taskId);
    }

    expect(
      await origin.states.findPortabilityBlockers(
        imported.projectId,
        origin.clock.now(),
      ),
    ).toEqual([]);
    const backup = await origin.service.backup(imported.projectId);
    expect(
      backup.archive.state.tasks.map((task) => task.status).sort(),
    ).toEqual([...expected].sort());
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    destination.database.close();
  });

  test("round-trips task/requirement links and enforces their closure", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-links-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-links-b-");
    const source = temporaryRoot("ai-office-portable-links-source-");
    const target = temporaryRoot("ai-office-portable-links-target-");
    writeFileSync(join(source, "package.json"), '{"name":"links"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"links"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const governanceService = new ManageGovernance(
      origin.projects,
      origin.governance,
      origin.ids,
      origin.clock,
    );
    const links = new SqliteTaskRequirementRepository(origin.database);

    const taskA = await createTask(
      origin,
      imported.projectId,
      "Deliver AUC-03",
    );
    const taskB = await createTask(
      origin,
      imported.projectId,
      "Document AUC-03",
    );
    const requirement = await governanceService.createRequirement({
      projectId: imported.projectId,
      key: "AUC-03-R1",
      title: "Acceptance",
      description: "Must hold",
    });
    // One requirement delivered by two tasks: the many-to-many shape has to
    // survive the round trip, not just a single pair.
    for (const taskId of [taskA, taskB])
      expect(
        await links.link({
          projectId: imported.projectId,
          taskId,
          requirementId: requirement,
          now: origin.clock.now(),
        }),
      ).toBe(true);

    const backup = await origin.service.backup(imported.projectId);
    // New backups carry explicit lifetime execution knowledge in version 4.
    expect(backup.archive.manifest.formatVersion).toBe(6);
    expect(backup.archive.manifest.contents).toContain("task_requirements");
    expect(backup.archive.state.taskDependencies).toEqual([]);
    expect(
      backup.archive.state.governance.taskRequirements?.map((value) => ({
        taskId: value.taskId,
        requirementId: value.requirementId,
      })),
    ).toEqual(
      [taskA, taskB]
        .sort()
        .map((taskId) => ({ taskId, requirementId: requirement })),
    );
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    // `restorePortableState` reloads and compares canonically, so an exact
    // match here is also proof that restore is byte-for-byte round-trippable.
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    expect(
      (
        await new SqliteTaskRequirementRepository(
          destination.database,
        ).listForTask(restored.projectId, taskA)
      ).map((value) => value.key),
    ).toEqual(["AUC-03-R1"]);
    destination.database.close();
  });

  test("exports and restores a version 4 dependency graph without semantic drift", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-deps-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-deps-b-");
    const source = temporaryRoot("ai-office-portable-deps-source-");
    const target = temporaryRoot("ai-office-portable-deps-target-");
    writeFileSync(join(source, "package.json"), '{"name":"dependencies"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"dependencies"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const prerequisite = await createTask(
      origin,
      imported.projectId,
      "Prerequisite",
    );
    const otherPrerequisite = await createTask(
      origin,
      imported.projectId,
      "Another prerequisite",
    );
    const dependent = await createTask(origin, imported.projectId, "Dependent");
    const dependencies = new SqliteTaskDependencyRepository(origin.database);
    const firstEdge = {
      projectId: imported.projectId,
      taskId: dependent,
      dependsOnTaskId: prerequisite,
      createdAt: origin.clock.now(),
    };
    const otherEdge = { ...firstEdge, dependsOnTaskId: otherPrerequisite };
    expect(await dependencies.link(firstEdge)).toBe(true);
    expect(await dependencies.link(otherEdge)).toBe(true);
    const beforeReorder = portableStateChecksum(
      await origin.states.loadPortableState(imported.projectId),
    );
    expect(
      await dependencies.unlink(imported.projectId, dependent, prerequisite),
    ).toBe(true);
    expect(await dependencies.link(firstEdge)).toBe(true);
    expect(
      portableStateChecksum(
        await origin.states.loadPortableState(imported.projectId),
      ),
    ).toBe(beforeReorder);
    const first = await origin.service.backup(imported.projectId);
    expect(first.archive.manifest.formatVersion).toBe(6);
    expect(first.archive.state.taskDependencies).toHaveLength(2);
    for (const invalidDependencies of [
      [
        {
          taskId: dependent,
          dependsOnTaskId: "other-project-task",
          createdAt: origin.clock.now().toISOString(),
        },
      ],
      [
        {
          taskId: dependent,
          dependsOnTaskId: prerequisite,
          createdAt: origin.clock.now().toISOString(),
        },
        {
          taskId: prerequisite,
          dependsOnTaskId: dependent,
          createdAt: origin.clock.now().toISOString(),
        },
      ],
    ]) {
      const invalidState = {
        ...first.archive.state,
        taskDependencies: invalidDependencies,
      };
      expect(() =>
        createPortableProjectArchive({
          manifest: {
            ...first.archive.manifest,
            revision: {
              ...first.archive.manifest.revision,
              stateChecksum: portableStateChecksum(invalidState),
            },
          },
          state: invalidState,
        }),
      ).toThrow();
    }
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: first.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(first.archive.state);
    const second = await destination.service.backup(restored.projectId);
    expect(serializePortableProjectArchive(second.archive)).toBe(
      serializePortableProjectArchive(first.archive),
    );
    destination.database.close();
  });

  test("exports explicit pristine history even when a project has no links", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-v1-");
    const targetRuntime = temporaryRoot("ai-office-portable-v1-target-");
    const source = temporaryRoot("ai-office-portable-v1-source-");
    const target = temporaryRoot("ai-office-portable-v1-restore-");
    writeFileSync(join(source, "package.json"), '{"name":"unlinked"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"unlinked"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    await createTask(origin, imported.projectId, "Unlinked work");

    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.manifest.formatVersion).toBe(6);
    expect(backup.archive.manifest.contents).toContain(
      "task_execution_history",
    );
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).toContain("taskExecutionHistory");
    expect(parsePortableProjectArchive(serialized)).toEqual(backup.archive);
    origin.database.close();

    // A pristine version 4 archive restores to a project with no links.
    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await new SqliteTaskRequirementRepository(
        destination.database,
      ).listByProject(restored.projectId),
    ).toEqual([]);
    const [task] = backup.archive.state.tasks;
    const other = await createTask(
      destination,
      restored.projectId,
      "Prerequisite",
    );
    const edges = new SqliteTaskDependencyRepository(destination.database);
    expect(
      await edges.link({
        projectId: restored.projectId,
        taskId: task!.id,
        dependsOnTaskId: other,
        createdAt: destination.clock.now(),
      }),
    ).toBe(true);
    expect(await edges.unlink(restored.projectId, task!.id, other)).toBe(true);
    destination.database.close();
  });

  test("v4 preserves lifetime execution after a legal return to pending", async () => {
    const sourceRuntime = temporaryRoot("ai-office-v4-history-a-");
    const targetRuntime = temporaryRoot("ai-office-v4-history-b-");
    const source = temporaryRoot("ai-office-v4-history-source-");
    const target = temporaryRoot("ai-office-v4-history-target-");
    for (const path of [source, target])
      writeFileSync(join(path, "package.json"), '{"name":"history"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const prerequisite = await createTask(origin, imported.projectId, "First");
    const alternative = await createTask(
      origin,
      imported.projectId,
      "Alternative",
    );
    const dependent = await createTask(origin, imported.projectId, "Dependent");
    const edges = new SqliteTaskDependencyRepository(origin.database);
    expect(
      await edges.link({
        projectId: imported.projectId,
        taskId: dependent,
        dependsOnTaskId: prerequisite,
        createdAt: origin.clock.now(),
      }),
    ).toBe(true);
    const tasks = new SqliteTaskRepository(origin.database);
    const completedPrerequisite = (await tasks.findById(prerequisite))!;
    completedPrerequisite.recordHistoricalCompletion(origin.clock.now());
    await tasks.save(completedPrerequisite);
    const task = (await tasks.findById(dependent))!;
    task.start(origin.clock.now());
    await tasks.save(task);
    task.block(origin.clock.now());
    await tasks.save(task);
    task.unblock(origin.clock.now());
    await tasks.save(task);
    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.manifest.formatVersion).toBe(6);
    expect(backup.archive.state.taskExecutionHistory).toContainEqual(
      expect.objectContaining({ taskId: dependent, state: "executed" }),
    );
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    const restoredEdges = new SqliteTaskDependencyRepository(
      destination.database,
    );
    expect(
      (
        await new SqliteTaskRepository(destination.database).findById(dependent)
      )?.snapshot().status,
    ).toBe("pending");
    await expect(
      restoredEdges.unlink(restored.projectId, dependent, prerequisite),
    ).rejects.toThrow("execution history");
    await expect(
      restoredEdges.link({
        projectId: restored.projectId,
        taskId: dependent,
        dependsOnTaskId: alternative,
        createdAt: destination.clock.now(),
      }),
    ).rejects.toThrow("execution history");
    const roundTrip = await destination.service.backup(restored.projectId);
    expect(roundTrip.archive.state).toEqual(backup.archive.state);
    expect(roundTrip.archive.manifest.revision.stateChecksum).toBe(
      backup.archive.manifest.revision.stateChecksum,
    );
    destination.database.close();
  });

  test("v4 preserves AgentRun and pipeline execution history without portable pipeline runs", async () => {
    const sourceRuntime = temporaryRoot("ai-office-v4-run-a-");
    const targetRuntime = temporaryRoot("ai-office-v4-run-b-");
    const source = temporaryRoot("ai-office-v4-run-source-");
    const target = temporaryRoot("ai-office-v4-run-target-");
    for (const path of [source, target])
      writeFileSync(join(path, "package.json"), '{"name":"run-history"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const prerequisite = await createTask(
      origin,
      imported.projectId,
      "Prerequisite",
    );
    const runTask = await createTask(origin, imported.projectId, "Run task");
    const pipelineTask = await createTask(
      origin,
      imported.projectId,
      "Pipeline task",
    );
    const edges = new SqliteTaskDependencyRepository(origin.database);
    for (const taskId of [runTask, pipelineTask])
      expect(
        await edges.link({
          projectId: imported.projectId,
          taskId,
          dependsOnTaskId: prerequisite,
          createdAt: origin.clock.now(),
        }),
      ).toBe(true);
    const tasks = new SqliteTaskRepository(origin.database);
    const completedPrerequisite = (await tasks.findById(prerequisite))!;
    completedPrerequisite.recordHistoricalCompletion(origin.clock.now());
    await tasks.save(completedPrerequisite);
    const { agentId } = await createAgent(
      origin,
      imported.projectId,
      "history",
    );
    const run = AgentRun.create({
      id: "history-run",
      projectId: imported.projectId,
      taskId: runTask,
      agentId,
      now: origin.clock.now(),
    });
    run.transition("cancelled", origin.clock.now(), {
      error: { code: "cancelled" },
    });
    await origin.agentRuntime.saveRun(run);
    const now = origin.clock.now().toISOString();
    const definition = {
      id: "delivery",
      name: "Delivery",
      description: "Fixture",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "work",
          name: "Work",
          roleId: "worker",
          objective: "Work",
          checks: [],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    };
    const manifest = {
      schemaVersion: 1,
      provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
      project: {
        mission: "Fixture",
        goals: ["Preserve history"],
        constraints: [],
        preferences: [],
        permissionPreferences: [],
      },
      office: {
        name: "Fixture",
        roles: [
          {
            id: "worker",
            title: "Worker",
            purpose: "Work",
            responsibilities: ["Work"],
          },
        ],
      },
      pipelines: [definition],
    };
    origin.database
      .prepare(
        `INSERT INTO office_manifest_revision(id,project_id,revision,schema_version,manifest_json,
      source_host,source_skill,source_skill_version,applied_at) VALUES ('history-manifest',?,1,1,?,'codex','ai-office','1',?)`,
      )
      .run(imported.projectId, JSON.stringify(manifest), now);
    origin.database
      .prepare(
        `INSERT INTO pipeline_run(id,project_id,task_id,manifest_revision_id,manifest_revision,
      definition_json,status,current_stage_index,started_by,version,created_at,updated_at,cancelled_at)
      VALUES ('history-pipeline',?,?,'history-manifest',1,?,'cancelled',0,'operator',1,?,?,?)`,
      )
      .run(
        imported.projectId,
        pipelineTask,
        JSON.stringify(definition),
        now,
        now,
        now,
      );
    const backup = await origin.service.backup(imported.projectId);
    for (const taskId of [runTask, pipelineTask])
      expect(backup.archive.state.taskExecutionHistory).toContainEqual(
        expect.objectContaining({ taskId, state: "executed" }),
      );
    origin.database.close();
    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    for (const taskId of [runTask, pipelineTask]) {
      const restoredEdges = new SqliteTaskDependencyRepository(
        destination.database,
      );
      await expect(
        restoredEdges.unlink(restored.projectId, taskId, prerequisite),
      ).rejects.toThrow("execution history");
    }
    expect(
      destination.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pipeline_run",
        )
        .get()?.count,
    ).toBe(0);
    destination.database.close();
  });

  test.each([1, 2, 3] as const)(
    "legacy v%d archives restore with unknown dependency editability",
    async (version) => {
      const sourceRuntime = temporaryRoot(`ai-office-v${version}-legacy-a-`);
      const targetRuntime = temporaryRoot(`ai-office-v${version}-legacy-b-`);
      const source = temporaryRoot(`ai-office-v${version}-legacy-source-`);
      const target = temporaryRoot(`ai-office-v${version}-legacy-target-`);
      for (const path of [source, target])
        writeFileSync(
          join(path, "package.json"),
          '{"name":"legacy-history"}\n',
        );
      const origin = openRuntime(sourceRuntime);
      const imported = await importProject(origin, source);
      const dependent = await createTask(
        origin,
        imported.projectId,
        "Legacy task",
      );
      const prerequisite = await createTask(
        origin,
        imported.projectId,
        "Prerequisite",
      );
      const tasks = new SqliteTaskRepository(origin.database);
      const task = (await tasks.findById(dependent))!;
      task.start(origin.clock.now());
      await tasks.save(task);
      task.block(origin.clock.now());
      await tasks.save(task);
      task.unblock(origin.clock.now());
      await tasks.save(task);
      const fresh = await origin.service.backup(imported.projectId);
      const legacyState = portableStateAtFormatVersion(
        fresh.archive.state,
        version,
      );
      const legacy = createPortableProjectArchive({
        state: legacyState,
        manifest: portableProjectManifestFor({
          formatVersion: version,
          projectIdentity: fresh.archive.manifest.projectIdentity,
          createdAt: fresh.archive.manifest.createdAt,
          revision: {
            ...fresh.archive.manifest.revision,
            stateChecksum: portableStateChecksum(legacyState),
          },
        }),
      });
      origin.database.close();
      const destination = openRuntime(targetRuntime);
      const restored = await destination.service.restore({
        archive: legacy,
        rootPath: target,
      });
      expect(
        (await destination.states.loadPortableState(restored.projectId))
          .taskExecutionHistory,
      ).toContainEqual({ taskId: dependent, state: "unknown" });
      await expect(
        new SqliteTaskDependencyRepository(destination.database).link({
          projectId: restored.projectId,
          taskId: dependent,
          dependsOnTaskId: prerequisite,
          createdAt: destination.clock.now(),
        }),
      ).rejects.toThrow("execution history");
      const upgraded = await destination.service.backup(restored.projectId);
      expect(upgraded.archive.manifest.formatVersion).toBe(6);
      expect(upgraded.archive.state.taskExecutionHistory).toContainEqual({
        taskId: dependent,
        state: "unknown",
      });
      destination.database.close();
    },
  );

  test("refuses an archive whose link references an absent requirement", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-links-c-");
    const source = temporaryRoot("ai-office-portable-links-c-source-");
    writeFileSync(join(source, "package.json"), '{"name":"links"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(origin, imported.projectId, "Orphan");
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    // A snapshot must never carry a link it cannot resolve inside itself.
    expect(() =>
      createPortableProjectArchive({
        // The current referential check must reject it, not the version guard.
        manifest: portableProjectManifestFor({
          formatVersion: 6,
          projectIdentity: backup.archive.manifest.projectIdentity,
          createdAt: backup.archive.manifest.createdAt,
          revision: {
            ...backup.archive.manifest.revision,
            stateChecksum: portableStateChecksum({
              ...backup.archive.state,
              governance: {
                ...backup.archive.state.governance,
                taskRequirements: [
                  {
                    taskId,
                    requirementId: "req-missing",
                    createdAt: "2026-09-01T08:00:00.000Z",
                  },
                ],
              },
            }),
          },
        }),
        state: {
          ...backup.archive.state,
          governance: {
            ...backup.archive.state.governance,
            taskRequirements: [
              {
                taskId,
                requirementId: "req-missing",
                createdAt: "2026-09-01T08:00:00.000Z",
              },
            ],
          },
        },
      }),
    ).toThrow(/Referenced requirement req-missing is not portable/u);
  });

  test("rejects a repository/archive identity mismatch before state mutation", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-source-runtime-");
    const source = temporaryRoot("ai-office-portable-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-target-runtime-");
    const target = temporaryRoot("ai-office-portable-target-");
    writeFileSync(join(source, "package.json"), '{"name":"origin"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"target"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const bindings = new LocalProjectBindingAdapter();
    await bindings.applyWrite(
      await bindings.planWrite(target, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: "repo_unrelated",
      }),
    );
    const destination = openRuntime(targetRuntime);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow("does not match archive project");
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(0);
    destination.database.close();
  });

  test("rejects restore into a checkout with different Git provenance", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-git-source-");
    const source = temporaryRoot("ai-office-portable-git-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-git-target-");
    const target = temporaryRoot("ai-office-portable-git-checkout-");
    for (const [root, remote] of [
      [source, "https://portable:must-not-export@example.test/team/source.git"],
      [target, "https://example.test/team/unrelated.git"],
    ] as const) {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        `[remote "origin"]\n  url = ${remote}\n`,
      );
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(root, ".git", "refs", "remotes", "origin"), {
        recursive: true,
      });
      writeFileSync(
        join(root, ".git", "refs", "remotes", "origin", "HEAD"),
        "ref: refs/remotes/origin/main\n",
      );
    }
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    const backup = await origin.service.backup(imported.projectId);
    expect(serializePortableProjectArchive(backup.archive)).not.toContain(
      "must-not-export",
    );
    expect(backup.archive.manifest.source).toMatchObject({
      type: "git",
      remote: "https://example.test/team/source.git",
      branch: "main",
    });
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow("Git remote does not match");
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(0);
    const bindings = new LocalProjectBindingAdapter();
    await bindings.applyWrite(
      await bindings.planWrite(target, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: backup.projectIdentity,
      }),
    );
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).resolves.toMatchObject({
      outcome: "restored",
      projectIdentity: backup.projectIdentity,
    });
    destination.database.close();
  });

  test("omits a local filesystem Git remote from the archive", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-local-remote-");
    const source = temporaryRoot("ai-office-portable-local-repository-");
    mkdirSync(join(source, ".git"));
    const localRemote = "/Users/alice/dev/private/upstream.git";
    writeFileSync(
      join(source, ".git", "config"),
      `[remote "origin"]\n  url = ${localRemote}\n`,
    );
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    const backup = await runtime.service.backup(imported.projectId);
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).not.toContain(localRemote);
    expect(backup.archive.manifest.source).toBeUndefined();
    runtime.database.close();
  });

  test("selects source provenance deterministically across multiple checkouts", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-sources-");
    const source = temporaryRoot("ai-office-portable-source-primary-");
    writeFileSync(join(source, "package.json"), '{"name":"sources"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    const now = runtime.clock.now();
    await runtime.profiles.saveSource({
      id: "source-network-two",
      projectId: imported.projectId,
      sourceType: "local",
      localPath: "/stale/checkout/two",
      remoteUrl: "https://alice:secret@example.test/team/project.git",
      defaultBranch: "main",
      createdAt: new Date(now.getTime() - 2_000),
    });
    await runtime.profiles.saveSource({
      id: "source-network-one",
      projectId: imported.projectId,
      sourceType: "local",
      localPath: "/stale/checkout/one",
      remoteUrl: "https://example.test/team/project.git",
      defaultBranch: "main",
      createdAt: new Date(now.getTime() - 3_000),
    });

    const agreed = await runtime.service.backup(imported.projectId);
    expect(agreed.archive.manifest.source).toEqual({
      type: "git",
      remote: "https://example.test/team/project.git",
      branch: "main",
    });
    expect(serializePortableProjectArchive(agreed.archive)).not.toContain(
      "secret",
    );

    await runtime.profiles.saveSource({
      id: "source-conflict",
      projectId: imported.projectId,
      sourceType: "local",
      localPath: "/stale/checkout/conflict",
      remoteUrl: "https://example.test/another/project.git",
      defaultBranch: "main",
      createdAt: new Date(now.getTime() - 4_000),
    });
    const ambiguous = await runtime.service.backup(imported.projectId);
    expect(ambiguous.revisionId).toBe(agreed.revisionId);
    expect(ambiguous.archive.manifest.source).toBeUndefined();
    runtime.database.close();
  });

  test("rolls back authoritative state when a restored entity conflicts", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-atomic-source-");
    const source = temporaryRoot("ai-office-portable-atomic-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-atomic-target-");
    const target = temporaryRoot("ai-office-portable-atomic-checkout-");
    writeFileSync(join(source, "package.json"), '{"name":"origin"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"target"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    await new CreateTask(
      origin.projects,
      new SqliteTaskRepository(origin.database),
      origin.ids,
      origin.clock,
    ).execute({ projectId: imported.projectId, title: "Colliding task" });
    const backup = await origin.service.backup(imported.projectId);
    const taskId = backup.archive.state.tasks[0]!.id;
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const now = "2026-09-01T00:00:00.000Z";
    destination.database
      .prepare(
        `INSERT INTO project(id, name, created_at, updated_at)
         VALUES ('unrelated', 'Unrelated', ?, ?)`,
      )
      .run(now, now);
    destination.database
      .prepare(
        `INSERT INTO task(
           id, project_id, title, status, priority, created_at, updated_at
         ) VALUES (?, 'unrelated', 'Existing', 'pending', 0, ?, ?)`,
      )
      .run(taskId, now, now);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow();
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(1);
    expect(
      await destination.identities.findProjectId(backup.projectIdentity),
    ).toBeNull();
    expect(
      await new LocalProjectBindingAdapter().inspect(target),
    ).toMatchObject({ status: "missing" });
    destination.database.close();
  });

  test("recovers idempotently when binding publication fails after restore commit", async () => {
    const sourceRuntime = temporaryRoot("ai-office-partial-source-");
    const targetRuntime = temporaryRoot("ai-office-partial-target-");
    const source = temporaryRoot("ai-office-partial-checkout-a-");
    const target = temporaryRoot("ai-office-partial-checkout-b-");
    writeFileSync(join(source, "package.json"), '{"name":"partial"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"partial"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const local = new ExactTestRootBindingAdapter();
    let fail = true;
    const bindings: ProjectBindingAdapter = {
      resolveProjectRoot: (path) => local.resolveProjectRoot(path),
      inspect: (path, options) => local.inspect(path, options),
      planWrite: (path, binding) => local.planWrite(path, binding),
      applyWrite: async (plan) => {
        if (fail) {
          fail = false;
          throw new Error("injected binding publication failure");
        }
        await local.applyWrite(plan);
      },
      planRemove: (path) => local.planRemove(path),
      applyRemove: (plan) => local.applyRemove(plan),
    };
    const service = new ManageProjectPortability({
      projects: destination.projects,
      profiles: destination.profiles,
      identities: destination.identities,
      states: destination.states,
      bindings,
      scanner: new LocalProjectScanner(),
      transactions: destination.transactions,
      ids: destination.ids,
      clock: destination.clock,
    });

    let partial: unknown;
    try {
      await service.restore({ archive: backup.archive, rootPath: target });
    } catch (error) {
      partial = error;
    }
    expect(partial).toBeInstanceOf(ProjectRestorePartialError);
    const mappedProject = await destination.identities.findProjectId(
      backup.projectIdentity,
    );
    expect(mappedProject).not.toBeNull();
    expect(
      (await destination.states.findHead(mappedProject!))?.revision.id,
    ).toBe(backup.revisionId);
    expect(await local.inspect(target)).toMatchObject({ status: "missing" });

    await expect(
      service.restore({ archive: backup.archive, rootPath: target }),
    ).resolves.toMatchObject({
      outcome: "unchanged",
      projectId: mappedProject,
      revisionId: backup.revisionId,
    });
    expect(await local.inspect(target)).toMatchObject({ status: "valid" });
    destination.database.close();
  });
});

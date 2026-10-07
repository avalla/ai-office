import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ReconcileProjectPackUpgrade } from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import { ProjectDefinitionConflictError } from "@ai-office/application/domain-pack/project-definition.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const now = new Date("2026-10-06T00:00:00.000Z");
const later = new Date("2026-10-07T00:00:00.000Z");
const encoder = new TextEncoder();
const packId = "org.example.legal";
/** Exact bytes of one schema-1 manifest with a computed digest. */
function packBytes(
  version: string,
  contributions: Record<string, unknown[]>,
  id = packId,
): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Legal", description: "Descriptive vocabulary fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
    },
  };
  return encoder.encode(
    JSON.stringify({
      ...draft,
      manifestDigest: computeManifestDigest(
        parseDomainPackManifest(encoder.encode(JSON.stringify(draft))),
      ),
    }),
  );
}

function catalogOf(...artifacts: Uint8Array[]) {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const packs = artifacts.map((bytes, index) =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: `fixture-${index}`,
      },
    }),
  );
  return { catalog, packs };
}

type Operation = "replace" | "extend" | "disable";

async function harness(artifacts: Uint8Array[] = [v1Bytes, v2Bytes, v3Bytes]) {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp10b2-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const { catalog, packs } = catalogOf(...artifacts);
  await storage.projects.save(Project.create({ id: "a", name: "A", now }));
  let sequence = 0;
  const ports = (
    selected: InstalledDomainPackCatalog = catalog,
    clock = now,
  ) => ({
    projects: storage.projects,
    definitions: storage.definitions,
    bindings: storage.packBindings,
    catalog: selected,
    auditEvents: storage.auditEvents,
    transactions: storage.transactions,
    clock: { now: () => clock },
    ids: { generate: () => `audit-${++sequence}` },
  });
  // Upgrades run a day after authoring, so a rewritten entry is visible.
  const upgrade = () => new ReconcileProjectPackUpgrade(ports(catalog, later));
  const definitions = new ManageProjectDefinitions(ports());
  const revision = async () => (await storage.definitions.get("a")).revision;
  const bind = async (selection: PackIdentity[]) => {
    await storage.packBindings.replace(
      "a",
      (await storage.packBindings.get("a")).configurationRevision,
      selection,
      now,
    );
  };
  const mutate = async (mutation: unknown) =>
    definitions.apply({
      projectId: "a",
      expectedRevision: await revision(),
      actorId: "author",
      mutation,
    });
  const override = (
    pack: PackIdentity,
    localId: string,
    operation: Operation,
    payload?: object,
    kind = "workflows",
  ) =>
    mutate({
      action: "put_override",
      source: { ...pack, kind, localId },
      operation,
      ...(payload === undefined ? {} : { payload }),
    });
  const add = (kind: string, id: string, payload: object = { id }) =>
    mutate({ action: "put_owned", kind, id, enabled: true, payload });
  const audits = (eventType: string) =>
    database
      .query<{ payload_json: string; actor_id: string }, [string]>(
        "SELECT payload_json, actor_id FROM audit_event WHERE event_type = ? ORDER BY id",
      )
      .all(eventType)
      .map((row) => ({
        actorId: row.actor_id,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      }));
  const authority = async () => ({
    binding: await storage.packBindings.get("a"),
    definitions: await storage.definitions.get("a"),
    audits: database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM audit_event")
      .get()?.count,
  });
  const configuration = () =>
    new ReadProjectConfiguration({
      projects: storage.projects,
      bindings: storage.packBindings,
      definitions: storage.definitions,
      transactions: storage.transactions,
      catalog,
    }).read("a");
  return {
    database,
    storage,
    catalog,
    v1: packs[0]!,
    v2: packs[1]!,
    v3: packs[2]!,
    packs,
    upgrade,
    definitions,
    revision,
    bind,
    mutate,
    override,
    add,
    audits,
    authority,
    configuration,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const source = (pack: PackIdentity, localId: string, kind = "workflows") => ({
  ...pack,
  kind,
  localId,
});
const pid = (kind: string, localId: string) =>
  `pack:${packId}/${kind}/${localId}`;

async function conflictCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
    return (error as ProjectDefinitionConflictError).code;
  }
  throw new Error("Expected a definition conflict");
}

const applyUpgrade = (
  h: Harness,
  desired: PackIdentity[],
  planDigest: string,
  resolutions?: unknown,
) =>
  h.upgrade().apply({
    projectId: "a",
    desired,
    ...(resolutions === undefined ? {} : { resolutions }),
    approvedPlanDigest: planDigest,
    actorId: "operator",
  });

const officeManifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Preserve Runtime pipeline state",
    goals: ["Ship safely"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Office",
    roles: [
      {
        id: "architect",
        title: "Architect",
        purpose: "Design",
        responsibilities: ["Design"],
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
          capabilities: [],
        },
        {
          id: "review",
          name: "Review",
          roleId: "reviewer",
          objective: "Review",
          checks: ["Review approved"],
          requiresApproval: true,
          capabilities: [],
        },
      ],
    },
  ],
};

/** A real OfficeManifest, Runtime roles and agents and a started pipeline run. */
async function seedRuntimePipelineState(h: Harness): Promise<void> {
  const { database } = h;
  const tasks = new SqliteTaskRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  let sequence = 0;
  const ids = { generate: () => `runtime-${++sequence}` };
  const clock = { now: () => new Date(now) };
  await tasks.save(
    Task.create({ id: "task", projectId: "a", title: "Feature", now }),
  );
  await manifests.save({
    id: "manifest-1",
    projectId: "a",
    revision: 1,
    manifest: officeManifest,
    appliedAt: now,
  });
  for (const key of ["architect", "reviewer"] as const)
    await runtime.saveRole(
      Role.create({
        id: `role-${key}`,
        projectId: "a",
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
  const agent: Agent = {
    id: "architect-agent",
    projectId: "a",
    roleId: "role-architect",
    name: "Architect",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await runtime.saveAgent(agent);
  const manager = new ManagePipelineRuns(
    manifests,
    new SqlitePipelineRunRepository(database),
    tasks,
    runtime,
    new RecordAuditEvent(new SqliteAuditEventRepository(database), ids, clock),
    ids,
    clock,
    new SqliteTransactionRunner(database),
  );
  const run = await manager.start({
    projectId: "a",
    taskId: "task",
    pipelineId: "delivery",
    principal: localOperatorPrincipal,
  });
  await manager.assign({
    projectId: "a",
    pipelineRunId: run.snapshot().id,
    agentId: "architect-agent",
    principal: localOperatorPrincipal,
  });
}

/** The tables a definition change or a pack upgrade is allowed to write. */
const definitionAuthorityTables = new Set([
  "project_definition_head",
  "project_definition_override",
  "project_owned_definition",
  "project_pack_binding",
  "project_pack_binding_pack",
  "audit_event",
]);

/** Every row of every other table, as stored. */
function everythingElse(h: Harness): Record<string, string[]> {
  const tables = h.database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  for (const table of definitionAuthorityTables)
    expect(tables).toContain(table);
  return Object.fromEntries(
    tables
      .filter((table) => !definitionAuthorityTables.has(table))
      .map((table) => [
        table,
        h.database
          .query(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
  );
}

// GP-10B-2, PR 1: the descriptive vocabulary through the definition service,
// across a pack upgrade, and beside Runtime pipeline state.

// Every definition body below carries one of these markers, so a test can
// show that none reaches an audit event, a plan or an error message.
const bodyMarkers = ["§pack", "§ours"];
const pack = (text: string) => `${text} §pack`;
const ours = (text: string) => `${text} §ours`;
const withoutBodies = (value: unknown): void => {
  const text = JSON.stringify(value);
  for (const marker of bodyMarkers) expect(text).not.toContain(marker);
};

const capabilities = [{ id: "sign" }];
const v1Bytes = packBytes("1.0.0", {
  capabilities,
  roles: [
    {
      id: "counsel",
      title: "Counsel",
      capabilities: ["sign"],
      responsibilities: [pack("Advise")],
    },
    { id: "clerk" },
    { id: "paralegal", title: "Paralegal" },
    { id: "scribe", responsibilities: [pack("Record")] },
  ],
  taskTypes: [{ id: "matter" }, { id: "filing" }, { id: "appeal" }],
  prompts: [
    { id: "brief", text: pack("Write the brief.") },
    { id: "style", title: "Style" },
    { id: "tone" },
  ],
  workflows: [
    {
      id: "review",
      title: "Review",
      taskType: "matter",
      stages: [
        { id: "draft", role: "paralegal" },
        { id: "check", role: "counsel" },
      ],
    },
    {
      id: "intake",
      taskType: "filing",
      stages: [{ id: "file", role: "clerk" }],
    },
    {
      id: "archive",
      title: "Archive",
      taskType: "filing",
      additionalTaskTypes: ["appeal"],
      stages: [{ id: "store", role: "clerk" }],
    },
  ],
});
// Only the descriptive vocabulary changes, apart from the titles that turn
// three project extensions into extension conflicts: `clerk`, `tone`, `intake`.
const v2Draft = {
  id: "draft",
  role: "paralegal",
  title: pack("Draft"),
  objective: pack("Produce a draft"),
  checks: [pack("Template used"), pack("Facts cited")],
};
const v2File = {
  id: "file",
  role: "clerk",
  title: pack("File"),
  objective: pack("File the papers"),
  checks: [pack("Stamped"), pack("Copied"), pack("Stamped")],
};
const v2Bytes = packBytes("2.0.0", {
  capabilities,
  roles: [
    {
      id: "counsel",
      title: "Counsel",
      capabilities: ["sign"],
      responsibilities: [pack("Advise"), pack("Sign filings")],
    },
    { id: "clerk", title: "Clerk", responsibilities: [pack("File")] },
    { id: "paralegal", title: "Paralegal", responsibilities: [pack("Draft")] },
    { id: "scribe", responsibilities: [pack("Record")] },
  ],
  taskTypes: [{ id: "matter" }, { id: "filing" }, { id: "appeal" }],
  prompts: [
    { id: "brief", text: pack("Write the brief. Cite sources.") },
    { id: "style", title: "Style", text: pack("Plain.") },
    { id: "tone", title: "Tone", text: pack("Calm.") },
  ],
  workflows: [
    {
      id: "review",
      title: "Review",
      taskType: "matter",
      additionalTaskTypes: ["appeal"],
      stages: [v2Draft, { id: "check", role: "counsel" }],
    },
    {
      id: "intake",
      title: "Intake",
      taskType: "filing",
      // Written out of order; the manifest holds a set.
      additionalTaskTypes: ["matter", "appeal"],
      stages: [v2File],
    },
    {
      id: "archive",
      title: "Archive",
      taskType: "filing",
      additionalTaskTypes: ["appeal"],
      stages: [{ id: "store", role: "clerk" }],
    },
  ],
});
// The task type `appeal`, the role `scribe`, the prompt `brief` and the
// workflow `archive` are gone.
const v3Bytes = packBytes("3.0.0", {
  capabilities,
  roles: [
    { id: "counsel", title: "Counsel", capabilities: ["sign"] },
    { id: "clerk" },
    { id: "paralegal", title: "Paralegal" },
  ],
  taskTypes: [{ id: "matter" }, { id: "filing" }],
  prompts: [{ id: "style", title: "Style" }, { id: "tone" }],
  workflows: [
    {
      id: "review",
      title: "Review",
      taskType: "matter",
      stages: [
        { id: "draft", role: "paralegal" },
        { id: "check", role: "counsel" },
      ],
    },
    {
      id: "intake",
      taskType: "filing",
      stages: [{ id: "file", role: "clerk" }],
    },
  ],
});

const stored = async (h: Harness) => {
  const state = await h.storage.definitions.get("a");
  return {
    owned: Object.fromEntries(
      state.owned.map((item) => [`${item.kind}/${item.id}`, item.payload]),
    ),
    overrides: Object.fromEntries(
      state.overrides.map((item) => [
        `${item.source.kind}/${item.source.localId}`,
        item.payload,
      ]),
    ),
  };
};
const upgradeTo = async (
  h: Harness,
  desired: PackIdentity[],
  resolutions?: unknown[],
) => {
  const plan = await h.upgrade().preview({
    projectId: "a",
    desired,
    ...(resolutions === undefined ? {} : { resolutions }),
  });
  return plan;
};

describe("GP-10B-2 descriptive vocabulary in project definitions", () => {
  test("project-owned and replacing definitions store the new keys, with additionalTaskTypes ascending, and are audited without their bodies", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const role = {
      id: "counsel",
      title: "Our counsel",
      responsibilities: [ours("Sign"), ours("Advise"), ours("Sign")],
    };
    const prompt = { id: "brief", text: ours("Write\nour brief.") };
    const review = {
      id: "review",
      taskType: "matter",
      additionalTaskTypes: ["filing", "appeal"],
      stages: [
        {
          id: "check",
          role: "counsel",
          title: ours("Check"),
          objective: ours("Be sure"),
          checks: [ours("b"), ours("a")],
        },
        { id: "draft", role: "paralegal" },
      ],
    };
    const preview = await h.definitions.preview("a", {
      action: "put_override",
      source: source(h.v1, "review"),
      operation: "replace",
      payload: review,
    });
    expect(preview.issues).toEqual([]);
    expect((await h.authority()).definitions.revision).toBe(0);
    await h.override(h.v1, "counsel", "replace", role, "roles");
    await h.override(h.v1, "brief", "replace", prompt, "prompts");
    await h.override(h.v1, "review", "replace", review);
    await h.add("taskTypes", "errand");
    await h.add("taskTypes", "visit");
    await h.add("roles", "liaison", {
      id: "liaison",
      responsibilities: [ours("Call"), ours("Write")],
    });
    await h.add("prompts", "house", {
      id: "house",
      text: ours("House rules."),
    });
    const house = {
      id: "house",
      taskType: "errand",
      additionalTaskTypes: ["visit"],
      stages: [
        {
          id: "go",
          role: "liaison",
          objective: ours("Go"),
          checks: [ours("Back")],
        },
      ],
    };
    await h.add("workflows", "house", house);

    expect(await stored(h)).toEqual({
      owned: {
        "prompts/house": { id: "house", text: ours("House rules.") },
        "roles/liaison": {
          id: "liaison",
          responsibilities: [ours("Call"), ours("Write")],
        },
        "taskTypes/errand": { id: "errand" },
        "taskTypes/visit": { id: "visit" },
        "workflows/house": house,
      },
      overrides: {
        "prompts/brief": prompt,
        "roles/counsel": role,
        "workflows/review": {
          ...review,
          additionalTaskTypes: ["appeal", "filing"],
        },
      },
    });
    // Exactly as stored: the raw JSON keeps list order.
    expect(
      h.database
        .query<{ payload_json: string }, []>(
          "SELECT payload_json FROM project_definition_override WHERE kind = 'roles'",
        )
        .get()?.payload_json,
    ).toBe(JSON.stringify(role));

    const view = await h.configuration();
    expect(view.roles.find((item) => item.title === "Our counsel")).toEqual({
      roleId: pid("roles", "counsel"),
      effectiveId: expect.any(String) as unknown,
      origin: "pack_owned",
      title: "Our counsel",
      responsibilities: role.responsibilities,
      // The capability set stays the pack's.
      capabilities: [pid("capabilities", "sign")],
      customization: "replace",
    });
    expect(
      view.workflows.find(
        (item) => item.workflowId === pid("workflows", "review"),
      ),
    ).toMatchObject({
      taskTypeId: pid("taskTypes", "matter"),
      additionalTaskTypeIds: [
        pid("taskTypes", "appeal"),
        pid("taskTypes", "filing"),
      ],
      stages: [
        {
          id: "check",
          roleId: pid("roles", "counsel"),
          title: ours("Check"),
          objective: ours("Be sure"),
          checks: [ours("b"), ours("a")],
        },
        { id: "draft", roleId: pid("roles", "paralegal") },
      ],
      customization: "replace",
    });
    expect(
      view.workflows.find(
        (item) => item.workflowId === "project:workflows/house",
      ),
    ).toMatchObject({
      additionalTaskTypeIds: ["project:taskTypes/visit"],
      stages: [
        {
          id: "go",
          roleId: "project:roles/liaison",
          objective: ours("Go"),
          checks: [ours("Back")],
        },
      ],
    });

    // Eight changes, eight events; identities and revisions only.
    const events = h.audits("project.definition_changed");
    expect(events).toHaveLength(8);
    withoutBodies(events);
    for (const event of events)
      expect(Object.keys(event.payload).sort()).toEqual([
        "action",
        "identity",
        "newEntryRevision",
        "newRevision",
        "operation",
        "origin",
        "previousEntryRevision",
        "previousRevision",
      ]);
  });

  test("an additional task type the source does not declare is reported before anything is stored", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.add("taskTypes", "errand");
    const before = await h.authority();
    const mutation = {
      action: "put_override",
      source: source(h.v1, "review"),
      operation: "replace",
      payload: {
        id: "review",
        taskType: "matter",
        // `errand` is a project task type, outside the pack namespace.
        additionalTaskTypes: ["ghost", "errand", "appeal"],
        stages: [],
      },
    };
    expect((await h.definitions.preview("a", mutation)).issues).toEqual([
      {
        code: "source_definition_missing",
        message:
          "Workflow workflows/review references taskTypes/errand, which is missing from exact source",
      },
      {
        code: "source_definition_missing",
        message:
          "Workflow workflows/review references taskTypes/ghost, which is missing from exact source",
      },
    ]);
    expect(await conflictCode(h.mutate(mutation))).toBe(
      "source_definition_missing",
    );
    expect(await h.authority()).toEqual(before);
  });

  test("refused mutations carry the contract's code, quote no value and write nothing", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const before = await h.authority();
    const long = "x".repeat(16_001);
    const cases: [string, string, string, object, string][] = [
      // A new key on the wrong kind.
      [
        "roles",
        "counsel",
        "replace",
        { id: "counsel", text: ours("x") },
        "protected_security_invariant",
      ],
      [
        "prompts",
        "brief",
        "replace",
        { id: "brief", responsibilities: [ours("x")] },
        "protected_security_invariant",
      ],
      [
        "workflows",
        "review",
        "replace",
        { id: "review", taskType: "matter", stages: [], text: ours("x") },
        "protected_security_invariant",
      ],
      // A new key in an extension.
      [
        "roles",
        "clerk",
        "extend",
        { responsibilities: [ours("x")] },
        "protected_security_invariant",
      ],
      [
        "prompts",
        "tone",
        "extend",
        { title: "Tone", text: ours("x") },
        "protected_security_invariant",
      ],
      [
        "workflows",
        "intake",
        "extend",
        { additionalTaskTypes: ["matter"] },
        "protected_security_invariant",
      ],
      // A role payload cannot carry capabilities.
      [
        "roles",
        "counsel",
        "replace",
        {
          id: "counsel",
          responsibilities: [ours("x")],
          capabilities: ["sign"],
        },
        "protected_security_invariant",
      ],
      // Text outside the project rule.
      [
        "prompts",
        "brief",
        "replace",
        { id: "brief", text: long },
        "malformed_origin_reference",
      ],
      [
        "prompts",
        "brief",
        "replace",
        { id: "brief", text: ours("a\u0000b") },
        "malformed_origin_reference",
      ],
      [
        "prompts",
        "brief",
        "replace",
        { id: "brief", text: `${ours("a")}\ud800` },
        "malformed_origin_reference",
      ],
      [
        "prompts",
        "brief",
        "replace",
        { id: "brief", text: "" },
        "malformed_origin_reference",
      ],
      [
        "roles",
        "counsel",
        "replace",
        { id: "counsel", responsibilities: [ours("x"), long] },
        "malformed_origin_reference",
      ],
      // Lists outside their bound.
      [
        "roles",
        "counsel",
        "replace",
        {
          id: "counsel",
          responsibilities: Array.from({ length: 65 }, () => ours("x")),
        },
        "malformed_origin_reference",
      ],
      [
        "roles",
        "counsel",
        "replace",
        { id: "counsel", responsibilities: [] },
        "malformed_origin_reference",
      ],
      [
        "workflows",
        "review",
        "replace",
        {
          id: "review",
          taskType: "matter",
          stages: [
            {
              id: "check",
              role: "counsel",
              checks: Array.from({ length: 65 }, () => ours("x")),
            },
          ],
        },
        "malformed_origin_reference",
      ],
      // The route set.
      [
        "workflows",
        "review",
        "replace",
        {
          id: "review",
          taskType: "matter",
          additionalTaskTypes: ["matter"],
          stages: [],
        },
        "conflicting_ownership_metadata",
      ],
      [
        "workflows",
        "review",
        "replace",
        {
          id: "review",
          taskType: "matter",
          additionalTaskTypes: ["appeal", "appeal"],
          stages: [],
        },
        "conflicting_ownership_metadata",
      ],
    ];
    for (const [kind, localId, operation, payload, code] of cases) {
      let caught: unknown;
      try {
        await h.override(h.v1, localId, operation as Operation, payload, kind);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(payload).slice(0, 120)).toBeInstanceOf(
        ProjectDefinitionConflictError,
      );
      const error = caught as ProjectDefinitionConflictError;
      expect(error.code, JSON.stringify(payload).slice(0, 120)).toBe(code);
      withoutBodies(error.message);
      expect(error.message.length).toBeLessThan(200);
    }
    // The same rules hold for a project-owned definition.
    for (const [kind, payload, code] of [
      ["roles", { id: "own", text: ours("x") }, "protected_security_invariant"],
      [
        "roles",
        { id: "own", capabilities: ["sign"] },
        "protected_security_invariant",
      ],
      [
        "taskTypes",
        { id: "own", responsibilities: [ours("x")] },
        "protected_security_invariant",
      ],
      ["prompts", { id: "own", text: long }, "malformed_origin_reference"],
      [
        "workflows",
        { id: "own", taskType: "t", additionalTaskTypes: ["t"], stages: [] },
        "conflicting_ownership_metadata",
      ],
    ] as const)
      expect(await conflictCode(h.add(kind, "own", payload))).toBe(code);
    expect(await h.authority()).toEqual(before);
  });
});

describe("GP-10B-2 descriptive vocabulary across a pack upgrade", () => {
  test("an uncustomized definition takes the new version's fields, reported as template changes", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const plan = await upgradeTo(h, [h.v2]);
    expect(plan.issues).toEqual([]);
    expect(plan.templates).toEqual({
      availability: "available",
      changes: [
        ["prompts", "brief"],
        ["prompts", "style"],
        ["prompts", "tone"],
        ["roles", "clerk"],
        ["roles", "counsel"],
        ["roles", "paralegal"],
        ["workflows", "intake"],
        ["workflows", "review"],
      ].map(([kind, localId]) => ({
        packId,
        kind,
        localId,
        change: "changed",
        customized: false,
      })),
    });
    withoutBodies(plan);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    const view = await h.configuration();
    expect(view.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    expect(
      view.roles.find((item) => item.roleId === pid("roles", "counsel")),
    ).toMatchObject({
      responsibilities: [pack("Advise"), pack("Sign filings")],
    });
    expect(
      view.workflows.find(
        (item) => item.workflowId === pid("workflows", "intake"),
      ),
    ).toMatchObject({
      additionalTaskTypeIds: [
        pid("taskTypes", "appeal"),
        pid("taskTypes", "matter"),
      ],
      stages: [
        {
          id: "file",
          roleId: pid("roles", "clerk"),
          title: pack("File"),
          objective: pack("File the papers"),
          checks: [pack("Stamped"), pack("Copied"), pack("Stamped")],
        },
      ],
    });
    expect(
      view.effectiveDefinitions.prompts.map((item) => item.payload),
    ).toEqual([
      { id: "brief", text: pack("Write the brief. Cite sources.") },
      { id: "style", title: "Style", text: pack("Plain.") },
      { id: "tone", title: "Tone", text: pack("Calm.") },
    ]);
  });

  test("a replacement wins whole when upstream gains or changes a field, and no project value is dropped or rewritten", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // Without the fields, and with them.
    await h.override(
      h.v1,
      "counsel",
      "replace",
      { id: "counsel", title: "Our counsel" },
      "roles",
    );
    await h.override(
      h.v1,
      "paralegal",
      "replace",
      { id: "paralegal", responsibilities: [ours("Draft"), ours("Check")] },
      "roles",
    );
    await h.override(
      h.v1,
      "brief",
      "replace",
      { id: "brief", text: ours("Ours.") },
      "prompts",
    );
    await h.override(
      h.v1,
      "style",
      "replace",
      { id: "style", title: "Our style" },
      "prompts",
    );
    await h.override(h.v1, "review", "replace", {
      id: "review",
      taskType: "matter",
      additionalTaskTypes: ["filing"],
      stages: [
        { id: "draft", role: "paralegal", checks: [ours("z"), ours("a")] },
      ],
    });
    await h.override(h.v1, "intake", "replace", {
      id: "intake",
      taskType: "filing",
      stages: [{ id: "file", role: "clerk" }],
    });
    await h.add("roles", "liaison", {
      id: "liaison",
      responsibilities: [ours("Call")],
    });
    await h.add("prompts", "house", {
      id: "house",
      text: ours("House rules."),
    });
    const before = await stored(h);

    const plan = await upgradeTo(h, [h.v2]);
    expect(plan.issues).toEqual([]);
    expect(
      plan.overrides.map((item) => [
        item.source.kind,
        item.source.localId,
        item.outcome,
        item.upstream,
      ]),
    ).toEqual([
      ["prompts", "brief", "retargeted", "changed"],
      ["prompts", "style", "retargeted", "changed"],
      ["roles", "counsel", "retargeted", "changed"],
      ["roles", "paralegal", "retargeted", "changed"],
      ["workflows", "intake", "retargeted", "changed"],
      ["workflows", "review", "retargeted", "changed"],
    ]);
    withoutBodies(plan);
    await applyUpgrade(h, [h.v2], plan.planDigest);

    // Every payload is exactly what the project stored.
    expect(await stored(h)).toEqual(before);
    const state = await h.storage.definitions.get("a");
    expect(state.overrides.map((item) => item.source.version)).toEqual(
      state.overrides.map(() => "2.0.0"),
    );
    expect(state.overrides.map((item) => item.revision)).toEqual(
      state.overrides.map(() => 1),
    );
    const view = await h.configuration();
    expect(view.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    // A replacement without the field stays without it.
    const counsel = view.roles.find(
      (item) => item.roleId === pid("roles", "counsel"),
    )!;
    expect(Object.hasOwn(counsel, "responsibilities")).toBe(false);
    expect(counsel.capabilities).toEqual([pid("capabilities", "sign")]);
    expect(
      view.effectiveDefinitions.prompts.map((item) => item.payload),
    ).toEqual([
      { id: "brief", text: ours("Ours.") },
      { id: "style", title: "Our style" },
      { id: "tone", title: "Tone", text: pack("Calm.") },
      { id: "house", text: ours("House rules.") },
    ]);
    const intake = view.workflows.find(
      (item) => item.workflowId === pid("workflows", "intake"),
    )!;
    expect(Object.hasOwn(intake, "additionalTaskTypeIds")).toBe(false);
    expect(intake.stages).toEqual([
      { id: "file", roleId: pid("roles", "clerk") },
    ]);
    // A replacement with the field keeps its own value.
    expect(
      view.roles.find((item) => item.roleId === pid("roles", "paralegal")),
    ).toMatchObject({ responsibilities: [ours("Draft"), ours("Check")] });
    expect(
      view.workflows.find(
        (item) => item.workflowId === pid("workflows", "review"),
      ),
    ).toMatchObject({
      additionalTaskTypeIds: [pid("taskTypes", "filing")],
      stages: [
        {
          id: "draft",
          roleId: pid("roles", "paralegal"),
          checks: [ours("z"), ours("a")],
        },
      ],
    });
  });

  test("an extension follows the upgrade and takes the new version's fields; it is never an extension conflict", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(
      h.v1,
      "paralegal",
      "extend",
      { description: ours("Ours") },
      "roles",
    );
    await h.override(
      h.v1,
      "style",
      "extend",
      { description: ours("Ours") },
      "prompts",
    );
    await h.override(h.v1, "review", "extend", { description: ours("Ours") });
    const before = await stored(h);
    const plan = await upgradeTo(h, [h.v2]);
    expect(plan.issues).toEqual([]);
    expect(
      plan.overrides.map((item) => [
        item.source.kind,
        item.outcome,
        item.upstream,
      ]),
    ).toEqual([
      ["prompts", "retargeted", "changed"],
      ["roles", "retargeted", "changed"],
      ["workflows", "retargeted", "changed"],
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect(await stored(h)).toEqual(before);
    const view = await h.configuration();
    expect(
      view.roles.find((item) => item.roleId === pid("roles", "paralegal")),
    ).toMatchObject({
      description: ours("Ours"),
      responsibilities: [pack("Draft")],
      customization: "extend",
    });
    expect(view.effectiveDefinitions.prompts[1]?.payload).toEqual({
      id: "style",
      title: "Style",
      description: ours("Ours"),
      text: pack("Plain."),
    });
    expect(
      view.workflows.find(
        (item) => item.workflowId === pid("workflows", "review"),
      ),
    ).toMatchObject({
      description: ours("Ours"),
      additionalTaskTypeIds: [pid("taskTypes", "appeal")],
      stages: [
        {
          id: "draft",
          roleId: pid("roles", "paralegal"),
          title: pack("Draft"),
          objective: pack("Produce a draft"),
          checks: [pack("Template used"), pack("Facts cited")],
        },
        { id: "check", roleId: pid("roles", "counsel") },
      ],
      customization: "extend",
    });
  });

  test("convert_to_replace copies the new template's descriptive fields; plan and audit carry no body", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(
      h.v1,
      "clerk",
      "extend",
      { title: ours("Our clerk") },
      "roles",
    );
    await h.override(
      h.v1,
      "tone",
      "extend",
      { title: ours("Our tone") },
      "prompts",
    );
    await h.override(h.v1, "intake", "extend", {
      title: ours("Our intake"),
      description: ours("Front desk"),
    });
    const blocked = await upgradeTo(h, [h.v2]);
    expect(blocked.issues.map((item) => [item.code, item.detail])).toEqual([
      ["unresolved_override_conflict", "extend_conflict"],
      ["unresolved_override_conflict", "extend_conflict"],
      ["unresolved_override_conflict", "extend_conflict"],
    ]);
    const resolutions = [
      { source: source(h.v1, "clerk", "roles"), action: "convert_to_replace" },
      { source: source(h.v1, "tone", "prompts"), action: "convert_to_replace" },
      { source: source(h.v1, "intake"), action: "convert_to_replace" },
    ];
    const plan = await upgradeTo(h, [h.v2], resolutions);
    expect(plan.issues).toEqual([]);
    expect(plan.overrides.map((item) => item.outcome)).toEqual([
      "converted_to_replace",
      "converted_to_replace",
      "converted_to_replace",
    ]);
    withoutBodies(plan);
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);

    // The project's fields win; every other field is the new template's.
    expect((await stored(h)).overrides).toEqual({
      "prompts/tone": {
        id: "tone",
        title: ours("Our tone"),
        text: pack("Calm."),
      },
      "roles/clerk": {
        id: "clerk",
        title: ours("Our clerk"),
        responsibilities: [pack("File")],
      },
      "workflows/intake": {
        id: "intake",
        title: ours("Our intake"),
        description: ours("Front desk"),
        taskType: "filing",
        additionalTaskTypes: ["appeal", "matter"],
        stages: [v2File],
      },
    });
    const state = await h.storage.definitions.get("a");
    expect(state.overrides.map((item) => item.operation)).toEqual([
      "replace",
      "replace",
      "replace",
    ]);
    const view = await h.configuration();
    expect(view.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    expect(
      view.workflows.find(
        (item) => item.workflowId === pid("workflows", "intake"),
      ),
    ).toMatchObject({
      title: ours("Our intake"),
      additionalTaskTypeIds: [
        pid("taskTypes", "appeal"),
        pid("taskTypes", "matter"),
      ],
      stages: [
        {
          id: "file",
          roleId: pid("roles", "clerk"),
          title: pack("File"),
          objective: pack("File the papers"),
          checks: [pack("Stamped"), pack("Copied"), pack("Stamped")],
        },
      ],
      customization: "replace",
    });
    // The upgrade event names identities and outcomes only.
    const events = h.audits("project.pack_upgrade_applied");
    expect(events).toHaveLength(1);
    withoutBodies(events);
    withoutBodies(h.audits("project.definition_changed"));
  });

  test("convert_to_replace blocks when the template's text does not fit the project rule", async () => {
    const base = {
      roles: [{ id: "counsel" }],
      taskTypes: [{ id: "matter" }],
    };
    const variants: [
      string,
      Record<string, unknown[]>,
      Record<string, unknown[]>,
    ][] = [
      [
        "prompts",
        { prompts: [{ id: "item" }] },
        { prompts: [{ id: "item", title: "T", text: "x".repeat(16_001) }] },
      ],
      [
        "prompts",
        { prompts: [{ id: "item" }] },
        { prompts: [{ id: "item", title: "T", text: "a\u0000b" }] },
      ],
      [
        "roles",
        { roles: [{ id: "item" }] },
        {
          roles: [
            { id: "item", title: "T", responsibilities: ["x".repeat(16_001)] },
          ],
        },
      ],
      [
        "workflows",
        { workflows: [{ id: "item", taskType: "matter", stages: [] }] },
        {
          workflows: [
            {
              id: "item",
              title: "T",
              taskType: "matter",
              // An empty stage title is manifest text, not project text.
              stages: [{ id: "check", role: "counsel", title: "" }],
            },
          ],
        },
      ],
      [
        "workflows",
        { workflows: [{ id: "item", taskType: "matter", stages: [] }] },
        {
          workflows: [
            {
              id: "item",
              title: "T",
              taskType: "matter",
              stages: [{ id: "check", role: "counsel", objective: "a\u0000b" }],
            },
          ],
        },
      ],
    ];
    for (const [kind, first, second] of variants) {
      const h = await harness([
        packBytes("1.0.0", { ...base, ...first }),
        packBytes("2.0.0", { ...base, ...second }),
      ]);
      await h.bind([h.v1]);
      await h.override(h.v1, "item", "extend", { title: "Ours" }, kind);
      const before = await h.authority();
      const resolutions = [
        { source: source(h.v1, "item", kind), action: "convert_to_replace" },
      ];
      const plan = await upgradeTo(h, [h.v2], resolutions);
      expect(
        plan.issues.map((item) => [item.code, item.detail]),
        JSON.stringify(second).slice(0, 100),
      ).toEqual([["prospective_configuration_invalid", "unresolved_override"]]);
      // The message names the field that failed, never its body.
      const message = plan.issues[0]?.message ?? "";
      expect(message, kind).toMatch(
        /override contract: malformed_origin_reference: .*(text|responsibilities|title|objective)/,
      );
      expect(message).not.toContain("xxxx");
      expect(message).not.toContain("a\u0000b");
      expect(plan.prospectiveConfigurationDigest).toBeUndefined();
      await expect(
        applyUpgrade(h, [h.v2], plan.planDigest, resolutions),
      ).rejects.toMatchObject({ code: "upgrade_blocked" });
      expect(await h.authority()).toEqual(before);
    }
  });

  test("retain_as_project_owned keeps a role's responsibilities and a prompt's text, and still refuses a workflow", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const scribe = {
      id: "scribe",
      title: "Our scribe",
      responsibilities: [ours("Record"), ours("Index")],
    };
    const brief = { id: "brief", text: ours("Our brief.") };
    await h.override(h.v1, "scribe", "replace", scribe, "roles");
    await h.override(h.v1, "brief", "replace", brief, "prompts");
    const retained = [
      {
        source: source(h.v1, "brief", "prompts"),
        action: "retain_as_project_owned",
      },
      {
        source: source(h.v1, "scribe", "roles"),
        action: "retain_as_project_owned",
      },
    ];
    const plan = await upgradeTo(h, [h.v3], retained);
    expect(plan.issues).toEqual([]);
    expect(plan.overrides.map((item) => item.outcome)).toEqual([
      "retained_as_project_owned",
      "retained_as_project_owned",
    ]);
    withoutBodies(plan);
    await applyUpgrade(h, [h.v3], plan.planDigest, retained);
    expect(await stored(h)).toEqual({
      owned: { "prompts/brief": brief, "roles/scribe": scribe },
      overrides: {},
    });
    const view = await h.configuration();
    expect(
      view.roles.find((item) => item.roleId === "project:roles/scribe"),
    ).toMatchObject({
      origin: "project_owned",
      responsibilities: [ours("Record"), ours("Index")],
    });
    withoutBodies(h.audits("project.pack_upgrade_applied"));

    // A workflow replacement with the new fields is still not retained.
    const other = await harness();
    await other.bind([other.v1]);
    await other.override(other.v1, "archive", "replace", {
      id: "archive",
      taskType: "filing",
      stages: [{ id: "store", role: "clerk", objective: ours("Keep") }],
    });
    const before = await other.authority();
    const refused = await upgradeTo(
      other,
      [other.v3],
      [
        {
          source: source(other.v1, "archive"),
          action: "retain_as_project_owned",
        },
      ],
    );
    expect(refused.issues.map((item) => [item.code, item.detail])).toEqual([
      ["invalid_resolution", "source_definition_removed"],
    ]);
    withoutBodies(refused);
    expect(await other.authority()).toEqual(before);
  });

  test("a replacement whose additional task type is gone in the new version blocks", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "review", "replace", {
      id: "review",
      taskType: "matter",
      additionalTaskTypes: ["appeal"],
      stages: [{ id: "check", role: "counsel" }],
    });
    const before = await h.authority();
    const plan = await upgradeTo(h, [h.v3]);
    expect(plan.issues.map((item) => [item.code, item.detail])).toEqual([
      ["prospective_configuration_invalid", "missing_workflow_reference"],
    ]);
    await expect(
      applyUpgrade(h, [h.v3], plan.planDigest),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    expect(await h.authority()).toEqual(before);
    // The project resolves it explicitly: drop the route, then upgrade.
    await h.mutate({
      action: "put_override",
      source: source(h.v1, "review"),
      operation: "replace",
      expectedEntryRevision: 1,
      payload: {
        id: "review",
        taskType: "matter",
        stages: [{ id: "check", role: "counsel" }],
      },
    });
    const next = await upgradeTo(h, [h.v3]);
    expect(next.issues).toEqual([]);
  });
});

describe("GP-10B-2 preserves Runtime state", () => {
  test("definitions with the new keys and an upgrade that converts one leave every Runtime table byte-identical", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await seedRuntimePipelineState(h);
    const before = everythingElse(h);
    for (const table of [
      "office_manifest_revision",
      "pipeline_run",
      "pipeline_stage_run",
      "role",
      "agent",
      "task",
      "project",
    ])
      expect(before[table]?.length, table).toBeGreaterThan(0);
    const manifests = () =>
      h.database.query("SELECT * FROM office_manifest_revision").all();
    const manifestsBefore = JSON.stringify(manifests());

    await h.override(
      h.v1,
      "counsel",
      "replace",
      { id: "counsel", responsibilities: [ours("Sign")] },
      "roles",
    );
    await h.override(
      h.v1,
      "brief",
      "replace",
      { id: "brief", text: ours("Ours.") },
      "prompts",
    );
    await h.override(h.v1, "review", "replace", {
      id: "review",
      taskType: "matter",
      additionalTaskTypes: ["appeal"],
      stages: [{ id: "check", role: "counsel", objective: ours("Be sure") }],
    });
    await h.override(
      h.v1,
      "tone",
      "extend",
      { title: ours("Our tone") },
      "prompts",
    );
    await h.add("prompts", "house", {
      id: "house",
      text: ours("House rules."),
    });
    expect(everythingElse(h)).toEqual(before);
    await h.configuration();
    const resolutions = [
      { source: source(h.v1, "tone", "prompts"), action: "convert_to_replace" },
    ];
    const plan = await upgradeTo(h, [h.v2], resolutions);
    expect(plan.issues).toEqual([]);
    expect(everythingElse(h)).toEqual(before);
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);
    await h.configuration();

    expect(everythingElse(h)).toEqual(before);
    expect(JSON.stringify(manifests())).toBe(manifestsBefore);
    // No Runtime role or agent came from a pack role or prompt.
    expect(
      h.database
        .query<{ key: string }, []>(
          "SELECT role_key AS key FROM role ORDER BY role_key",
        )
        .all()
        .map((row) => row.key),
    ).toEqual(["architect", "reviewer"]);
    expect(plan.activePins).toEqual({
      availability: "unavailable",
      reason: "pack_configuration_run_pins_not_modelled",
    });
  });
});

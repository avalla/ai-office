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
import { ProjectConfigurationResolutionError } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
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
    metadata: { name: "Legal", description: "Workflow template fixture" },
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

const roles = [
  { id: "counsel", title: "Counsel" },
  { id: "clerk" },
  { id: "paralegal" },
  { id: "auditor" },
];
const taskTypes = [{ id: "matter" }, { id: "filing" }];
// `clerk` is used by `intake` only, and `auditor` by `audit` only.
const v1Workflows = [
  {
    id: "review",
    title: "Review",
    taskType: "matter",
    stages: [
      { id: "draft", role: "paralegal" },
      { id: "check", role: "counsel" },
    ],
  },
  { id: "intake", taskType: "filing", stages: [{ id: "file", role: "clerk" }] },
  {
    id: "audit",
    taskType: "matter",
    stages: [{ id: "inspect", role: "auditor" }],
  },
  {
    id: "archive",
    title: "Archive",
    taskType: "filing",
    stages: [{ id: "store", role: "paralegal" }],
  },
];
const v1Bytes = packBytes("1.0.0", {
  roles,
  taskTypes,
  workflows: v1Workflows,
});
// The review is renamed and gains a stage; the intake gets the title a project
// extension would supply and a second stage; the audit gets a description and
// a stage; the archive is removed; an escalation that names `auditor` is added.
const v2Workflows = [
  {
    id: "review",
    title: "Matter review",
    taskType: "matter",
    stages: [
      { id: "draft", role: "paralegal" },
      { id: "check", role: "counsel" },
      { id: "sign", role: "counsel" },
    ],
  },
  {
    id: "intake",
    title: "Intake",
    taskType: "filing",
    stages: [
      { id: "stamp", role: "paralegal" },
      { id: "file", role: "clerk" },
    ],
  },
  {
    id: "audit",
    description: "Yearly",
    taskType: "matter",
    stages: [
      { id: "inspect", role: "auditor" },
      { id: "report", role: "counsel" },
    ],
  },
  {
    id: "escalation",
    taskType: "matter",
    stages: [{ id: "decide", role: "auditor" }],
  },
];
const v2Bytes = packBytes("2.0.0", {
  roles,
  taskTypes,
  workflows: v2Workflows,
});
// The role `auditor` and the task type `filing` are gone.
const v3Bytes = packBytes("3.0.0", {
  roles: roles.filter((role) => role.id !== "auditor"),
  taskTypes: [{ id: "matter" }],
  workflows: [
    v1Workflows[0]!,
    {
      id: "intake",
      taskType: "matter",
      stages: [{ id: "file", role: "clerk" }],
    },
    {
      id: "audit",
      taskType: "matter",
      stages: [{ id: "inspect", role: "counsel" }],
    },
    {
      id: "archive",
      title: "Archive",
      taskType: "matter",
      stages: [{ id: "store", role: "paralegal" }],
    },
  ],
});

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

async function harness(artifacts = [v1Bytes, v2Bytes, v3Bytes]) {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp13-"));
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
const workflowId = (localId: string) => pid("workflows", localId);
const stage = (id: string, role: string) => ({
  id,
  roleId: pid("roles", role),
});
const workflowOf = (
  view: Awaited<ReturnType<Harness["configuration"]>>,
  id: string,
) => view.workflows.find((item) => item.workflowId === id);

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

// Reordered, one stage added and one role changed; IDs out of any sort order.
const ourReview = {
  id: "review",
  title: "Our review",
  taskType: "filing",
  stages: [
    { id: "check", role: "counsel" },
    { id: "second-opinion", role: "auditor" },
    { id: "draft", role: "clerk" },
  ],
};

describe("GP-13 workflow customization in project definitions", () => {
  test("replacing a pack workflow is previewed, stored in the given stage order and audited without its body", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const mutation = {
      action: "put_override",
      source: source(h.v1, "review"),
      operation: "replace",
      payload: ourReview,
    };
    const preview = await h.definitions.preview("a", mutation);
    expect(preview.issues).toEqual([]);
    expect(preview.ownershipTransition).toBe("absent -> project_override");
    expect(await h.revision()).toBe(0);

    const state = await h.mutate(mutation);

    expect(state.overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v1, "review"),
        operation: "replace",
        revision: 1,
        payload: ourReview,
        actorId: "author",
        changedAt: now.toISOString(),
      },
    ]);
    // Read back from SQLite in the order given, not sorted.
    const stored = await h.storage.definitions.get("a");
    expect(stored).toEqual(state);
    expect(
      (stored.overrides[0]?.payload as { stages: { id: string }[] }).stages.map(
        (item) => item.id,
      ),
    ).toEqual(["check", "second-opinion", "draft"]);
    const audit = h.audits("project.definition_changed");
    expect(audit).toEqual([
      {
        actorId: "author",
        payload: {
          action: "put_override",
          origin: "project_override",
          identity: source(h.v1, "review"),
          operation: "replace",
          previousRevision: 0,
          newRevision: 1,
          previousEntryRevision: null,
          newEntryRevision: 1,
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("Our review");
    expect(JSON.stringify(audit)).not.toContain("second-opinion");
    expect(workflowOf(await h.configuration(), workflowId("review"))).toEqual({
      workflowId: workflowId("review"),
      effectiveId: `pack:${packId}@1.0.0#${h.v1.manifestDigest}/workflows/review`,
      origin: "pack_owned",
      title: "Our review",
      taskTypeId: pid("taskTypes", "filing"),
      stages: [
        stage("check", "counsel"),
        stage("second-opinion", "auditor"),
        stage("draft", "clerk"),
      ],
      customization: "replace",
    });

    // Revising the replacement needs the entry revision and keeps the slot.
    const revised = await h.mutate({
      ...mutation,
      payload: { ...ourReview, stages: [...ourReview.stages].reverse() },
      expectedEntryRevision: 1,
    });
    expect(revised.overrides[0]).toMatchObject({ revision: 2 });
    expect(
      workflowOf(await h.configuration(), workflowId("review"))?.stages.map(
        (item) => item.id,
      ),
    ).toEqual(["draft", "second-opinion", "check"]);
  });

  test("a task type or stage role the source does not declare is reported before anything is stored", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.add("roles", "liaison");
    await h.add("taskTypes", "errand");
    const before = await h.authority();
    const cases: [object, string[]][] = [
      [{ taskType: "ghost" }, ["taskTypes/ghost"]],
      [{ stages: [{ id: "check", role: "partner" }] }, ["roles/partner"]],
      // Project-owned definitions are outside the pack's namespace.
      [{ stages: [{ id: "check", role: "liaison" }] }, ["roles/liaison"]],
      [{ taskType: "errand" }, ["taskTypes/errand"]],
      // Every missing reference is reported, in envelope order.
      [
        {
          taskType: "ghost",
          stages: [
            { id: "one", role: "partner" },
            { id: "two", role: "counsel" },
            { id: "three", role: "associate" },
          ],
        },
        ["taskTypes/ghost", "roles/partner", "roles/associate"],
      ],
    ];
    for (const [fields, subjects] of cases) {
      const mutation = {
        action: "put_override",
        source: source(h.v1, "review"),
        operation: "replace",
        payload: {
          id: "review",
          taskType: "matter",
          stages: [{ id: "check", role: "counsel" }],
          ...fields,
        },
      };
      const preview = await h.definitions.preview("a", mutation);
      expect(
        preview.issues.map((issue) => issue.code),
        subjects.join(),
      ).toEqual(subjects.map(() => "source_definition_missing"));
      for (const [index, subject] of subjects.entries())
        expect(preview.issues[index]?.message).toContain(subject);
      expect(await conflictCode(h.mutate(mutation)), subjects.join()).toBe(
        "source_definition_missing",
      );
    }
    // A workflow the selected version does not provide cannot be overridden.
    expect(await conflictCode(h.override(h.v1, "escalation", "disable"))).toBe(
      "source_definition_missing",
    );
    expect(await h.authority()).toEqual(before);
  });

  test("project:definition:show reports a stored replacement whose reference is missing", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // Written past the preview, as a restore would write it.
    await h.storage.definitions.replace(
      {
        projectId: "a",
        revision: 0,
        owned: [],
        overrides: [
          {
            origin: "project_override",
            source: { ...h.v1, kind: "workflows", localId: "review" },
            operation: "replace",
            revision: 1,
            payload: {
              id: "review",
              taskType: "matter",
              stages: [{ id: "check", role: "partner" }],
            },
            actorId: "restore",
            changedAt: now.toISOString(),
          },
        ],
      },
      0,
      now,
    );
    const inspected = await h.definitions.inspect("a");
    expect(inspected.issues).toEqual([
      {
        code: "source_definition_missing",
        message: expect.stringContaining("roles/partner") as unknown,
        source: source(h.v1, "review"),
      },
    ]);
    // The resolver is the authority and fails closed on the same state.
    await expect(h.configuration()).rejects.toMatchObject({
      code: "missing_workflow_reference",
    });
  });

  test("the mutation contract refuses malformed and out-of-scope workflow overrides; nothing is written", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const before = await h.authority();
    const replace = (fields: object) =>
      h.override(h.v1, "review", "replace", {
        id: "review",
        taskType: "matter",
        stages: [{ id: "check", role: "counsel" }],
        ...fields,
      });

    expect(
      await conflictCode(
        h.override(h.v1, "review", "replace", { id: "review", title: "Ours" }),
      ),
    ).toBe("protected_security_invariant");
    expect(await conflictCode(replace({ approvals: ["counsel"] }))).toBe(
      "protected_security_invariant",
    );
    expect(await conflictCode(replace({ taskType: "no id" }))).toBe(
      "malformed_origin_reference",
    );
    expect(
      await conflictCode(
        replace({
          stages: [
            { id: "check", role: "counsel" },
            { id: "check", role: "paralegal" },
          ],
        }),
      ),
    ).toBe("conflicting_ownership_metadata");
    expect(
      await conflictCode(
        replace({
          stages: Array.from({ length: 1_001 }, (_, index) => ({
            id: `s${index}`,
            role: "counsel",
          })),
        }),
      ),
    ).toBe("malformed_origin_reference");
    expect(
      await conflictCode(
        replace({ stages: [{ id: "check", role: "counsel", guard: "x" }] }),
      ),
    ).toBe("malformed_origin_reference");
    expect(
      await conflictCode(
        h.override(h.v1, "audit", "extend", {
          title: "Audit",
          stages: [],
        }),
      ),
    ).toBe("protected_security_invariant");
    expect(
      await conflictCode(
        h.override(h.v1, "review", "disable", { id: "review" }),
      ),
    ).toBe("malformed_origin_reference");
    // An extension cannot replace a field the source sets.
    expect(
      await conflictCode(
        h.override(h.v1, "review", "extend", { title: "Ours" }),
      ),
    ).toBe("protected_security_invariant");
    // Kinds without an override contract stay unsupported.
    for (const kind of ["policies", "capabilities", "validators"])
      for (const operation of ["replace", "extend", "disable"] as const)
        expect(
          await conflictCode(
            h.override(
              h.v1,
              "any",
              operation,
              operation === "disable"
                ? undefined
                : operation === "replace"
                  ? { id: "any" }
                  : { title: "Any" },
              kind,
            ),
          ),
          `${operation} ${kind}`,
        ).toBe("unsupported_override_operation");
    expect(await h.authority()).toEqual(before);
    expect(before.definitions.revision).toBe(0);
  });

  test("extending and disabling a pack workflow are stored and audited, and removing the override restores it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const extended = await h.override(h.v1, "audit", "extend", {
      title: "Our audit",
    });
    expect(extended.overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v1, "audit"),
        operation: "extend",
        revision: 1,
        payload: { title: "Our audit" },
        actorId: "author",
        changedAt: now.toISOString(),
      },
    ]);
    expect(
      workflowOf(await h.configuration(), workflowId("audit")),
    ).toMatchObject({
      title: "Our audit",
      taskTypeId: pid("taskTypes", "matter"),
      stages: [stage("inspect", "auditor")],
      customization: "extend",
    });

    const mutation = {
      action: "put_override",
      source: source(h.v1, "intake"),
      operation: "disable",
    };
    expect((await h.definitions.preview("a", mutation)).issues).toEqual([]);
    const state = await h.mutate(mutation);
    expect(state.overrides[1]).toEqual({
      origin: "project_override",
      source: source(h.v1, "intake"),
      operation: "disable",
      revision: 1,
      actorId: "author",
      changedAt: now.toISOString(),
    });
    expect(await h.storage.definitions.get("a")).toEqual(state);
    expect(h.audits("project.definition_changed")[1]).toMatchObject({
      actorId: "author",
      payload: {
        action: "put_override",
        identity: source(h.v1, "intake"),
        operation: "disable",
        newRevision: 2,
      },
    });
    const resolved = await h.configuration();
    expect(resolved.disabledWorkflows).toEqual([workflowId("intake")]);
    expect(resolved.workflows.map((item) => item.workflowId)).toEqual([
      workflowId("archive"),
      workflowId("audit"),
      workflowId("review"),
    ]);

    await h.mutate({
      action: "remove_override",
      source: source(h.v1, "intake"),
    });
    const restored = await h.configuration();
    expect(restored.disabledWorkflows).toEqual([]);
    expect(workflowOf(restored, workflowId("intake"))).toMatchObject({
      taskTypeId: pid("taskTypes", "filing"),
      stages: [stage("file", "clerk")],
      customization: "none",
    });
  });

  test("a role is omitted only after the one workflow that needs it is disabled or drops its stage", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // Omitting first is stored and fails closed at resolution.
    await h.override(h.v1, "clerk", "disable", undefined, "roles");
    await expect(h.configuration()).rejects.toMatchObject({
      code: "disabled_required_definition",
    });
    await expect(h.configuration()).rejects.toBeInstanceOf(
      ProjectConfigurationResolutionError,
    );
    await h.override(h.v1, "intake", "disable");
    const disabled = await h.configuration();
    expect(disabled.omittedRoles).toEqual([pid("roles", "clerk")]);
    expect(disabled.disabledWorkflows).toEqual([workflowId("intake")]);

    // The other way: replace the workflow without the stage, then omit.
    await h.override(h.v1, "audit", "replace", {
      id: "audit",
      taskType: "matter",
      stages: [{ id: "inspect", role: "counsel" }],
    });
    await h.override(h.v1, "auditor", "disable", undefined, "roles");
    const replaced = await h.configuration();
    expect(replaced.omittedRoles).toEqual([
      pid("roles", "auditor"),
      pid("roles", "clerk"),
    ]);
    expect(workflowOf(replaced, workflowId("audit"))?.stages).toEqual([
      stage("inspect", "counsel"),
    ]);

    // Re-enabling the workflow brings the requirement back.
    await h.mutate({
      action: "remove_override",
      source: source(h.v1, "intake"),
    });
    await expect(h.configuration()).rejects.toMatchObject({
      code: "disabled_required_definition",
    });
  });
});

describe("GP-13 workflow templates across a pack upgrade", () => {
  test("a replaced workflow keeps its identity, envelope and stage order; the change is reported", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "review", "replace", ourReview);
    const before = await h.configuration();
    const stored = (await h.storage.definitions.get("a")).overrides[0]!;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "review"),
        operation: "replace",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "review"),
      },
    ]);
    // Every changed workflow is in the existing template change list.
    expect(
      plan.templates.availability === "available" &&
        plan.templates.changes.filter((item) => item.kind === "workflows"),
    ).toEqual([
      {
        packId,
        kind: "workflows",
        localId: "archive",
        change: "removed",
        customized: false,
      },
      {
        packId,
        kind: "workflows",
        localId: "audit",
        change: "changed",
        customized: false,
      },
      {
        packId,
        kind: "workflows",
        localId: "escalation",
        change: "added",
        customized: false,
      },
      {
        packId,
        kind: "workflows",
        localId: "intake",
        change: "changed",
        customized: false,
      },
      {
        packId,
        kind: "workflows",
        localId: "review",
        change: "changed",
        customized: true,
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("Our review");
    expect(JSON.stringify(plan)).not.toContain("second-opinion");
    await applyUpgrade(h, [h.v2], plan.planDigest);

    // The project entry is carried over whole; only its pack tuple moved.
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      { ...stored, source: source(h.v2, "review") },
    ]);
    const after = await h.configuration();
    expect(after.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    expect(workflowOf(after, workflowId("review"))).toEqual({
      ...workflowOf(before, workflowId("review")),
      effectiveId: `pack:${packId}@2.0.0#${h.v2.manifestDigest}/workflows/review`,
    });
    // Not reset to the new template and not merged with its new stage.
    expect(workflowOf(after, workflowId("review"))).toMatchObject({
      title: "Our review",
      taskTypeId: pid("taskTypes", "filing"),
      stages: [
        stage("check", "counsel"),
        stage("second-opinion", "auditor"),
        stage("draft", "clerk"),
      ],
      customization: "replace",
    });
    // Every workflow present in both versions keeps its stable identity.
    for (const id of ["review", "intake", "audit"].map(workflowId)) {
      expect(workflowOf(before, id)?.workflowId).toBe(id);
      expect(workflowOf(after, id)?.workflowId).toBe(id);
      expect(workflowOf(after, id)?.effectiveId).not.toBe(
        workflowOf(before, id)?.effectiveId,
      );
    }
    expect(h.audits("project.pack_upgrade_applied")).toMatchObject([
      {
        actorId: "operator",
        payload: {
          overrides: [
            {
              source: source(h.v1, "review"),
              outcome: "retargeted",
              target: source(h.v2, "review"),
            },
          ],
        },
      },
    ]);
    expect(
      JSON.stringify(h.audits("project.pack_upgrade_applied")),
    ).not.toContain("second-opinion");
  });

  test("a replacement whose task type or stage role is gone in the new version blocks until the project changes it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // 3.0.0 has no role `auditor` and no task type `filing`.
    await h.override(h.v1, "review", "replace", {
      id: "review",
      taskType: "matter",
      stages: [
        { id: "check", role: "counsel" },
        { id: "second-opinion", role: "auditor" },
      ],
    });
    const before = await h.authority();
    const role = await h.upgrade().preview({ projectId: "a", desired: [h.v3] });
    expect(role.issues).toEqual([
      {
        code: "prospective_configuration_invalid",
        detail: "missing_workflow_reference",
        message: expect.stringContaining("roles/auditor") as unknown,
      },
    ]);
    expect(role.issues[0]?.message).toContain("workflows/review");
    expect(role.prospectiveConfigurationDigest).toBeUndefined();
    // It is not an override conflict: the override itself can follow.
    expect(role.overrides).toMatchObject([{ outcome: "retargeted" }]);
    await expect(
      applyUpgrade(h, [h.v3], role.planDigest),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    // No resolution answers it.
    const resolved = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v3],
      resolutions: [
        { source: source(h.v1, "review"), action: "convert_to_replace" },
      ],
    });
    expect(resolved.issues).toMatchObject([
      { code: "prospective_configuration_invalid" },
    ]);
    expect(resolved.ignoredResolutions).toHaveLength(1);
    expect(await h.authority()).toEqual(before);

    // The same for the task type.
    await h.mutate({
      action: "put_override",
      source: source(h.v1, "review"),
      operation: "replace",
      expectedEntryRevision: 1,
      payload: {
        id: "review",
        taskType: "filing",
        stages: [{ id: "check", role: "counsel" }],
      },
    });
    const taskType = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v3] });
    expect(taskType.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "missing_workflow_reference",
      },
    ]);
    expect(taskType.issues[0]?.message).toContain("taskTypes/filing");

    // The project resolves it explicitly, then the upgrade applies.
    await h.mutate({
      action: "put_override",
      source: source(h.v1, "review"),
      operation: "replace",
      expectedEntryRevision: 2,
      payload: {
        id: "review",
        taskType: "matter",
        stages: [{ id: "check", role: "counsel" }],
      },
    });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v3] });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v3], plan.planDigest);
    expect(
      workflowOf(await h.configuration(), workflowId("review"))?.stages,
    ).toEqual([stage("check", "counsel")]);
  });

  test("a replacement that names an omitted role, or an omitted role a new workflow names, blocks the upgrade", async () => {
    // The replacement names `clerk`, which the project omits.
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "intake", "disable");
    await h.override(h.v1, "clerk", "disable", undefined, "roles");
    await h.override(h.v1, "review", "replace", {
      id: "review",
      taskType: "matter",
      stages: [{ id: "check", role: "clerk" }],
    });
    const before = await h.authority();
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([
      {
        code: "prospective_configuration_invalid",
        detail: "disabled_required_definition",
        message: expect.stringContaining("workflows/review") as unknown,
      },
    ]);
    expect(await h.authority()).toEqual(before);

    // 2.0.0 adds `escalation`, which names `auditor`; the project omitted it
    // after disabling the only 1.0.0 workflow that used it.
    const added = await harness();
    await added.bind([added.v1]);
    await added.override(added.v1, "audit", "disable");
    await added.override(added.v1, "auditor", "disable", undefined, "roles");
    expect((await added.configuration()).omittedRoles).toEqual([
      pid("roles", "auditor"),
    ]);
    const blocked = await added
      .upgrade()
      .preview({ projectId: "a", desired: [added.v2] });
    expect(blocked.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "disabled_required_definition",
      },
    ]);
    expect(blocked.issues[0]?.message).toContain("workflows/escalation");
    // The new workflow cannot be disabled before the version provides it.
    expect(
      await conflictCode(added.override(added.v1, "escalation", "disable")),
    ).toBe("source_definition_missing");
    // Lift the omission, upgrade, disable the new workflow, omit again.
    await added.mutate({
      action: "remove_override",
      source: source(added.v1, "auditor", "roles"),
    });
    const clean = await added
      .upgrade()
      .preview({ projectId: "a", desired: [added.v2] });
    expect(clean.issues).toEqual([]);
    await applyUpgrade(added, [added.v2], clean.planDigest);
    await added.override(added.v2, "escalation", "disable");
    await added.override(added.v2, "auditor", "disable", undefined, "roles");
    const resolved = await added.configuration();
    expect(resolved.omittedRoles).toEqual([pid("roles", "auditor")]);
    expect(resolved.disabledWorkflows).toEqual([
      workflowId("audit"),
      workflowId("escalation"),
    ]);
  });

  test("an extension the new version leaves room for follows the upgrade and takes the new stages", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // 2.0.0 gives the audit a description and a stage, but no title.
    await h.override(h.v1, "audit", "extend", { title: "Our audit" });
    const stored = (await h.storage.definitions.get("a")).overrides[0]!;
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      { operation: "extend", outcome: "retargeted", upstream: "changed" },
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      { ...stored, source: source(h.v2, "audit") },
    ]);
    expect(workflowOf(await h.configuration(), workflowId("audit"))).toEqual({
      workflowId: workflowId("audit"),
      effectiveId: `pack:${packId}@2.0.0#${h.v2.manifestDigest}/workflows/audit`,
      origin: "pack_owned",
      title: "Our audit",
      description: "Yearly",
      taskTypeId: pid("taskTypes", "matter"),
      stages: [stage("inspect", "auditor"), stage("report", "counsel")],
      customization: "extend",
    });
  });

  test("an extension the new version fills is converted to a replacement that takes the new task type and stages", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "intake", "extend", {
      title: "Our intake",
      description: "Front desk",
    });
    const before = await h.authority();

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.issues).toMatchObject([
      { code: "unresolved_override_conflict", detail: "extend_conflict" },
    ]);
    expect(blocked.overrides).toMatchObject([
      { outcome: "conflict", conflict: "extend_conflict" },
    ]);
    expect(await h.authority()).toEqual(before);

    const resolutions = [
      { source: source(h.v1, "intake"), action: "convert_to_replace" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "intake"),
        operation: "extend",
        outcome: "converted_to_replace",
        upstream: "changed",
        target: source(h.v2, "intake"),
        conflict: "extend_conflict",
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("Our intake");
    expect(JSON.stringify(plan)).not.toContain("stamp");
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);

    // The project's fields win; the task type and the stages, in the
    // template's order, are the new version's.
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v2, "intake"),
        operation: "replace",
        revision: 2,
        payload: {
          id: "intake",
          title: "Our intake",
          description: "Front desk",
          taskType: "filing",
          stages: [
            { id: "stamp", role: "paralegal" },
            { id: "file", role: "clerk" },
          ],
        },
        actorId: "operator",
        changedAt: later.toISOString(),
      },
    ]);
    const after = await h.configuration();
    expect(after.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    expect(workflowOf(after, workflowId("intake"))).toMatchObject({
      title: "Our intake",
      description: "Front desk",
      taskTypeId: pid("taskTypes", "filing"),
      stages: [stage("stamp", "paralegal"), stage("file", "clerk")],
      customization: "replace",
    });
    // Removing the extension instead lets the new template apply.
    const removal = await harness();
    await removal.bind([removal.v1]);
    await removal.override(removal.v1, "intake", "extend", {
      title: "Our intake",
    });
    const remove = [
      { source: source(removal.v1, "intake"), action: "remove_override" },
    ];
    const removed = await removal.upgrade().preview({
      projectId: "a",
      desired: [removal.v2],
      resolutions: remove,
    });
    expect(removed.issues).toEqual([]);
    await applyUpgrade(removal, [removal.v2], removed.planDigest, remove);
    expect(
      workflowOf(await removal.configuration(), workflowId("intake")),
    ).toMatchObject({ title: "Intake", customization: "none" });
  });

  test("converting an extension of a template with more than 1,000 stages blocks", async () => {
    const stages = Array.from({ length: 1_001 }, (_, index) => ({
      id: `s${index}`,
      role: "counsel",
    }));
    const big = (version: string, title?: string) =>
      packBytes(version, {
        roles: [{ id: "counsel" }],
        taskTypes: [{ id: "matter" }],
        workflows: [
          {
            id: "long",
            ...(title === undefined ? {} : { title }),
            taskType: "matter",
            stages,
          },
        ],
      });
    const h = await harness([big("1.0.0"), big("2.0.0", "Long")]);
    await h.bind([h.v1]);
    // The manifest contract does not bound a pack workflow's stage list.
    expect(
      workflowOf(await h.configuration(), workflowId("long"))?.stages,
    ).toHaveLength(1_001);
    await h.override(h.v1, "long", "extend", { title: "Ours" });
    const plan = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v2],
      resolutions: [
        { source: source(h.v1, "long"), action: "convert_to_replace" },
      ],
    });
    expect(plan.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "unresolved_override",
      },
    ]);
  });

  test("a disabled workflow stays disabled when the new version changes it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "review", "disable");
    const stored = (await h.storage.definitions.get("a")).overrides[0]!;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "review"),
        operation: "disable",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "review"),
      },
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      { ...stored, source: source(h.v2, "review") },
    ]);
    const resolved = await h.configuration();
    expect(resolved.disabledWorkflows).toEqual([workflowId("review")]);
    expect(resolved.workflows.map((item) => item.workflowId)).not.toContain(
      workflowId("review"),
    );
  });

  test("a disabled workflow removed upstream blocks until its override is removed, and is not recreated", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "archive", "disable");
    const before = await h.authority();

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.issues).toMatchObject([
      {
        code: "unresolved_override_conflict",
        detail: "source_definition_removed",
      },
    ]);
    expect(blocked.overrides).toMatchObject([
      { outcome: "conflict", upstream: "removed" },
    ]);
    const retained = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v2],
      resolutions: [
        { source: source(h.v1, "archive"), action: "retain_as_project_owned" },
      ],
    });
    expect(retained.issues).toMatchObject([{ code: "invalid_resolution" }]);
    expect(await h.authority()).toEqual(before);

    const resolutions = [
      { source: source(h.v1, "archive"), action: "remove_override" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);
    const resolved = await h.configuration();
    expect([
      ...resolved.workflows.map((item) => item.workflowId),
      ...resolved.disabledWorkflows,
    ]).not.toContain(workflowId("archive"));
    expect((await h.storage.definitions.get("a")).overrides).toEqual([]);
  });

  test("a customized workflow whose template or pack is removed blocks, and is never retained as project-owned", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "archive", "replace", {
      id: "archive",
      title: "Our archive",
      taskType: "filing",
      stages: [{ id: "store", role: "clerk" }],
    });
    const before = await h.authority();
    const retain = [
      { source: source(h.v1, "archive"), action: "retain_as_project_owned" },
    ];
    for (const [desired, conflict] of [
      [[h.v2], "source_definition_removed"],
      [[], "source_pack_removed"],
    ] as const) {
      const blocked = await h
        .upgrade()
        .preview({ projectId: "a", desired: [...desired] });
      expect(blocked.issues).toMatchObject([
        { code: "unresolved_override_conflict", detail: conflict },
      ]);
      // A retained workflow's bare references would resolve in the project
      // namespace, where `filing` and `clerk` name something else or nothing.
      const refused = await h.upgrade().preview({
        projectId: "a",
        desired: [...desired],
        resolutions: retain,
      });
      expect(refused.issues).toEqual([
        {
          code: "invalid_resolution",
          detail: conflict,
          message: expect.stringContaining(
            "cannot be retained as project-owned",
          ) as unknown,
        },
      ]);
      expect(refused.issues[0]?.message).toContain("project namespace");
      expect(refused.overrides).toMatchObject([{ outcome: "conflict" }]);
      await expect(
        applyUpgrade(h, [...desired], refused.planDigest, retain),
      ).rejects.toMatchObject({ code: "upgrade_blocked" });
    }
    // Refused even when project definitions with the same local IDs exist.
    await h.add("roles", "clerk-desk");
    expect(await h.revision()).toBe(before.definitions.revision + 1);

    const resolutions = [
      { source: source(h.v1, "archive"), action: "remove_override" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      { outcome: "removed", conflict: "source_definition_removed" },
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);
    const state = await h.storage.definitions.get("a");
    expect(state.overrides).toEqual([]);
    expect(state.owned.map((item) => item.kind)).toEqual(["roles"]);
  });

  test("a project-owned workflow survives an upgrade untouched, and a pack that starts to provide it blocks", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.add("roles", "liaison");
    await h.add("taskTypes", "errand");
    await h.add("workflows", "house", {
      id: "house",
      taskType: "errand",
      stages: [
        { id: "second", role: "liaison" },
        { id: "first", role: "liaison" },
      ],
    });
    const owned = (await h.storage.definitions.get("a")).owned;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect((await h.storage.definitions.get("a")).owned).toEqual(owned);
    expect(
      workflowOf(await h.configuration(), "project:workflows/house"),
    ).toEqual({
      workflowId: "project:workflows/house",
      effectiveId: "project:workflows/house",
      origin: "project_owned",
      taskTypeId: "project:taskTypes/errand",
      stages: [
        { id: "second", roleId: "project:roles/liaison" },
        { id: "first", roleId: "project:roles/liaison" },
      ],
      customization: "none",
    });

    // 2.0.0 adds a pack workflow `escalation`.
    const collision = await harness();
    await collision.bind([collision.v1]);
    await collision.add("roles", "liaison");
    await collision.add("taskTypes", "errand");
    await collision.add("workflows", "escalation", {
      id: "escalation",
      taskType: "errand",
      stages: [{ id: "only", role: "liaison" }],
    });
    const before = await collision.authority();
    const blocked = await collision
      .upgrade()
      .preview({ projectId: "a", desired: [collision.v2] });
    expect(blocked.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "duplicate_effective_definition",
      },
    ]);
    await expect(
      applyUpgrade(collision, [collision.v2], blocked.planDigest),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    expect(await collision.authority()).toEqual(before);
  });

  test("the plan does not depend on storage, registration or declaration order", async () => {
    // The same manifests with every list but the stage lists reversed: stage
    // order is content, declaration order of definitions is not.
    const reverse = <T>(items: readonly T[]) => [...items].reverse();
    const reordered = [
      packBytes("1.0.0", {
        roles: reverse(roles),
        taskTypes: reverse(taskTypes),
        workflows: reverse(v1Workflows),
      }),
      packBytes("2.0.0", {
        roles: reverse(roles),
        taskTypes: reverse(taskTypes),
        workflows: reverse(v2Workflows),
      }),
    ];
    const first = await harness([v1Bytes, v2Bytes]);
    // Registered newest first.
    const second = await harness([reordered[1]!, reordered[0]!]);
    const steps = (h: Harness, pack: PackIdentity) => [
      () => h.override(pack, "review", "replace", ourReview),
      () => h.override(pack, "intake", "extend", { title: "I" }),
      () => h.override(pack, "audit", "disable"),
      () => h.override(pack, "archive", "disable"),
      () => h.add("roles", "liaison"),
      () => h.add("taskTypes", "errand"),
      () =>
        h.add("workflows", "house", {
          id: "house",
          taskType: "errand",
          stages: [{ id: "only", role: "liaison" }],
        }),
    ];
    await first.bind([first.v1]);
    for (const step of steps(first, first.v1)) await step();
    // `second` registered 2.0.0 first, so its packs are [v2, v1].
    const [secondV2, secondV1] = second.packs as [PackIdentity, PackIdentity];
    expect(secondV1).toEqual(first.v1);
    expect(secondV2).toEqual(first.v2);
    await second.bind([secondV1]);
    for (const step of steps(second, secondV1).reverse()) await step();

    const resolutions = [
      { source: source(first.v1, "intake"), action: "convert_to_replace" },
      { source: source(first.v1, "archive"), action: "remove_override" },
    ];
    const one = await first
      .upgrade()
      .preview({ projectId: "a", desired: [first.v2], resolutions });
    const two = await second.upgrade().preview({
      projectId: "a",
      desired: [secondV2],
      resolutions: [...resolutions].reverse(),
    });

    expect(one.issues).toEqual([]);
    expect(two).toEqual(one);
    expect(two.planDigest).toBe(one.planDigest);
    expect(
      (
        await first
          .upgrade()
          .preview({ projectId: "a", desired: [first.v2], resolutions })
      ).planDigest,
    ).toBe(one.planDigest);
    // Applying either yields the same configuration.
    await applyUpgrade(first, [first.v2], one.planDigest, resolutions);
    await applyUpgrade(second, [secondV2], two.planDigest, resolutions);
    const [left, right] = [
      await first.configuration(),
      await second.configuration(),
    ];
    expect(right.configurationDigest).toBe(left.configurationDigest);
    expect(right.workflows).toEqual(left.workflows);
    expect(right.disabledWorkflows).toEqual(left.disabledWorkflows);
    expect(left.configurationDigest).toBe(one.prospectiveConfigurationDigest);
    // Information is preserved: the project's order and the template's.
    expect(
      workflowOf(left, workflowId("review"))?.stages.map((item) => item.id),
    ).toEqual(["check", "second-opinion", "draft"]);
    expect(
      workflowOf(left, workflowId("intake"))?.stages.map((item) => item.id),
    ).toEqual(["stamp", "file"]);
  });
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

describe("GP-13 preserves Runtime pipeline state", () => {
  test("replacing, disabling and upgrading a workflow override leaves every Runtime table byte-identical", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await seedRuntimePipelineState(h);
    const before = everythingElse(h);
    // The fixture holds real Runtime pipeline state.
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
    const audits = async () => (await h.authority()).audits ?? 0;
    const auditsBefore = await audits();

    await h.override(h.v1, "review", "replace", ourReview);
    expect(everythingElse(h)).toEqual(before);
    await h.override(h.v1, "audit", "disable");
    expect(everythingElse(h)).toEqual(before);
    await h.override(h.v1, "intake", "extend", { description: "Front desk" });
    expect(everythingElse(h)).toEqual(before);
    // A refused mutation and a read-only preview write nothing at all.
    const refusedAt = await h.authority();
    expect(
      await conflictCode(
        h.override(h.v1, "archive", "replace", {
          id: "archive",
          taskType: "ghost",
          stages: [],
        }),
      ),
    ).toBe("source_definition_missing");
    await h.configuration();
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(await h.authority()).toEqual(refusedAt);
    expect(everythingElse(h)).toEqual(before);

    // An upgrade that retargets the three workflow overrides.
    expect(plan.overrides.map((item) => item.outcome)).toEqual([
      "retargeted",
      "retargeted",
      "retargeted",
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect(everythingElse(h)).toEqual(before);

    // The definition, binding and audit tables are what changed.
    const after = await h.authority();
    expect(after.binding.packs).toEqual([h.v2]);
    expect(after.definitions.overrides.map((item) => item.source)).toEqual([
      source(h.v2, "audit"),
      source(h.v2, "intake"),
      source(h.v2, "review"),
    ]);
    expect(await audits()).toBe(auditsBefore + 4);
    const resolved = await h.configuration();
    expect(resolved.disabledWorkflows).toEqual([workflowId("audit")]);
    // Runs do not pin pack configuration: the plan states it has no pins.
    expect(plan.activePins).toEqual({
      availability: "unavailable",
      reason: "pack_configuration_run_pins_not_modelled",
    });
  });
});

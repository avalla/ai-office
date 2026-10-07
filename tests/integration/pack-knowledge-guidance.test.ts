import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import {
  ManageProjectPackBinding,
  ProjectPackBindingRefusedError,
} from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { knowledgeAuditRecord } from "@ai-office/application/domain-pack/pack-knowledge-changes.ts";
import { ProjectDefinitionConflictError } from "@ai-office/application/domain-pack/project-definition.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ReconcileProjectPackUpgrade } from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import {
  ProjectConfigurationResolutionError,
  type ResolvedProjectConfiguration,
} from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import { ManageProjectPortability } from "@ai-office/application/project-portability/manage-project-portability.ts";
import {
  parsePortableProjectArchive,
  portableProjectDefinitionFormatVersion,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../packages/domain-pack-contracts/src/jcs.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { LocalProjectBindingAdapter } from "@ai-office/runtime-host/local-project-binding-adapter.ts";
import { LocalProjectScanner } from "@ai-office/runtime-host/local-project-scanner.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteProjectDefinitionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-definition.repository.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import {
  mutatedDevelopmentPackBytes,
  testCatalogWith,
} from "../helpers/development-pack-parity.ts";
import {
  legacyProjectId,
  legacyStores,
  loadPrePackFixture,
  projectMigrations,
  SequenceIds,
  tableRows,
  TickingClock,
} from "../helpers/legacy-development-fixture.ts";

// GP-15: typed pack knowledge guidance through resolution, project
// definitions, the upgrade plan, the selection guard and the portable
// archive, on SQLite. Guidance is a declaration here: nothing in this file
// reads, seeds or searches a knowledge store.

const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const now = new Date("2026-10-06T00:00:00.000Z");
const later = new Date("2026-10-07T00:00:00.000Z");
const encoder = new TextEncoder();
const packId = "org.example.library";

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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
    metadata: { name: id, description: "Knowledge guidance fixture" },
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

function identityOf(bytes: Uint8Array): PackIdentity {
  const { id, version, manifestDigest } = parseDomainPackManifest(bytes);
  return { id, version, manifestDigest };
}

function catalogOf(...artifacts: Uint8Array[]) {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  for (const [index, bytes] of artifacts.entries())
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: `fixture-${index}`,
      },
    });
  return catalog;
}

class ExactTestRootBindingAdapter extends LocalProjectBindingAdapter {
  override async resolveProjectRoot(inputPath: string): Promise<string> {
    return realpathSync(inputPath);
  }
}

function runtime(catalog: InstalledDomainPackCatalog) {
  const root = temporaryRoot("ai-office-gp15-");
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const profiles = new SqliteProjectProfileRepository(database);
  const identities = new SqliteRepositoryIdentityRepository(database);
  const states = new SqliteProjectStateRepository(database);
  let sequence = 0;
  const ids = { generate: () => `id-${++sequence}` };
  const ports = (selected: InstalledDomainPackCatalog, clock: Date) => ({
    projects: storage.projects,
    definitions: storage.definitions,
    bindings: storage.packBindings,
    catalog: selected,
    auditEvents: storage.auditEvents,
    transactions: storage.transactions,
    clock: { now: () => clock },
    ids,
  });
  return {
    database,
    storage,
    identities,
    profiles,
    binding: (selected = catalog) =>
      new ManageProjectPackBinding(ports(selected, now)),
    definitions: (selected = catalog) =>
      new ManageProjectDefinitions(ports(selected, now)),
    upgrade: (selected = catalog) =>
      new ReconcileProjectPackUpgrade(ports(selected, later)),
    configuration: (projectId = "a", selected = catalog) =>
      new ReadProjectConfiguration({
        projects: storage.projects,
        bindings: storage.packBindings,
        definitions: storage.definitions,
        transactions: storage.transactions,
        catalog: selected,
      }).read(projectId),
    portability: (selected = catalog) =>
      new ManageProjectPortability({
        projects: storage.projects,
        profiles,
        identities,
        states,
        bindings: new ExactTestRootBindingAdapter(),
        scanner: new LocalProjectScanner(),
        transactions: storage.transactions,
        ids,
        clock: { now: () => now },
        catalog: selected,
      }),
    importProject: (rootPath: string) =>
      new ImportProject(
        storage.projects,
        profiles,
        new LocalProjectScanner(),
        identities,
        ids,
        { now: () => now },
        storage.transactions,
      ).execute({ rootPath }),
    /** Writes the selection directly, as state that passed no guard. */
    bind: async (packs: PackIdentity[], projectId = "a") => {
      await storage.packBindings.replace(
        projectId,
        (await storage.packBindings.get(projectId)).configurationRevision,
        packs,
        now,
      );
    },
    /** Writes one override directly, as state that passed no pre-store check. */
    storeOverride: async (
      pack: PackIdentity,
      localId: string,
      payload: object,
      projectId = "a",
      kind: "workflows" | "knowledge" = "workflows",
    ) => {
      const current = await storage.definitions.get(projectId);
      await storage.definitions.replace(
        {
          ...current,
          overrides: [
            ...current.overrides,
            {
              origin: "project_override" as const,
              source: { ...pack, kind, localId },
              operation: "replace" as const,
              revision: 1,
              payload: payload as { id: string },
              actorId: "operator",
              changedAt: now.toISOString(),
            },
          ],
        },
        current.revision,
        now,
      );
    },
    audits: (eventType: string) =>
      database
        .query<{ payload_json: string }, [string]>(
          "SELECT payload_json FROM audit_event WHERE event_type = ? ORDER BY id",
        )
        .all(eventType)
        .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>),
    authority: async (projectId = "a") => ({
      binding: await storage.packBindings.get(projectId),
      definitions: await storage.definitions.get(projectId),
      audits: database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM audit_event",
        )
        .get()?.count,
    }),
  };
}

async function project(...artifacts: Uint8Array[]) {
  const host = runtime(
    catalogOf(...(artifacts.length ? artifacts : everyArtifact)),
  );
  await host.storage.projects.save(Project.create({ id: "a", name: "A", now }));
  const revision = async () =>
    (await host.storage.definitions.get("a")).revision;
  const mutation = (
    pack: PackIdentity,
    localId: string,
    operation: "replace" | "extend" | "disable",
    payload?: object,
    kind = "workflows",
  ) => ({
    action: "put_override",
    source: { ...pack, kind, localId },
    operation,
    ...(payload === undefined ? {} : { payload }),
  });
  const mutate = async (value: unknown) =>
    host.definitions().apply({
      projectId: "a",
      expectedRevision: await revision(),
      actorId: "author",
      mutation: value,
    });
  return { ...host, revision, mutation, mutate };
}

const pid = (kind: string, localId: string, pack = packId) =>
  `pack:${pack}/${kind}/${localId}`;
const effective = (pack: PackIdentity, kind: string, localId: string) =>
  `pack:${pack.id}@${pack.version}#${pack.manifestDigest}/${kind}/${localId}`;

async function conflict(
  work: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
    const { code, message } = error as ProjectDefinitionConflictError;
    return { code, message };
  }
  throw new Error("Expected a definition conflict");
}

/** The version-1 digest material of a resolved configuration, recomputed. */
function digestOfMaterial(view: ResolvedProjectConfiguration): string {
  const material = {
    formatVersion: view.formatVersion,
    coreContractVersion: view.coreContractVersion,
    bindingRevision: view.bindingRevision,
    definitionRevision: view.definitionRevision,
    selectedPacks: view.selectedPacks,
    resolvedPacks: view.resolvedPacks,
    projectOwnedDefinitions: view.projectOwnedDefinitions,
    appliedOverrides: view.appliedOverrides,
    effectiveDefinitions: view.effectiveDefinitions,
    origins: view.origins,
    disabledDefinitions: view.disabledDefinitions,
    resolvedWorkflowReferences: view.resolvedWorkflowReferences,
  };
  const canonical = canonicalizeJcsJson(
    JSON.parse(JSON.stringify(material)) as never,
  );
  return `sha256:${createHash("sha256").update(`ai-office-project-configuration-v1\n${canonical}`).digest("hex")}`;
}

/** The approval token, recomputed from every other field of the plan. */
function planDigestOf<T extends { planDigest: string }>(plan: T): string {
  const { planDigest: _planDigest, ...rest } = plan;
  return `sha256:${createHash("sha256")
    .update("ai-office-pack-upgrade-plan-v1\n", "utf8")
    .update(canonicalizeJcsJson(rest as never), "utf8")
    .digest("hex")}`;
}

const roles = [{ id: "curator" }];
const clausesGuidance = {
  category: "clauses",
  schema: [
    { field: "jurisdiction", description: "Where the clause applies" },
    { field: "clause", description: "The clause text" },
  ],
  seeds: ["seed:clauses/standard", "https://user:token@host/x"],
  retrieval: {
    maxResults: 3,
    hint: "Prefer the clause of the matter's jurisdiction",
    categories: ["precedents", "clauses"],
  },
};
const clauses = {
  id: "clauses",
  title: "Clauses",
  description: "Reference clauses",
  ...clausesGuidance,
};
const notes = { id: "notes", title: "Notes" };
const librarian = {
  id: "librarian",
  role: "curator",
  knowledge: ["clauses", "notes"],
};
const library = (
  version: string,
  knowledge: unknown[],
  id = packId,
): Uint8Array =>
  packBytes(version, { roles, agents: [librarian], knowledge }, id);

const v1Bytes = library("1.0.0", [clauses, notes]);
// Changes one retrieval member of `clauses`.
const v2Bytes = library("2.0.0", [
  {
    ...clauses,
    retrieval: { ...clausesGuidance.retrieval, maxResults: 2 },
  },
  notes,
]);
// Removes all guidance from `clauses`; the entry stays.
const v3Bytes = library("3.0.0", [
  { id: "clauses", title: "Clauses", description: "Reference clauses" },
  notes,
]);
// Adds guidance to the existing, so far descriptive `notes`.
const v4Bytes = library("4.0.0", [clauses, { ...notes, category: "notes" }]);
// Changes presentation only.
const v5Bytes = library("5.0.0", [
  { ...clauses, title: "Clause library", description: "Other text" },
  notes,
]);
// Drops `notes` and adds a typed `precedents` entry: whole entries only.
const precedents = {
  id: "precedents",
  title: "Precedents",
  seeds: ["seed:precedents"],
};
const v6Bytes = packBytes("6.0.0", {
  roles,
  agents: [{ ...librarian, knowledge: ["clauses", "precedents"] }],
  knowledge: [clauses, precedents],
});
// The same entries as version 1 without any guidance.
const plainBytes = library(
  "1.0.0",
  [
    { id: "clauses", title: "Clauses", description: "Reference clauses" },
    notes,
  ],
  "org.example.plain",
);
// Written in another order: the same manifest digest as version 1.
const v1ReorderedBytes = library("1.0.0", [
  notes,
  {
    ...clauses,
    schema: [...clausesGuidance.schema].reverse(),
    seeds: [...clausesGuidance.seeds].reverse(),
    retrieval: {
      ...clausesGuidance.retrieval,
      categories: [...clausesGuidance.retrieval.categories].reverse(),
    },
  },
]);

const v1 = identityOf(v1Bytes);
const v2 = identityOf(v2Bytes);
const v3 = identityOf(v3Bytes);
const v4 = identityOf(v4Bytes);
const v5 = identityOf(v5Bytes);
const v6 = identityOf(v6Bytes);
const plain = identityOf(plainBytes);

const everyArtifact = [
  v1Bytes,
  v2Bytes,
  v3Bytes,
  v4Bytes,
  v5Bytes,
  v6Bytes,
  plainBytes,
];

/** The guidance of `clauses` as every report states it: sets in one order. */
const clausesReported = {
  category: "clauses",
  schema: [
    { field: "clause", description: "The clause text" },
    { field: "jurisdiction", description: "Where the clause applies" },
  ],
  seeds: ["https://user:token@host/x", "seed:clauses/standard"],
  retrieval: {
    maxResults: 3,
    hint: "Prefer the clause of the matter's jurisdiction",
    categories: ["clauses", "precedents"],
  },
};
const clausesId = pid("knowledge", "clauses");
const notesId = pid("knowledge", "notes");
const clausesV2Reported = {
  ...clausesReported,
  retrieval: { ...clausesReported.retrieval, maxResults: 2 },
};

async function conflictCode(work: Promise<unknown>): Promise<string> {
  return (await conflict(work)).code;
}

describe("GP-15 knowledge resolution and the derived knowledge view", () => {
  test("every entry is listed with stable identities; guidance is the pack's, sets in one order, and an agent keeps its references", async () => {
    const host = await project();
    await host.bind([v1]);
    const view = await host.configuration();
    expect(view.knowledge).toEqual([
      {
        knowledgeId: clausesId,
        effectiveId: effective(v1, "knowledge", "clauses"),
        origin: "pack_owned",
        title: "Clauses",
        description: "Reference clauses",
        ...clausesReported,
        customization: "none",
      },
      {
        knowledgeId: notesId,
        effectiveId: effective(v1, "knowledge", "notes"),
        origin: "pack_owned",
        title: "Notes",
        customization: "none",
      },
    ]);
    // The identities carry no version or digest and are the agent's references.
    expect(view.agents[0]!.knowledge).toEqual([clausesId, notesId]);
    // Another version keeps the stable identity.
    await host.bind([v5]);
    expect((await host.configuration()).knowledge[0]).toMatchObject({
      knowledgeId: clausesId,
      effectiveId: effective(v5, "knowledge", "clauses"),
      title: "Clause library",
      ...clausesReported,
    });
  });

  test("the written order of every set is irrelevant: the same manifest digest and the same view", async () => {
    const reordered = identityOf(v1ReorderedBytes);
    expect(reordered).toEqual(v1);
    const host = await project(v1ReorderedBytes);
    await host.bind([reordered]);
    expect((await host.configuration()).knowledge[0]).toMatchObject(
      clausesReported,
    );
  });

  test("the view is derived and outside the version-1 digest material; the empty vector and a guidance-free configuration are unchanged", async () => {
    const host = await project();
    await host.bind([v1]);
    const typed = await host.configuration();
    expect(typed.configurationDigest).toBe(digestOfMaterial(typed));
    expect(typed.pin.configurationDigest).toBe(typed.configurationDigest);
    // The pack payload is digest material, so guidance still moves the digest.
    expect(
      typed.effectiveDefinitions.knowledge.map((item) => item.payload),
    ).toEqual(parseDomainPackManifest(v1Bytes).contributions.knowledge);
    await host.bind([v2]);
    expect((await host.configuration()).configurationDigest).not.toBe(
      typed.configurationDigest,
    );
    // Without guidance the entries are descriptive and the view says nothing
    // more about them.
    await host.bind([plain]);
    const descriptive = await host.configuration();
    expect(descriptive.configurationDigest).toBe(digestOfMaterial(descriptive));
    expect(descriptive.knowledge).toEqual([
      {
        knowledgeId: pid("knowledge", "clauses", plain.id),
        effectiveId: effective(plain, "knowledge", "clauses"),
        origin: "pack_owned",
        title: "Clauses",
        description: "Reference clauses",
        customization: "none",
      },
      {
        knowledgeId: pid("knowledge", "notes", plain.id),
        effectiveId: effective(plain, "knowledge", "notes"),
        origin: "pack_owned",
        title: "Notes",
        customization: "none",
      },
    ]);
    await host.bind([]);
    expect((await host.configuration()).knowledge).toEqual([]);
    await host.storage.projects.save(
      Project.create({ id: "untouched", name: "Untouched", now }),
    );
    expect((await host.configuration("untouched")).configurationDigest).toBe(
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    );
  });
});

describe("GP-15 knowledge guidance is pack-owned", () => {
  const guidanceKeys = {
    category: "clauses",
    schema: [{ field: "clause", description: "Text" }],
    seeds: ["seed:a"],
    retrieval: { maxResults: 1 },
  };

  test("a project payload cannot carry a guidance key: protected security invariant, nothing written, for replace, extend and project-owned entries", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    for (const [key, value] of Object.entries(guidanceKeys)) {
      for (const operation of ["replace", "extend"] as const) {
        const rejected = await conflict(
          host.mutate(
            host.mutation(
              v1,
              "clauses",
              operation,
              operation === "replace"
                ? { id: "clauses", title: "Mine", [key]: value }
                : { title: "Mine", [key]: value },
              "knowledge",
            ),
          ),
        );
        expect([key, operation, rejected]).toEqual([
          key,
          operation,
          {
            code: "protected_security_invariant",
            message:
              "Knowledge guidance is declared by the pack; a project cannot declare it",
          },
        ]);
      }
      expect(
        await conflict(
          host.mutate({
            action: "put_owned",
            kind: "knowledge",
            id: "mine",
            enabled: true,
            payload: { id: "mine", [key]: value },
          }),
        ),
      ).toMatchObject({ code: "protected_security_invariant" });
      // Neither can the preview accept it.
      expect(
        await conflict(
          host
            .definitions()
            .preview(
              "a",
              host.mutation(
                v1,
                "clauses",
                "replace",
                { id: "clauses", [key]: value },
                "knowledge",
              ),
            ),
        ),
      ).toMatchObject({ code: "protected_security_invariant" });
    }
    // A scope or store key is no different: the allowlist rejects it.
    for (const key of ["tenantId", "repositoryId", "projectUid", "store"])
      expect(
        await conflictCode(
          host.mutate(
            host.mutation(
              v1,
              "clauses",
              "replace",
              { id: "clauses", [key]: "other" },
              "knowledge",
            ),
          ),
        ),
      ).toBe("protected_security_invariant");
    expect(await host.authority()).toEqual(before);
    expect(host.audits("project.definition_changed")).toEqual([]);
  });

  test("disable stays unsupported for knowledge", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    expect(
      await conflictCode(
        host.mutate(
          host.mutation(v1, "clauses", "disable", undefined, "knowledge"),
        ),
      ),
    ).toBe("unsupported_override_operation");
    expect(await host.authority()).toEqual(before);
  });

  test("a replacement and an extension are descriptive: the guidance stays the pack's and the digest moves with the override", async () => {
    const host = await project();
    await host.bind([v1]);
    const base = await host.configuration();
    await host.mutate(
      host.mutation(
        v1,
        "clauses",
        "replace",
        { id: "clauses", title: "Project clauses" },
        "knowledge",
      ),
    );
    const replaced = await host.configuration();
    expect(replaced.knowledge[0]).toEqual({
      knowledgeId: clausesId,
      effectiveId: effective(v1, "knowledge", "clauses"),
      origin: "pack_owned",
      title: "Project clauses",
      ...clausesReported,
      customization: "replace",
    });
    expect(replaced.configurationDigest).toBe(digestOfMaterial(replaced));
    expect(replaced.configurationDigest).not.toBe(base.configurationDigest);
    await host.mutate(
      host.mutation(
        v1,
        "notes",
        "extend",
        { description: "Mine" },
        "knowledge",
      ),
    );
    const extended = await host.configuration();
    expect(extended.knowledge[1]).toMatchObject({
      description: "Mine",
      customization: "extend",
    });
    expect(Object.keys(extended.knowledge[1]!)).not.toContain("category");
    // A project-owned entry has no guidance.
    await host.mutate({
      action: "put_owned",
      kind: "knowledge",
      id: "mine",
      enabled: true,
      payload: { id: "mine", title: "Mine" },
    });
    expect(
      (await host.configuration()).knowledge.find(
        (item) => item.origin === "project_owned",
      ),
    ).toEqual({
      knowledgeId: "project:knowledge/mine",
      effectiveId: "project:knowledge/mine",
      origin: "project_owned",
      title: "Mine",
      customization: "none",
    });
  });

  test("stored state that carries a guidance key fails closed instead of being merged", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.storeOverride(
      v1,
      "clauses",
      { id: "clauses", seeds: ["seed:injected"] },
      "a",
      "knowledge",
    );
    const failure = await host.configuration().catch((error) => error);
    // Never a view that merged the project's seeds into the pack's.
    expect(failure).toBeInstanceOf(ProjectConfigurationResolutionError);
    expect(failure.code).toBe("unresolved_override");
    expect(failure.message).toContain("protected_security_invariant");
    expect(JSON.stringify(failure.message)).not.toContain("seed:injected");
  });
});

describe("GP-15 knowledge guidance changes in the upgrade plan", () => {
  test("the plan reports the change and the target guidance under planDigest, and the audit event records both without presentation", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(
      host.mutation(
        v1,
        "notes",
        "extend",
        { description: "Mine" },
        "knowledge",
      ),
    );
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.knowledgeChanges).toEqual({
      availability: "available",
      changes: [
        {
          knowledgeId: clausesId,
          change: "changed",
          before: { knowledgeId: clausesId, ...clausesReported },
          after: { knowledgeId: clausesId, ...clausesV2Reported },
          customized: false,
        },
      ],
    });
    expect(plan.targetKnowledge).toEqual([
      { knowledgeId: clausesId, ...clausesV2Reported },
    ]);
    expect(plan.planDigest).toBe(planDigestOf(plan));
    // Both fields are approval material.
    expect(
      planDigestOf({
        ...plan,
        knowledgeChanges: { ...plan.knowledgeChanges, changes: [] },
      }),
    ).not.toBe(plan.planDigest);
    expect(planDigestOf({ ...plan, targetKnowledge: [] })).not.toBe(
      plan.planDigest,
    );
    const projectValues = (await host.storage.definitions.get("a")).overrides;
    const applied = await host.upgrade().apply({
      projectId: "a",
      desired: [v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "approver",
    });
    expect(applied.result).toBe("applied");
    const events = host.audits("project.pack_upgrade_applied");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      planDigest: plan.planDigest,
      ...knowledgeAuditRecord(plan),
    });
    const recorded = JSON.stringify(events[0]);
    // Identities and digests only: no guidance text, hint or seed.
    expect(events[0]!.targetKnowledge).toEqual([
      {
        knowledgeId: clausesId,
        guidanceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    ]);
    for (const body of [
      "Clauses",
      "Reference clauses",
      "Mine",
      "https://user:token@host/x",
      "token@host",
      "seed:clauses",
      "The clause text",
      "Where the clause applies",
      "Prefer the clause",
      "precedents",
    ])
      expect(recorded).not.toContain(body);
    // No upgrade rewrites a project value: the override is carried over whole,
    // only the pack tuple of its source is retargeted.
    const carried = (await host.storage.definitions.get("a")).overrides;
    expect(carried.map((item) => item.payload)).toEqual(
      projectValues.map((item) => item.payload),
    );
    expect((await host.configuration()).knowledge[0]).toMatchObject(
      clausesV2Reported,
    );
  });

  test("added, removed and customized entries are reported; presentation alone and whole entries are not guidance changes", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(
      host.mutation(
        v1,
        "clauses",
        "replace",
        { id: "clauses", title: "Project clauses" },
        "knowledge",
      ),
    );
    const changes = async (desired: PackIdentity) =>
      (await host.upgrade().preview({ projectId: "a", desired: [desired] }))
        .knowledgeChanges;
    expect(await changes(v3)).toEqual({
      availability: "available",
      changes: [
        {
          knowledgeId: clausesId,
          change: "removed",
          before: { knowledgeId: clausesId, ...clausesReported },
          customized: true,
        },
      ],
    });
    expect(await changes(v4)).toEqual({
      availability: "available",
      changes: [
        {
          knowledgeId: notesId,
          change: "added",
          after: { knowledgeId: notesId, category: "notes" },
          customized: false,
        },
      ],
    });
    // Presentation is not guidance.
    expect(await changes(v5)).toEqual({
      availability: "available",
      changes: [],
    });
    // A dropped typed entry and a new one are reported as guidance of whole
    // entries: `precedents` is added, `notes` had none.
    expect(await changes(v6)).toEqual({
      availability: "available",
      changes: [
        {
          knowledgeId: pid("knowledge", "precedents"),
          change: "added",
          after: {
            knowledgeId: pid("knowledge", "precedents"),
            seeds: ["seed:precedents"],
          },
          customized: false,
        },
      ],
    });
  });

  test("a no-op plan carries both fields empty, and the fields are unavailable when the previous artifacts are not installed", async () => {
    const host = await project();
    await host.bind([v1]);
    const noop = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v1] });
    expect(noop).toMatchObject({
      noop: true,
      knowledgeChanges: { availability: "available", changes: [] },
      targetKnowledge: [],
    });
    expect(noop.planDigest).toBe(planDigestOf(noop));
    const plan = await host
      .upgrade(catalogOf(v2Bytes))
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.knowledgeChanges).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    // Approval still binds the target guidance.
    expect(plan.targetKnowledge).toEqual([
      { knowledgeId: clausesId, ...clausesV2Reported },
    ]);
    expect(plan.planDigest).toBe(planDigestOf(plan));
  });
});

describe("GP-15 project:pack:apply refuses a guidance change of an existing entry", () => {
  const refusal = (id: string) => ({
    code: "knowledge_change_requires_upgrade",
    message: `The selection changes the guidance of knowledge ${id}; review and approve it with project:pack:upgrade`,
  });
  const apply = (
    host: Awaited<ReturnType<typeof project>>,
    desired: PackIdentity[],
    expectedRevision: number,
  ) =>
    host.binding().apply({
      projectId: "a",
      desired,
      expectedRevision,
      actorId: "local-operator",
    });

  test.each([
    {
      name: "changed guidance",
      target: v2,
      entry: clausesId,
      change: "changed",
    },
    {
      name: "guidance removed",
      target: v3,
      entry: clausesId,
      change: "removed",
    },
    { name: "guidance added", target: v4, entry: notesId, change: "added" },
  ])(
    "$name is reported by preview and refused by apply with the typed error; nothing is written",
    async ({ target, entry, change }) => {
      const host = await project();
      await apply(host, [v1], 0);
      const before = await host.authority();
      const preview = await host.binding().preview("a", [target]);
      expect(preview.knowledgeChanges).toMatchObject({
        availability: "available",
        changes: [{ knowledgeId: entry, change }],
      });
      expect(preview.issues).toEqual([refusal(entry)]);
      const refused = await apply(host, [target], 1).catch((error) => error);
      expect(refused).toBeInstanceOf(ProjectPackBindingRefusedError);
      expect(refused).toMatchObject(refusal(entry));
      expect(await host.authority()).toEqual(before);
      expect(host.audits("project.pack_binding_applied")).toHaveLength(1);
    },
  );

  test("adding a pack, a presentation-only version and a change of whole entries are applied", async () => {
    const host = await project();
    const first = await host.binding().preview("a", [v1]);
    expect(first.issues).toEqual([]);
    expect(first.knowledgeChanges).toMatchObject({
      availability: "available",
      changes: [{ knowledgeId: clausesId, change: "added" }],
    });
    await apply(host, [v1], 0);
    // Presentation only.
    expect((await host.binding().preview("a", [v5])).issues).toEqual([]);
    await apply(host, [v5], 1);
    // `notes` leaves and `precedents` arrives with its guidance: whole entries.
    expect((await host.binding().preview("a", [v6])).issues).toEqual([]);
    expect((await apply(host, [v6], 2)).packs).toEqual([v6]);
    // Removing the pack removes its guidance with it.
    await apply(host, [], 3);
    expect((await host.configuration()).knowledge).toEqual([]);
  });

  test("an unchanged selection reads no artifact and reports no guidance change", async () => {
    const host = await project();
    await apply(host, [v1], 0);
    const preview = await host.binding(catalogOf()).preview("a", [v1]);
    expect(preview.knowledgeChanges).toEqual({
      availability: "available",
      changes: [],
    });
  });
});

describe("GP-15 creates nothing in the Runtime", () => {
  test("binding a development pack copy with knowledge guidance leaves every run, approval and job table identical", async () => {
    const database = loadPrePackFixture(temporaryRoot("ai-office-gp15-gp09-"));
    databases.push(database);
    migrate(database, projectMigrations);
    const stores = legacyStores(
      database,
      new TickingClock("2026-10-06T00:00:00.000Z"),
      new SequenceIds("gp15"),
    );
    // A copy of the development reference pack with knowledge guidance; the
    // committed pack is not edited by this pull request.
    const bytes = mutatedDevelopmentPackBytes((manifest) => {
      (manifest.contributions as Record<string, unknown[]>).knowledge = [
        { id: "handbook", ...clausesGuidance },
      ];
    });
    const { catalog, pack } = testCatalogWith(bytes);
    const bindings = new SqliteProjectPackBindingRepository(database);
    const definitions = new SqliteProjectDefinitionRepository(database);
    const before = tableRows(database);
    await new ManageProjectPackBinding({
      projects: stores.projects,
      bindings,
      definitions,
      catalog,
      auditEvents: new SqliteAuditEventRepository(database),
      transactions: stores.transactions,
      clock: stores.clock,
      ids: stores.ids,
    }).apply({
      projectId: legacyProjectId,
      desired: [pack],
      expectedRevision: 0,
      actorId: "gp15-test",
    });
    const resolved = await new ReadProjectConfiguration({
      projects: stores.projects,
      bindings,
      definitions,
      transactions: stores.transactions,
      catalog,
    }).read(legacyProjectId);
    expect(resolved.knowledge).toMatchObject([
      {
        knowledgeId: "pack:org.ai-office.development/knowledge/handbook",
        ...clausesReported,
      },
    ]);
    const after = tableRows(database);
    for (const table of [
      "office_manifest_revision",
      "pipeline_run",
      "pipeline_stage_run",
      "pipeline_override",
      "approval",
      "task",
      "task_lock",
      "agent",
      "agent_run",
      "role",
      "job_outbox",
      "capability_grants",
      "action_requests",
      "project_owned_definition",
      "project_definition_override",
    ]) {
      expect(Object.keys(before)).toContain(table);
      expect([table, after[table]]).toEqual([table, before[table]]);
    }
    expect(
      Object.keys(after).filter(
        (table) => after[table]!.join() !== before[table]!.join(),
      ),
    ).toEqual([
      "audit_event",
      "project_pack_binding",
      "project_pack_binding_pack",
    ]);
  });
});

describe("GP-15 portable archive and restore", () => {
  /** A source host without installed packs: state that passed no check. */
  async function archiveOf(pack: PackIdentity, payload?: object) {
    const origin = runtime(new InMemoryInstalledDomainPackCatalog(1, []));
    const source = temporaryRoot("ai-office-gp15-source-");
    writeFileSync(join(source, "package.json"), '{"name":"gp15"}\n');
    const imported = await origin.importProject(source);
    await origin.bind([pack], imported.projectId);
    if (payload !== undefined)
      await origin.storeOverride(
        pack,
        "clauses",
        payload,
        imported.projectId,
        "knowledge",
      );
    return { origin, projectId: imported.projectId };
  }

  function restoreTarget(): string {
    const target = temporaryRoot("ai-office-gp15-target-");
    writeFileSync(join(target, "package.json"), '{"name":"gp15"}\n');
    return target;
  }

  test("a project bound to a pack with guidance is archived at the format it had before, carries no guidance, and restores", async () => {
    const withPack = await archiveOf(v1, { id: "clauses", title: "Mine" });
    const without = await archiveOf(plain, { id: "clauses", title: "Mine" });
    const archive = parsePortableProjectArchive(
      serializePortableProjectArchive(
        (await withPack.origin.portability().backup(withPack.projectId))
          .archive,
      ),
    );
    const reference = parsePortableProjectArchive(
      serializePortableProjectArchive(
        (await without.origin.portability().backup(without.projectId)).archive,
      ),
    );
    // No format is added: the definition format has carried knowledge
    // overrides since GP-08.
    expect(archive.manifest.formatVersion).toBe(
      reference.manifest.formatVersion,
    );
    expect(archive.manifest.formatVersion).toBe(
      portableProjectDefinitionFormatVersion,
    );
    const state = JSON.stringify([
      archive.state.packBinding,
      archive.state.definitions,
    ]);
    for (const guidance of [
      "seed:clauses",
      "jurisdiction",
      "Prefer the clause",
      "precedents",
    ])
      expect(state).not.toContain(guidance);
    const host = runtime(catalogOf(v1Bytes));
    const restored = await host
      .portability()
      .restore({ archive, rootPath: restoreTarget() });
    expect(restored.outcome).toBe("restored");
    expect(
      (await host.configuration(restored.projectId)).knowledge[0],
    ).toMatchObject({
      title: "Mine",
      ...clausesReported,
      customization: "replace",
    });
  });

  test("a project payload with a guidance key cannot be exported, so no archive carries one", async () => {
    const hostile = await archiveOf(v1, {
      id: "clauses",
      title: "Mine",
      seeds: ["seed:injected"],
    });
    await expect(
      hostile.origin
        .portability()
        .backup(hostile.projectId)
        .then((backup) => serializePortableProjectArchive(backup.archive)),
    ).rejects.toThrow();
  });
});

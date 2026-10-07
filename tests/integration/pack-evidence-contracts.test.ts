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
import { ProjectDefinitionConflictError } from "@ai-office/application/domain-pack/project-definition.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ProjectPackUpgradeError,
  ReconcileProjectPackUpgrade,
} from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import {
  ProjectConfigurationResolutionError,
  type ResolvedProjectConfiguration,
} from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { StaleProjectPackBindingError } from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import type { OperationProviderCatalog } from "@ai-office/application/ports/operation-provider-catalog.port.ts";
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
const packId = "org.example.legal";

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
    metadata: { name: id, description: "Evidence contract fixture" },
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

// GP-14A: typed artifact types, evidence types and validator references
// through resolution, project definitions, the upgrade plan, the selection
// guard and the portable archive, on SQLite. They are declarations here:
// nothing in this file looks up, registers or runs an adapter.

const documentSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    pages: { type: "integer", minimum: 1 },
  },
  required: ["title"],
};
const findingSchema = {
  type: "object",
  properties: { verified: { type: "boolean" } },
  required: ["verified"],
};
const filing = {
  id: "filing",
  title: "Court filing",
  description: "A document filed with a court",
  mediaTypes: ["application/pdf"],
  maximumBytes: 1_000_000,
  contentSchema: documentSchema,
};
const memo = { id: "memo", title: "Memo" };
const citation = {
  id: "citation-check",
  subject: "filing",
  payloadSchema: findingSchema,
};
const checker = {
  id: "cite-checker",
  title: "Citation checker",
  adapter: { id: "legal.citations", version: "1.0.0" },
  accepts: [{ kind: "artifactTypes", id: "filing" }],
  inputSchema: documentSchema,
  produces: "citation-check",
  outputSchema: findingSchema,
  failurePolicy: "fail_closed",
  timeoutMs: 30_000,
  maxInputBytes: 1_000_000,
  maxOutputBytes: 65_536,
};
const layout = {
  ...checker,
  id: "layout-checker",
  title: "Layout checker",
  adapter: { id: "legal.layout", version: "2.0.0" },
};

function legal(
  version: string,
  contributions: Record<string, unknown[]> = {},
  id = packId,
): Uint8Array {
  return packBytes(
    version,
    {
      artifactTypes: [filing, memo],
      evidenceTypes: [citation],
      validators: [checker],
      ...contributions,
    },
    id,
  );
}

const v1Bytes = legal("1.0.0");
// Adapter version bump: nothing else changes.
const v2Bytes = legal("2.0.0", {
  validators: [
    { ...checker, adapter: { ...checker.adapter, version: "1.1.0" } },
  ],
});
// A declared limit changes.
const v3Bytes = legal("3.0.0", {
  validators: [{ ...checker, timeoutMs: 20_000 }],
});
// A schema changes: the artifact content schema gains a property.
const v4Bytes = legal("4.0.0", {
  artifactTypes: [
    {
      ...filing,
      contentSchema: {
        ...documentSchema,
        properties: { ...documentSchema.properties, court: { type: "string" } },
      },
    },
    memo,
  ],
});
// The validator is removed together with its definition.
const v5Bytes = legal("5.0.0", { validators: [] });
// A second validator is added; the first is unchanged.
const v6Bytes = legal("6.0.0", { validators: [checker, layout] });
// A label gains a typed contract: a contract added to an existing definition.
const v7Bytes = legal("7.0.0", {
  artifactTypes: [filing, { ...memo, mediaTypes: ["text/markdown"] }],
});
// Presentation only.
const v8Bytes = legal("8.0.0", {
  artifactTypes: [
    { ...filing, title: "Filing", description: "Other text" },
    memo,
  ],
  validators: [{ ...checker, title: "Renamed checker" }],
});
// Every typed contract is removed; the definitions stay as labels.
const v9Bytes = legal("9.0.0", {
  artifactTypes: [{ id: "filing", title: "Court filing" }, memo],
  evidenceTypes: [{ id: "citation-check" }],
  validators: [{ id: "cite-checker", title: "Citation checker" }],
});
const manufacturingBytes = packBytes(
  "1.0.0",
  {
    artifactTypes: [
      {
        id: "inspection-record",
        mediaTypes: ["application/json"],
        contentSchema: {
          type: "object",
          properties: {
            lot: { type: "string" },
            measurements: {
              type: "array",
              items: { type: "number" },
              maxItems: 100,
            },
          },
        },
      },
    ],
    evidenceTypes: [{ id: "calibration-proof", subject: "inspection-record" }],
    validators: [
      {
        ...checker,
        id: "tolerance-validator",
        adapter: { id: "mfg.tolerance", version: "2.0.0" },
        accepts: [{ kind: "artifactTypes", id: "inspection-record" }],
        produces: "calibration-proof",
        inputSchema: { type: "boolean" },
        outputSchema: { type: "boolean" },
      },
    ],
  },
  "org.example.plant",
);
const labelsBytes = packBytes(
  "1.0.0",
  {
    artifactTypes: [memo],
    evidenceTypes: [{ id: "note" }],
    validators: [{ id: "reviewer", title: "Label only" }],
  },
  "org.example.labels",
);

const v1 = identityOf(v1Bytes);
const v2 = identityOf(v2Bytes);
const v3 = identityOf(v3Bytes);
const v4 = identityOf(v4Bytes);
const v5 = identityOf(v5Bytes);
const v6 = identityOf(v6Bytes);
const v7 = identityOf(v7Bytes);
const v8 = identityOf(v8Bytes);
const v9 = identityOf(v9Bytes);
const plant = identityOf(manufacturingBytes);
const labels = identityOf(labelsBytes);

const everyArtifact = [
  v1Bytes,
  v2Bytes,
  v3Bytes,
  v4Bytes,
  v5Bytes,
  v6Bytes,
  v7Bytes,
  v8Bytes,
  v9Bytes,
  manufacturingBytes,
  labelsBytes,
];

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
  const root = temporaryRoot("ai-office-gp14a-");
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
      kind: "workflows" | "artifactTypes" | "evidenceTypes" = "workflows",
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

/** Typed members of version 1, as every report states them. */
const filingContract = {
  contractId: pid("artifactTypes", "filing"),
  kind: "artifactTypes",
  mediaTypes: filing.mediaTypes,
  maximumBytes: filing.maximumBytes,
  contentSchema: documentSchema,
};
const citationContract = {
  contractId: pid("evidenceTypes", "citation-check"),
  kind: "evidenceTypes",
  subject: "filing",
  payloadSchema: findingSchema,
};
const checkerContract = (overrides: object = {}) => ({
  contractId: pid("validators", "cite-checker"),
  kind: "validators",
  adapter: checker.adapter,
  accepts: checker.accepts,
  inputSchema: documentSchema,
  produces: "citation-check",
  outputSchema: findingSchema,
  failurePolicy: "fail_closed",
  timeoutMs: 30_000,
  maxInputBytes: 1_000_000,
  maxOutputBytes: 65_536,
  ...overrides,
});

async function resolutionCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectConfigurationResolutionError);
    return (error as ProjectConfigurationResolutionError).code;
  }
  throw new Error("Expected a resolution failure");
}

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

describe("GP-14A resolution and the derived views", () => {
  test("the three views list pack-owned definitions with stable identities and typed members, and a validator is unchecked", async () => {
    const host = await project();
    await host.bind([v1]);
    const view = await host.configuration();
    // GP-06 definition order: by local ID inside one pack and kind.
    expect(view.artifactTypes).toEqual([
      {
        kind: "artifactTypes",
        definitionId: pid("artifactTypes", "filing"),
        effectiveId: effective(v1, "artifactTypes", "filing"),
        origin: "pack_owned",
        title: "Court filing",
        description: "A document filed with a court",
        mediaTypes: filing.mediaTypes,
        maximumBytes: filing.maximumBytes,
        contentSchema: documentSchema,
      },
      {
        kind: "artifactTypes",
        definitionId: pid("artifactTypes", "memo"),
        effectiveId: effective(v1, "artifactTypes", "memo"),
        origin: "pack_owned",
        title: "Memo",
      },
    ]);
    expect(view.evidenceTypes).toEqual([
      {
        kind: "evidenceTypes",
        definitionId: pid("evidenceTypes", "citation-check"),
        effectiveId: effective(v1, "evidenceTypes", "citation-check"),
        origin: "pack_owned",
        subject: "filing",
        payloadSchema: findingSchema,
      },
    ]);
    expect(view.validators).toEqual([
      {
        kind: "validators",
        definitionId: pid("validators", "cite-checker"),
        effectiveId: effective(v1, "validators", "cite-checker"),
        origin: "pack_owned",
        title: "Citation checker",
        registration: "unchecked",
        adapter: checker.adapter,
        accepts: checker.accepts,
        inputSchema: documentSchema,
        produces: "citation-check",
        outputSchema: findingSchema,
        failurePolicy: "fail_closed",
        timeoutMs: 30_000,
        maxInputBytes: 1_000_000,
        maxOutputBytes: 65_536,
      },
    ]);
    // The identities carry no version or digest.
    for (const entry of [
      ...view.artifactTypes,
      ...view.evidenceTypes,
      ...view.validators,
    ])
      expect(entry.definitionId).not.toMatch(/@|#/u);
  });

  test("a label-only validator has no adapter and no registration to report", async () => {
    const host = await project();
    await host.bind([labels]);
    expect((await host.configuration()).validators).toEqual([
      {
        kind: "validators",
        definitionId: pid("validators", "reviewer", labels.id),
        effectiveId: effective(labels, "validators", "reviewer"),
        origin: "pack_owned",
        title: "Label only",
      },
    ]);
  });

  test("the views are derived and outside the version-1 digest material", async () => {
    const host = await project();
    const empty = await host.configuration();
    expect(empty.artifactTypes).toEqual([]);
    expect(empty.evidenceTypes).toEqual([]);
    expect(empty.validators).toEqual([]);
    // The documented empty-input vector is unchanged.
    expect(empty.configurationDigest).toBe(
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    );
    await host.bind([v1]);
    const view = await host.configuration();
    expect(view.configurationDigest).toBe(digestOfMaterial(view));
    // The effective definition, which is digest material, carries the pack's
    // typed members; changing one changes the digest, the views follow it.
    const next = await project();
    await next.bind([v3]);
    expect((await next.configuration()).configurationDigest).not.toBe(
      view.configurationDigest,
    );
  });

  test("legal-like and manufacturing-like packs resolve side by side through a test-supplied catalog", async () => {
    const host = await project();
    await host.bind([v1, plant]);
    const view = await host.configuration();
    expect(view.artifactTypes.map((entry) => entry.definitionId)).toEqual([
      pid("artifactTypes", "filing"),
      pid("artifactTypes", "memo"),
      pid("artifactTypes", "inspection-record", plant.id),
    ]);
    expect(view.validators.map((entry) => entry.adapter?.id)).toEqual([
      "legal.citations",
      "mfg.tolerance",
    ]);
    expect(view.validators.map((entry) => entry.registration)).toEqual([
      "unchecked",
      "unchecked",
    ]);
  });

  test("a validator is never a provider: a registered provider of the same ID does not change `unchecked`", async () => {
    const host = await project();
    await host.bind([v1]);
    const providers = {
      list: () => [
        {
          id: "legal.citations",
          version: "1.0.0",
          operations: [{ operation: "legal.citations.check", mode: "read" }],
        },
      ],
    } satisfies OperationProviderCatalog;
    const view = await new ReadProjectConfiguration({
      projects: host.storage.projects,
      bindings: host.storage.packBindings,
      definitions: host.storage.definitions,
      transactions: host.storage.transactions,
      catalog: catalogOf(...everyArtifact),
      providers,
    }).read("a");
    expect(view.capabilities).toEqual([]);
    expect(view.validators[0]).toMatchObject({ registration: "unchecked" });
    // No provider is required or bound because of a validator reference.
    expect(JSON.stringify(view.capabilities)).not.toContain("legal.citations");
    // And a catalog that offers nothing resolves the same views.
    expect((await host.configuration()).validators).toEqual(view.validators);
  });
});

describe("GP-14A typed members are pack-owned", () => {
  test("a replace or extend keeps the pack's typed members and changes presentation only", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(
      host.mutation(
        v1,
        "filing",
        "replace",
        { id: "filing", title: "Mine" },
        "artifactTypes",
      ),
    );
    await host.mutate(
      host.mutation(
        v1,
        "citation-check",
        "extend",
        { title: "Checked citations" },
        "evidenceTypes",
      ),
    );
    const view = await host.configuration();
    expect(view.artifactTypes[0]).toEqual({
      kind: "artifactTypes",
      definitionId: pid("artifactTypes", "filing"),
      effectiveId: effective(v1, "artifactTypes", "filing"),
      origin: "pack_owned",
      title: "Mine",
      mediaTypes: filing.mediaTypes,
      maximumBytes: filing.maximumBytes,
      contentSchema: documentSchema,
    });
    expect(view.evidenceTypes[0]).toMatchObject({
      title: "Checked citations",
      subject: "filing",
      payloadSchema: findingSchema,
    });
    // The stored override holds no typed member.
    const stored = await host.storage.definitions.get("a");
    expect(JSON.stringify(stored.overrides)).not.toMatch(
      /mediaTypes|contentSchema|payloadSchema/u,
    );
  });

  test("a typed key in a project payload is protected_security_invariant, and nothing is written", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    for (const [kind, localId, key, value] of [
      ["artifactTypes", "filing", "mediaTypes", ["text/plain"]],
      ["artifactTypes", "filing", "maximumBytes", 10],
      ["artifactTypes", "filing", "contentSchema", { type: "boolean" }],
      ["evidenceTypes", "citation-check", "subject", "memo"],
      ["evidenceTypes", "citation-check", "payloadSchema", { type: "boolean" }],
    ] as const) {
      const replace = host.mutation(
        v1,
        localId,
        "replace",
        { id: localId, [key]: value },
        kind,
      );
      const extend = host.mutation(
        v1,
        localId,
        "extend",
        { [key]: value },
        kind,
      );
      const owned = {
        action: "put_owned",
        kind,
        id: "mine",
        enabled: true,
        payload: { id: "mine", [key]: value },
      };
      for (const mutation of [replace, extend, owned])
        expect([
          kind,
          key,
          (await conflict(host.mutate(mutation))).code,
        ]).toEqual([kind, key, "protected_security_invariant"]);
    }
    expect(await host.authority()).toEqual(before);
  });

  test("validators stay unsupported for every project operation, and a type cannot be disabled", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    for (const operation of ["replace", "extend", "disable"] as const)
      expect(
        await conflict(
          host.mutate(
            host.mutation(
              v1,
              "cite-checker",
              operation,
              operation === "disable"
                ? undefined
                : { id: "cite-checker", title: "Weaker" },
              "validators",
            ),
          ),
        ),
      ).toMatchObject({ code: "unsupported_override_operation" });
    expect(
      (
        await conflict(
          host.mutate({
            action: "put_owned",
            kind: "validators",
            id: "mine",
            enabled: true,
            payload: { id: "mine" },
          }),
        )
      ).code,
    ).toBe("protected_security_invariant");
    for (const [kind, localId] of [
      ["artifactTypes", "filing"],
      ["evidenceTypes", "citation-check"],
    ] as const)
      expect(
        await conflict(
          host.mutate(host.mutation(v1, localId, "disable", undefined, kind)),
        ),
      ).toMatchObject({ code: "unsupported_override_operation" });
    expect(await host.authority()).toEqual(before);
  });

  test("stored state of kind validators is rejected by storage, and a malformed stored payload fails closed at resolution", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    const stored = await host.storage.definitions.get("a");
    await expect(
      host.storage.definitions.replace(
        {
          ...stored,
          overrides: [
            {
              origin: "project_override",
              source: { ...v1, kind: "validators", localId: "cite-checker" },
              operation: "disable",
              revision: 1,
              actorId: "operator",
              changedAt: now.toISOString(),
            },
          ],
        },
        stored.revision,
        now,
      ),
    ).rejects.toThrow();
    expect(await host.authority()).toEqual(before);

    // A replacement that arrived without the pre-store check and carries a
    // typed key is never applied: resolution fails closed.
    await host.storeOverride(
      v1,
      "filing",
      { id: "filing", mediaTypes: ["text/plain"] },
      "a",
      "artifactTypes",
    );
    expect(await resolutionCode(host.configuration())).toBe(
      "unresolved_override",
    );
  });
});

/** The approval token, recomputed from every other field of the plan. */
function planDigestOf<T extends { planDigest: string }>(plan: T): string {
  const { planDigest: _planDigest, ...rest } = plan;
  return `sha256:${createHash("sha256")
    .update("ai-office-pack-upgrade-plan-v1\n", "utf8")
    .update(canonicalizeJcsJson(rest as never), "utf8")
    .digest("hex")}`;
}

describe("GP-14A contract changes in the upgrade plan", () => {
  test("an adapter version bump is reported under planDigest, and the audit event records identities, adapter, version and failure policy without a body", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(
      host.mutation(
        v1,
        "memo",
        "extend",
        { description: "Project-only wording" },
        "artifactTypes",
      ),
    );
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.evidenceContractChanges).toEqual({
      availability: "available",
      changes: [
        {
          contractId: pid("validators", "cite-checker"),
          change: "changed",
          before: checkerContract(),
          after: checkerContract({
            adapter: { id: "legal.citations", version: "1.1.0" },
          }),
        },
      ],
    });
    expect(plan.targetEvidenceContracts).toEqual([
      filingContract,
      citationContract,
      checkerContract({ adapter: { id: "legal.citations", version: "1.1.0" } }),
    ]);
    expect(plan.planDigest).toBe(planDigestOf(plan));
    // Both fields are approval material.
    expect(
      planDigestOf({
        ...plan,
        evidenceContractChanges: {
          ...plan.evidenceContractChanges,
          changes: [],
        },
      }),
    ).not.toBe(plan.planDigest);
    expect(planDigestOf({ ...plan, targetEvidenceContracts: [] })).not.toBe(
      plan.planDigest,
    );

    const applied = await host.upgrade().apply({
      projectId: "a",
      desired: [v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "approver",
    });
    expect(applied.result).toBe("applied");
    const events = host.audits("project.pack_upgrade_applied");
    expect(events).toHaveLength(1);
    const adapterOf = (version: string) => ({
      id: "legal.citations",
      version,
    });
    expect(events[0]).toMatchObject({
      planDigest: plan.planDigest,
      evidenceContractChanges: {
        availability: "available",
        changes: [
          {
            contractId: pid("validators", "cite-checker"),
            change: "changed",
            before: {
              contractId: pid("validators", "cite-checker"),
              kind: "validators",
              adapter: adapterOf("1.0.0"),
              failurePolicy: "fail_closed",
            },
            after: {
              contractId: pid("validators", "cite-checker"),
              kind: "validators",
              adapter: adapterOf("1.1.0"),
              failurePolicy: "fail_closed",
            },
          },
        ],
      },
      targetEvidenceContracts: [
        { contractId: pid("artifactTypes", "filing"), kind: "artifactTypes" },
        {
          contractId: pid("evidenceTypes", "citation-check"),
          kind: "evidenceTypes",
        },
        {
          contractId: pid("validators", "cite-checker"),
          kind: "validators",
          adapter: adapterOf("1.1.0"),
          failurePolicy: "fail_closed",
        },
      ],
    });
    // No schema body, limit, media type or text reaches the audit trail.
    const recorded = JSON.stringify(events[0]);
    for (const body of [
      "Court filing",
      "Citation checker",
      "A document filed with a court",
      "Project-only wording",
      "application/pdf",
      "minLength",
      "verified",
      "inputSchema",
      "outputSchema",
      "contentSchema",
      "timeoutMs",
      "maxInputBytes",
      "30000",
      "1000000",
    ])
      expect([body, recorded.includes(body)]).toEqual([body, false]);
    expect((await host.configuration()).validators[0]).toMatchObject({
      adapter: adapterOf("1.1.0"),
      registration: "unchecked",
    });
  });

  test.each([
    {
      name: "a changed limit",
      target: v3,
      after: checkerContract({ timeoutMs: 20_000 }),
      before: checkerContract(),
      id: pid("validators", "cite-checker"),
    },
    {
      name: "a changed schema",
      target: v4,
      before: filingContract,
      after: {
        ...filingContract,
        contentSchema: {
          ...documentSchema,
          properties: {
            ...documentSchema.properties,
            court: { type: "string" },
          },
        },
      },
      id: pid("artifactTypes", "filing"),
    },
  ])("$name is reported as changed", async ({ target, before, after, id }) => {
    const host = await project();
    await host.bind([v1]);
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [target] });
    expect(plan.evidenceContractChanges).toEqual({
      availability: "available",
      changes: [{ contractId: id, change: "changed", before, after }],
    });
  });

  test("added, removed and relabelled contracts are reported; presentation alone is not a contract change", async () => {
    const host = await project();
    await host.bind([v1]);
    const changes = async (desired: PackIdentity) => {
      const plan = await host
        .upgrade()
        .preview({ projectId: "a", desired: [desired] });
      expect(plan.evidenceContractChanges.availability).toBe("available");
      return "changes" in plan.evidenceContractChanges
        ? plan.evidenceContractChanges.changes.map((change) => [
            change.contractId,
            change.change,
          ])
        : [];
    };
    expect(await changes(v5)).toEqual([
      [pid("validators", "cite-checker"), "removed"],
    ]);
    expect(await changes(v6)).toEqual([
      [pid("validators", "layout-checker"), "added"],
    ]);
    expect(await changes(v7)).toEqual([
      [pid("artifactTypes", "memo"), "added"],
    ]);
    expect(await changes(v8)).toEqual([]);
    expect(await changes(v9)).toEqual([
      [pid("artifactTypes", "filing"), "removed"],
      [pid("evidenceTypes", "citation-check"), "removed"],
      [pid("validators", "cite-checker"), "removed"],
    ]);
  });

  test("a no-op plan carries both fields empty and reads no artifact", async () => {
    const host = await project();
    await host.bind([v1]);
    const plan = await host
      .upgrade(new InMemoryInstalledDomainPackCatalog(1, []))
      .preview({ projectId: "a", desired: [v1] });
    expect(plan).toMatchObject({
      noop: true,
      evidenceContractChanges: { availability: "available", changes: [] },
      targetEvidenceContracts: [],
    });
    expect(plan.planDigest).toBe(planDigestOf(plan));
  });

  test("contract changes are unavailable when the previous artifacts are not installed, and approval still binds the target contracts", async () => {
    const host = await project();
    await host.bind([v1]);
    const plan = await host
      .upgrade(catalogOf(v2Bytes))
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.evidenceContractChanges).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    expect(plan.evidenceContractChanges).toEqual(plan.policyChanges);
    expect(plan.targetEvidenceContracts).toHaveLength(3);
    expect(plan.issues).toEqual([]);
    expect(plan.planDigest).toBe(planDigestOf(plan));
  });

  test("a stale plan cannot be applied after the contracts it reported moved on", async () => {
    const host = await project();
    await host.bind([v1]);
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v2] });
    const before = await host.authority();
    await expect(
      host.upgrade().apply({
        projectId: "a",
        desired: [v3],
        approvedPlanDigest: plan.planDigest,
        actorId: "approver",
      }),
    ).rejects.toBeInstanceOf(ProjectPackUpgradeError);
    expect(await host.authority()).toEqual(before);
    // Neither is a plan for packs that are no longer installed applied.
    await expect(
      host.upgrade(catalogOf(v1Bytes)).apply({
        projectId: "a",
        desired: [v2],
        approvedPlanDigest: plan.planDigest,
        actorId: "approver",
      }),
    ).rejects.toBeInstanceOf(ProjectPackUpgradeError);
    expect(await host.authority()).toEqual(before);
  });
});

describe("GP-14A project:pack:apply refuses a contract change of an existing definition", () => {
  const refusal = (id: string) => ({
    code: "evidence_contract_change_requires_upgrade",
    message: `The selection changes the contract of ${id}; review and approve it with project:pack:upgrade`,
  });
  const apply = (
    host: Awaited<ReturnType<typeof project>>,
    desired: PackIdentity[],
    expectedRevision: number,
    service = host.binding(),
  ) =>
    service.apply({
      projectId: "a",
      desired,
      expectedRevision,
      actorId: "local-operator",
    });

  test.each([
    {
      name: "an adapter version bump",
      target: v2,
      id: pid("validators", "cite-checker"),
      change: "changed",
    },
    {
      name: "a changed limit",
      target: v3,
      id: pid("validators", "cite-checker"),
      change: "changed",
    },
    {
      name: "a changed schema",
      target: v4,
      id: pid("artifactTypes", "filing"),
      change: "changed",
    },
    {
      name: "a contract added to an existing label",
      target: v7,
      id: pid("artifactTypes", "memo"),
      change: "added",
    },
    {
      name: "every contract removed from definitions that stay",
      target: v9,
      id: pid("artifactTypes", "filing"),
      change: "removed",
    },
  ])(
    "$name is reported by preview and refused by apply with the typed error; nothing is written",
    async ({ target, id, change }) => {
      const host = await project();
      await apply(host, [v1], 0);
      const before = await host.authority();
      const preview = await host.binding().preview("a", [target]);
      expect(preview.evidenceContractChanges).toMatchObject({
        availability: "available",
        changes: expect.arrayContaining([
          expect.objectContaining({ contractId: id, change }),
        ]),
      });
      expect(preview.issues).toEqual([refusal(id)]);
      const refused = await apply(host, [target], 1).catch((error) => error);
      expect(refused).toBeInstanceOf(ProjectPackBindingRefusedError);
      expect(refused).toMatchObject(refusal(id));
      expect(await host.authority()).toEqual(before);
      expect(host.audits("project.pack_binding_applied")).toHaveLength(1);
    },
  );

  test("adding and removing a pack, and a version that leaves every existing definition's contract unchanged, are still applied", async () => {
    const host = await project();
    // Addition of a pack with contracts to an empty selection.
    const first = await host.binding().preview("a", [v1]);
    expect(first.issues).toEqual([]);
    expect(first.evidenceContractChanges).toMatchObject({
      availability: "available",
      changes: [
        { contractId: pid("artifactTypes", "filing"), change: "added" },
        { contractId: pid("evidenceTypes", "citation-check"), change: "added" },
        { contractId: pid("validators", "cite-checker"), change: "added" },
      ],
    });
    await apply(host, [v1], 0);
    // A pack added beside it, and then removed again.
    await apply(host, [v1, plant], 1);
    await apply(host, [v1], 2);
    // A version that changes presentation only.
    expect((await host.binding().preview("a", [v8])).issues).toEqual([]);
    await apply(host, [v8], 3);
    expect(await host.storage.packBindings.get("a")).toMatchObject({
      configurationRevision: 4,
      packs: [v8],
    });
    // The empty selection is a removal and is applied.
    await apply(host, [], 4);
    expect((await host.configuration()).validators).toEqual([]);
  });

  test("a changed selection that only adds or removes definitions is applied", async () => {
    for (const target of [v5, v6]) {
      const host = await project();
      await apply(host, [v1], 0);
      expect((await host.binding().preview("a", [target])).issues).toEqual([]);
      await apply(host, [target], 1);
      expect(await host.storage.packBindings.get("a")).toMatchObject({
        configurationRevision: 2,
        packs: [target],
      });
    }
  });

  test("a stale revision is refused before anything else, and an unchanged selection reads no artifact", async () => {
    const host = await project();
    await apply(host, [v1], 0);
    const before = await host.authority();
    await expect(apply(host, [v2], 0)).rejects.toBeInstanceOf(
      StaleProjectPackBindingError,
    );
    expect(await host.authority()).toEqual(before);
    const preview = await host.binding().preview("a", [v1]);
    expect(preview.evidenceContractChanges).toEqual({
      availability: "available",
      changes: [],
    });
    const empty = new InMemoryInstalledDomainPackCatalog(1, []);
    expect(await apply(host, [v1], 1, host.binding(empty))).toMatchObject({
      configurationRevision: 1,
    });
  });

  test("contracts are unavailable when the current artifacts are not installed, and the GP-11 rule still refuses the change", async () => {
    const host = await project();
    await apply(host, [v1], 0);
    const onlyTarget = catalogOf(v2Bytes);
    const preview = await host.binding(onlyTarget).preview("a", [v2]);
    expect(preview.evidenceContractChanges).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    expect(preview.issues.map((issue) => issue.code)).toEqual([
      "role_capability_change_requires_upgrade",
    ]);
    await expect(
      apply(host, [v2], 1, host.binding(onlyTarget)),
    ).rejects.toBeInstanceOf(ProjectPackBindingRefusedError);
    expect(await host.storage.packBindings.get("a")).toMatchObject({
      configurationRevision: 1,
      packs: [v1],
    });
  });

  test("the evidence refusal is listed after the policy refusal", async () => {
    const governed = (version: string, operations: string[], timeout: number) =>
      packBytes(
        version,
        {
          roles: [{ id: "counsel" }],
          taskTypes: [{ id: "matter" }],
          workflows: [
            {
              id: "sign-off",
              taskType: "matter",
              stages: [{ id: "sign", role: "counsel" }],
            },
          ],
          policies: [
            {
              id: "sign-off-governance",
              workflow: "sign-off",
              stages: [{ stage: "sign", operations }],
            },
          ],
          artifactTypes: [{ id: "filing", maximumBytes: timeout }],
        },
        "org.example.both",
      );
    const firstBytes = governed("1.0.0", ["a"], 10);
    const secondBytes = governed("2.0.0", ["a", "b"], 20);
    const first = identityOf(firstBytes);
    const second = identityOf(secondBytes);
    const host = await project(firstBytes, secondBytes);
    await apply(host, [first], 0);
    const preview = await host.binding().preview("a", [second]);
    expect(preview.issues.map((issue) => issue.code)).toEqual([
      "policy_change_requires_upgrade",
      "evidence_contract_change_requires_upgrade",
    ]);
    await expect(apply(host, [second], 1)).rejects.toMatchObject({
      code: "policy_change_requires_upgrade",
    });
  });
});

describe("GP-14A creates nothing in the Runtime", () => {
  test("binding and resolving typed definitions on the GP-09 fixture leaves run, approval and job tables identical", async () => {
    const database = loadPrePackFixture(temporaryRoot("ai-office-gp14a-gp09-"));
    databases.push(database);
    migrate(database, projectMigrations);
    const stores = legacyStores(
      database,
      new TickingClock("2026-10-07T00:00:00.000Z"),
      new SequenceIds("gp14a"),
    );
    // A copy of the development reference pack with typed definitions; the
    // committed pack is not edited by this task.
    const bytes = mutatedDevelopmentPackBytes((manifest) => {
      const contributions = manifest.contributions as Record<string, unknown[]>;
      contributions.artifactTypes = [filing];
      contributions.evidenceTypes = [citation];
      contributions.validators = [checker];
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
      actorId: "gp14a-test",
    });
    const resolved = await new ReadProjectConfiguration({
      projects: stores.projects,
      bindings,
      definitions,
      transactions: stores.transactions,
      catalog,
    }).read(legacyProjectId);
    expect(resolved.validators.map((entry) => entry.definitionId)).toEqual([
      "pack:org.ai-office.development/validators/cite-checker",
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

describe("GP-14A portable archive and restore", () => {
  /** A source host without installed packs: state that passed no check. */
  async function archiveOf(pack: PackIdentity) {
    const origin = runtime(new InMemoryInstalledDomainPackCatalog(1, []));
    const source = temporaryRoot("ai-office-gp14a-source-");
    writeFileSync(join(source, "package.json"), '{"name":"gp14a"}\n');
    const imported = await origin.importProject(source);
    await origin.bind([pack], imported.projectId);
    const backup = await origin.portability().backup(imported.projectId);
    return parsePortableProjectArchive(
      serializePortableProjectArchive(backup.archive),
    );
  }

  function restoreTarget(): string {
    const target = temporaryRoot("ai-office-gp14a-target-");
    writeFileSync(join(target, "package.json"), '{"name":"gp14a"}\n');
    return target;
  }

  test("a project bound to a pack with typed definitions is archived at the format it had before, and restores", async () => {
    const typed = await archiveOf(v1);
    const plain = await archiveOf(labels);
    expect(typed.manifest.formatVersion).toBe(plain.manifest.formatVersion);
    expect(typed.manifest.formatVersion).toBe(
      portableProjectDefinitionFormatVersion,
    );
    expect(typed.manifest.contents).toEqual(plain.manifest.contents);
    // The archive names the pack tuple and nothing of its contracts.
    expect(
      JSON.stringify([typed.state.packBinding, typed.state.definitions]),
    ).not.toMatch(/cite-checker|adapter|mediaTypes|schema/iu);
    const host = runtime(catalogOf(v1Bytes));
    const restored = await host
      .portability()
      .restore({ archive: typed, rootPath: restoreTarget() });
    expect(restored.outcome).toBe("restored");
    const view = await host.configuration(restored.projectId);
    expect(view.validators.map((entry) => entry.definitionId)).toEqual([
      pid("validators", "cite-checker"),
    ]);
  });

  test("restoring onto a host without the pack succeeds, and resolution fails closed until it is installed", async () => {
    const archive = await archiveOf(v1);
    const host = runtime(catalogOf(v2Bytes));
    const restored = await host
      .portability()
      .restore({ archive, rootPath: restoreTarget() });
    expect(restored.outcome).toBe("restored");
    expect(await resolutionCode(host.configuration(restored.projectId))).toBe(
      "pack_unavailable",
    );
    expect(
      (
        await host.configuration(
          restored.projectId,
          catalogOf(v1Bytes, v2Bytes),
        )
      ).validators,
    ).toHaveLength(1);
  });
});

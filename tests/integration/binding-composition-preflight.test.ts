import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import {
  ManageProjectPackBinding,
  ProjectPackBindingCollisionError,
  ProjectPackBindingRefusedError,
} from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ManageProjectPortability,
  ProjectPortabilityError,
  ProjectRestoreCompositionError,
} from "@ai-office/application/project-portability/manage-project-portability.ts";
import {
  parsePortableProjectArchive,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import type { ContributionKind } from "../../packages/domain-pack-contracts/src/index.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { LocalProjectBindingAdapter } from "@ai-office/runtime-host/local-project-binding-adapter.ts";
import { LocalProjectScanner } from "@ai-office/runtime-host/local-project-scanner.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const now = new Date("2026-10-06T00:00:00.000Z");
const encoder = new TextEncoder();
const collisionCode = "pack_definition_collision";

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Exact bytes of one schema-1 manifest with a computed digest. */
function packBytes(
  id: string,
  version: string,
  contributions: Record<string, unknown[]>,
  dependencies: PackIdentity[] = [],
): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: id, description: "Composition preflight fixture" },
    dependencies,
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

const capabilities = [{ id: "draft" }, { id: "sign" }];
// legal@1 contributes roles/counsel and taskTypes/matter.
const legalBytes = packBytes("org.example.legal", "1.0.0", {
  roles: [{ id: "counsel", capabilities: ["draft"] }],
  taskTypes: [{ id: "matter" }],
  capabilities,
});
const legal = identityOf(legalBytes);
// legal@2 changes counsel's capability set and adds roles/auditor.
const legalV2Bytes = packBytes("org.example.legal", "2.0.0", {
  roles: [
    { id: "counsel", capabilities: ["draft", "sign"] },
    { id: "auditor" },
  ],
  taskTypes: [{ id: "matter" }],
  capabilities,
});
const legalV2 = identityOf(legalV2Bytes);
// dependent selects legal@1 only as a dependency and adds prompts/greeting.
const dependentBytes = packBytes(
  "org.example.dependent",
  "1.0.0",
  { prompts: [{ id: "greeting" }] },
  [legal],
);
const dependent = identityOf(dependentBytes);
const customBytes = packBytes("org.example.custom", "1.0.0", {});
const custom = identityOf(customBytes);

function catalogOf(...artifacts: Uint8Array[]) {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const install = (bytes: Uint8Array) =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "fixture" },
    });
  for (const bytes of artifacts) install(bytes);
  return { catalog, install };
}

/** Counts catalog reads, and those made while `inside()` is true. */
function observed(
  catalog: InstalledDomainPackCatalog,
  inside: () => boolean = () => false,
) {
  const reads = { total: 0, inside: 0 };
  const proxy: InstalledDomainPackCatalog = {
    coreContractVersion: catalog.coreContractVersion,
    list: () => catalog.list(),
    trusts: (provenance) => catalog.trusts(provenance),
    read: (id, version) => {
      reads.total += 1;
      if (inside()) reads.inside += 1;
      return catalog.read(id, version);
    },
  };
  return { proxy, reads };
}

class ExactTestRootBindingAdapter extends LocalProjectBindingAdapter {
  override async resolveProjectRoot(inputPath: string): Promise<string> {
    // Fixture roots are standalone even if the host has an unrelated ancestor .git.
    return realpathSync(inputPath);
  }
}

type Owned = readonly [kind: ContributionKind, id: string, enabled?: boolean];

function runtime(catalog: InstalledDomainPackCatalog) {
  const root = temporaryRoot("ai-office-gp22-");
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const profiles = new SqliteProjectProfileRepository(database);
  const identities = new SqliteRepositoryIdentityRepository(database);
  const states = new SqliteProjectStateRepository(database);
  let sequence = 0;
  const ids = { generate: () => `id-${++sequence}` };
  const clock = { now: () => now };
  const binding = (
    selected: InstalledDomainPackCatalog = catalog,
    transactions: TransactionRunner = storage.transactions,
  ) =>
    new ManageProjectPackBinding({
      projects: storage.projects,
      bindings: storage.packBindings,
      definitions: storage.definitions,
      catalog: selected,
      auditEvents: storage.auditEvents,
      transactions,
      clock,
      ids,
    });
  const portability = (selected: InstalledDomainPackCatalog = catalog) =>
    new ManageProjectPortability({
      projects: storage.projects,
      profiles,
      identities,
      states,
      bindings: new ExactTestRootBindingAdapter(),
      scanner: new LocalProjectScanner(),
      transactions: storage.transactions,
      ids,
      clock,
      catalog: selected,
    });
  const reader = (selected: InstalledDomainPackCatalog = catalog) =>
    new ReadProjectConfiguration({
      projects: storage.projects,
      bindings: storage.packBindings,
      definitions: storage.definitions,
      catalog: selected,
      transactions: storage.transactions,
    });
  /** Writes the selection directly, as state that did not pass a preflight. */
  const bind = async (projectId: string, packs: PackIdentity[]) => {
    await storage.packBindings.replace(
      projectId,
      (await storage.packBindings.get(projectId)).configurationRevision,
      packs,
      now,
    );
  };
  const own = async (projectId: string, entries: readonly Owned[]) => {
    const current = await storage.definitions.get(projectId);
    await storage.definitions.replace(
      {
        ...current,
        owned: entries.map(([kind, id, enabled = true]) => ({
          origin: "project_owned" as const,
          kind,
          id,
          revision: 1,
          enabled,
          payload: { id },
          actorId: "operator",
          changedAt: now.toISOString(),
        })),
      },
      current.revision,
      now,
    );
  };
  const count = (sql: string) =>
    database.query<{ count: number }, []>(sql).get()!.count;
  return {
    database,
    storage,
    profiles,
    identities,
    states,
    binding,
    portability,
    reader,
    bind,
    own,
    writes: () => count("SELECT total_changes() AS count"),
    bindingAudits: () =>
      count(
        "SELECT count(*) AS count FROM audit_event WHERE event_type='project.pack_binding_applied'",
      ),
    importProject: (rootPath: string) =>
      new ImportProject(
        storage.projects,
        profiles,
        new LocalProjectScanner(),
        identities,
        ids,
        clock,
        storage.transactions,
      ).execute({ rootPath }),
  };
}

async function projectRuntime(...artifacts: Uint8Array[]) {
  const { catalog, install } = catalogOf(...artifacts);
  const host = runtime(catalog);
  await host.storage.projects.save(Project.create({ id: "a", name: "A", now }));
  const apply = (
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
  return { ...host, catalog, install, apply };
}

const collision = (
  kind: string,
  id: string,
  pack = "org.example.legal@1.0.0",
) => ({
  code: collisionCode,
  message: `Project definition ${kind}/${id} collides with pack ${pack} in the proposed pack closure`,
});

describe("GP-22 binding composition preflight: project:pack:preview and project:pack:apply", () => {
  test("a direct selected-pack collision is rejected by preview and apply with pack_definition_collision and writes nothing", async () => {
    const host = await projectRuntime(legalBytes, customBytes);
    try {
      // A disabled project-owned definition still owns its identity.
      for (const enabled of [true, false]) {
        await host.own("a", [["roles", "counsel", enabled]]);
        const before = host.writes();
        const preview = await host.binding().preview("a", [legal]);
        expect(preview.issues, String(enabled)).toEqual([
          collision("roles", "counsel"),
        ]);
        expect(preview).toMatchObject({
          current: { configurationRevision: 0, packs: [] },
          added: [legal],
        });
        const rejected = await host.apply([legal], 0).catch((error) => error);
        expect(rejected).toBeInstanceOf(ProjectPackBindingCollisionError);
        expect(rejected).toMatchObject(collision("roles", "counsel"));
        // The same selection with an unrelated pack collides just the same.
        await expect(host.apply([custom, legal], 0)).rejects.toMatchObject(
          collision("roles", "counsel"),
        );
        expect(host.writes()).toBe(before);
        expect(await host.storage.packBindings.get("a")).toMatchObject({
          configurationRevision: 0,
          packs: [],
        });
        expect(host.bindingAudits()).toBe(0);
      }
      // Every colliding definition is reported, in kind then local-ID order.
      await host.own("a", [
        ["taskTypes", "matter"],
        ["roles", "counsel"],
        ["roles", "other"],
      ]);
      expect((await host.binding().preview("a", [legal])).issues).toEqual([
        collision("roles", "counsel"),
        collision("taskTypes", "matter"),
      ]);
      await expect(host.apply([legal], 0)).rejects.toMatchObject(
        collision("roles", "counsel"),
      );
      // The preflight never emits GP-06's backstop code.
      expect(
        (await host.binding().preview("a", [legal])).issues.map(
          (issue) => issue.code,
        ),
      ).not.toContain("duplicate_effective_definition");
    } finally {
      host.database.close();
    }
  });

  test("a collision introduced by a transitive dependency is rejected", async () => {
    const host = await projectRuntime(legalBytes, dependentBytes);
    try {
      await host.own("a", [["roles", "counsel"]]);
      const before = host.writes();
      // `dependent` contributes no role; legal@1 enters only as its dependency.
      expect((await host.binding().preview("a", [dependent])).issues).toEqual([
        collision("roles", "counsel"),
      ]);
      const rejected = await host.apply([dependent], 0).catch((error) => error);
      expect(rejected).toBeInstanceOf(ProjectPackBindingCollisionError);
      expect(rejected).toMatchObject(collision("roles", "counsel"));
      expect(host.writes()).toBe(before);
      expect(await host.storage.packBindings.get("a")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      expect(host.bindingAudits()).toBe(0);
      // The selected pack's own definition collides as well.
      await host.own("a", [["prompts", "greeting"]]);
      expect((await host.binding().preview("a", [dependent])).issues).toEqual([
        collision("prompts", "greeting", "org.example.dependent@1.0.0"),
      ]);
    } finally {
      host.database.close();
    }
  });

  test("a different kind with the same local ID and a different case are not collisions", async () => {
    const host = await projectRuntime(legalBytes, dependentBytes);
    try {
      await host.own("a", [
        ["taskTypes", "counsel"],
        ["roles", "matter"],
        ["roles", "Counsel"],
        ["roles", "COUNSEL"],
        ["prompts", "Greeting"],
        ["knowledge", "counsel"],
      ]);
      expect((await host.binding().preview("a", [dependent])).issues).toEqual(
        [],
      );
      expect(await host.apply([dependent], 0)).toMatchObject({
        configurationRevision: 1,
        packs: [dependent],
      });
      expect(host.bindingAudits()).toBe(1);
      const resolved = await host.reader().read("a");
      expect(
        resolved.projectOwnedDefinitions.map((item) => item.effectiveId),
      ).toEqual([
        "project:knowledge/counsel",
        "project:prompts/Greeting",
        "project:roles/COUNSEL",
        "project:roles/Counsel",
        "project:roles/matter",
        "project:taskTypes/counsel",
      ]);
    } finally {
      host.database.close();
    }
  });

  test("removal and replacement stay possible, and a replacement that still collides is rejected", async () => {
    const host = await projectRuntime(legalBytes, dependentBytes, customBytes);
    try {
      // A latent collision that did not pass a preflight.
      await host.bind("a", [legal]);
      await host.own("a", [["roles", "counsel"]]);
      // Replacing the colliding pack by one that still brings legal@1 in.
      expect((await host.binding().preview("a", [dependent])).issues).toEqual([
        collision("roles", "counsel"),
      ]);
      await expect(host.apply([dependent], 1)).rejects.toMatchObject(
        collision("roles", "counsel"),
      );
      await expect(host.apply([custom, legal], 1)).rejects.toMatchObject(
        collision("roles", "counsel"),
      );
      expect(await host.storage.packBindings.get("a")).toMatchObject({
        configurationRevision: 1,
        packs: [legal],
      });
      // Replacing it by a pack that does not collide resolves the conflict.
      expect((await host.binding().preview("a", [custom])).issues).toEqual([]);
      expect(await host.apply([custom], 1)).toMatchObject({
        configurationRevision: 2,
        packs: [custom],
      });
      expect(
        (await host.reader().read("a")).projectOwnedDefinitions,
      ).toHaveLength(1);
      // Removing every pack is always possible.
      await host.bind("a", [legal]);
      await expect(host.reader().read("a")).rejects.toMatchObject({
        code: "duplicate_effective_definition",
      });
      expect((await host.binding().preview("a", [])).issues).toEqual([]);
      expect(await host.apply([], 3)).toMatchObject({
        configurationRevision: 4,
        packs: [],
      });
      // Once the project definition is gone the pack can be selected.
      await host.own("a", []);
      expect(await host.apply([legal], 4)).toMatchObject({
        configurationRevision: 5,
        packs: [legal],
      });
    } finally {
      host.database.close();
    }
  });

  test("applying the unchanged active selection stays a no-op: no resolution, no preflight, no revision increment, no audit event", async () => {
    const host = await projectRuntime(legalBytes);
    try {
      await host.bind("a", [legal]);
      await host.own("a", [["roles", "counsel"]]);
      const watched = observed(host.catalog);
      expect(await host.apply([legal], 1, host.binding(watched.proxy))).toEqual(
        await host.storage.packBindings.get("a"),
      );
      expect(watched.reads.total).toBe(0);
      // Also when the artifacts are not installed at all.
      const empty = new InMemoryInstalledDomainPackCatalog(1, []);
      expect(await host.apply([legal], 1, host.binding(empty))).toMatchObject({
        configurationRevision: 1,
        packs: [legal],
      });
      expect(await host.storage.packBindings.get("a")).toMatchObject({
        configurationRevision: 1,
        packs: [legal],
      });
      expect(host.bindingAudits()).toBe(0);
      // The latent collision stays visible through preview and GP-06.
      expect(await host.binding().preview("a", [legal])).toMatchObject({
        added: [],
        removed: [],
        changed: [],
        issues: [collision("roles", "counsel")],
      });
      await expect(host.reader().read("a")).rejects.toMatchObject({
        code: "duplicate_effective_definition",
      });
      // A stale revision still fails before the no-op.
      await expect(host.apply([legal], 0)).rejects.toThrow("stale");
    } finally {
      host.database.close();
    }
  });

  test("a project-owned definition written between preflight and commit is caught inside the transaction, without reading the catalog there", async () => {
    const host = await projectRuntime(legalBytes, dependentBytes);
    try {
      let inside = false;
      const watched = observed(host.catalog, () => inside);
      const racing: TransactionRunner = {
        run: async (work) => {
          // The preflight has passed; a definition lands before the commit.
          await host.own("a", [["roles", "counsel"]]);
          return host.storage.transactions.run(async () => {
            inside = true;
            try {
              return await work();
            } finally {
              inside = false;
            }
          });
        },
      };
      expect(
        (await host.binding(watched.proxy).preview("a", [dependent])).issues,
      ).toEqual([]);
      const rejected = await host
        .apply([dependent], 0, host.binding(watched.proxy, racing))
        .catch((error) => error);
      expect(rejected).toBeInstanceOf(ProjectPackBindingCollisionError);
      expect(rejected).toMatchObject(collision("roles", "counsel"));
      expect(watched.reads.total).toBeGreaterThan(0);
      expect(watched.reads.inside).toBe(0);
      expect(await host.storage.packBindings.get("a")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      expect(host.bindingAudits()).toBe(0);
      expect((await host.storage.definitions.get("a")).owned).toHaveLength(1);
      // The compare-and-set on the binding revision is kept.
      await host.own("a", []);
      const stale: TransactionRunner = {
        run: async (work) => {
          await host.bind("a", [legal]);
          return host.storage.transactions.run(work);
        },
      };
      await expect(
        host.apply([dependent], 0, host.binding(host.catalog, stale)),
      ).rejects.toThrow("stale");
    } finally {
      host.database.close();
    }
  });

  test("GP-04 availability is reported first and alone; a collision is reported before the GP-11 capability refusal", async () => {
    const host = await projectRuntime(legalBytes, legalV2Bytes);
    try {
      await host.bind("a", [legal]);
      await host.own("a", [["roles", "auditor"]]);
      const refusal = {
        code: "role_capability_change_requires_upgrade",
        message:
          "The selection changes the capabilities of role pack:org.example.legal/roles/counsel; review and approve it with project:pack:upgrade",
      };
      const both = [
        collision("roles", "auditor", "org.example.legal@2.0.0"),
        refusal,
      ];
      // legal@2 both collides with roles/auditor and changes counsel's set.
      const preview = await host.binding().preview("a", [legalV2]);
      expect(preview.issues).toEqual(both);
      expect(preview.roleCapabilityChanges).toMatchObject({
        availability: "available",
      });
      const rejected = await host.apply([legalV2], 1).catch((error) => error);
      expect(rejected).toBeInstanceOf(ProjectPackBindingCollisionError);
      expect(rejected).toMatchObject(both[0]!);
      // Without the collision the GP-11 refusal is unchanged.
      await host.own("a", []);
      expect((await host.binding().preview("a", [legalV2])).issues).toEqual([
        refusal,
      ]);
      const refused = await host.apply([legalV2], 1).catch((error) => error);
      expect(refused).toBeInstanceOf(ProjectPackBindingRefusedError);
      expect(refused).toMatchObject(refusal);

      // The current closure cannot be resolved: GP-11 refuses anything but a
      // pure removal, and the collision is still reported first.
      await host.own("a", [["roles", "auditor"]]);
      const onlyV2 = catalogOf(legalV2Bytes, customBytes).catalog;
      const unresolved = await host.binding(onlyV2).preview("a", [legalV2]);
      expect(unresolved.issues.map((issue) => issue.code)).toEqual([
        collisionCode,
        "role_capability_change_requires_upgrade",
      ]);
      expect(unresolved.roleCapabilityChanges).toMatchObject({
        availability: "unavailable",
        reason: "previous_closure_unresolved",
      });
      await expect(
        host.apply([legalV2], 1, host.binding(onlyV2)),
      ).rejects.toBeInstanceOf(ProjectPackBindingCollisionError);
      // A pure removal is still applied while the current closure is absent.
      await host.bind("a", [custom, legal]);
      await host.own("a", [["roles", "counsel"]]);
      expect(
        (await host.binding(onlyV2).preview("a", [custom])).issues,
      ).toEqual([]);
      expect(await host.apply([custom], 2, host.binding(onlyV2))).toMatchObject(
        { configurationRevision: 3, packs: [custom] },
      );

      // A proposed closure that does not resolve reports its GP-04 code only.
      const missing = await host.binding(onlyV2).preview("a", [legal]);
      expect(missing.issues.map((issue) => issue.code)).toEqual([
        "missing_pack",
      ]);
      await expect(
        host.apply([legal], 3, host.binding(onlyV2)),
      ).rejects.toMatchObject({ code: "missing_pack" });
      expect(await host.storage.packBindings.get("a")).toMatchObject({
        configurationRevision: 3,
        packs: [custom],
      });
    } finally {
      host.database.close();
    }
  });
});

/** A source host whose project holds `packs` and `owned` without a preflight. */
async function archiveOf(packs: PackIdentity[], owned: readonly Owned[]) {
  const origin = runtime(new InMemoryInstalledDomainPackCatalog(1, []));
  const source = temporaryRoot("ai-office-gp22-source-");
  writeFileSync(join(source, "package.json"), '{"name":"gp22"}\n');
  const imported = await origin.importProject(source);
  await origin.bind(imported.projectId, packs);
  await origin.own(imported.projectId, owned);
  const backup = await origin.portability().backup(imported.projectId);
  // The parser recomputes and checks every checksum of the serialized bytes.
  const archive = parsePortableProjectArchive(
    serializePortableProjectArchive(backup.archive),
  );
  origin.database.close();
  return { archive, identity: backup.projectIdentity };
}

function restoreTarget(): string {
  const target = temporaryRoot("ai-office-gp22-target-");
  writeFileSync(join(target, "package.json"), '{"name":"gp22"}\n');
  return target;
}

const restoreCollision = (
  kind: string,
  id: string,
  pack = "org.example.legal@1.0.0",
) => ({
  code: collisionCode,
  message: `Portable restore rejected (pack_definition_collision): project definition ${kind}/${id} collides with pack ${pack} in the archive's resolved pack closure; nothing was restored`,
});

describe("GP-22 binding composition preflight: portable restore", () => {
  test.each([
    {
      name: "a direct collision",
      packs: [legal],
      owned: [["roles", "counsel"]] as Owned[],
      expected: restoreCollision("roles", "counsel"),
    },
    {
      name: "a transitive collision",
      packs: [dependent],
      owned: [
        ["roles", "other"],
        ["taskTypes", "matter", false],
      ] as Owned[],
      expected: restoreCollision("taskTypes", "matter"),
    },
  ])(
    "restore with an available closure and $name is rejected atomically for a checksummed archive",
    async ({ packs, owned, expected }) => {
      const { archive, identity } = await archiveOf(packs, owned);
      expect(archive.state.packBinding?.packs).toEqual(packs);
      expect(archive.state.definitions?.owned).toHaveLength(owned.length);
      const host = runtime(catalogOf(legalBytes, dependentBytes).catalog);
      const target = restoreTarget();
      try {
        const before = host.writes();
        const rejected = await host
          .portability()
          .restore({ archive, rootPath: target })
          .catch((error) => error);
        expect(rejected).toBeInstanceOf(ProjectRestoreCompositionError);
        expect(rejected).toBeInstanceOf(ProjectPortabilityError);
        expect(rejected).toMatchObject(expected);
        // No project, identity, source, binding or definition state remains.
        expect(host.writes()).toBe(before);
        expect(await host.identities.findProjectId(identity)).toBeNull();
        expect(
          await host.profiles.findProjectIdByLocalPath(realpathSync(target)),
        ).toBeNull();
        for (const table of [
          "project",
          "project_pack_binding",
          "project_definition_head",
          "project_owned_definition",
        ])
          expect(
            host.database
              .query<{ count: number }, []>(
                `SELECT count(*) AS count FROM ${table}`,
              )
              .get()!.count,
            table,
          ).toBe(0);
        expect(existsSync(join(target, ".ai-office"))).toBe(false);
      } finally {
        host.database.close();
      }
    },
  );

  test("restore with an available closure and no collision succeeds and resolves", async () => {
    const owned: Owned[] = [
      ["roles", "Counsel"],
      ["taskTypes", "counsel"],
      ["prompts", "Greeting"],
    ];
    const { archive } = await archiveOf([dependent], owned);
    const host = runtime(catalogOf(legalBytes, dependentBytes).catalog);
    try {
      const restored = await host
        .portability()
        .restore({ archive, rootPath: restoreTarget() });
      expect(restored.outcome).toBe("restored");
      const resolved = await host.reader().read(restored.projectId);
      expect(resolved.projectOwnedDefinitions).toHaveLength(3);
      expect(
        (await host.storage.packBindings.get(restored.projectId)).packs,
      ).toEqual([dependent]);
    } finally {
      host.database.close();
    }
  });

  test("restore of an exact binding whose artifacts are absent succeeds, preserves binding and definitions, and GP-06 fails closed until and after they are installed", async () => {
    for (const { owned, collides } of [
      { owned: [["roles", "counsel"]] as Owned[], collides: true },
      { owned: [["roles", "Counsel"]] as Owned[], collides: false },
    ]) {
      const { archive } = await archiveOf([dependent], owned);
      // Empty catalog: the selected pack itself is absent.
      const { catalog, install } = catalogOf();
      const host = runtime(catalog);
      try {
        const restored = await host
          .portability()
          .restore({ archive, rootPath: restoreTarget() });
        expect(restored.outcome).toBe("restored");
        expect(
          await host.storage.packBindings.get(restored.projectId),
        ).toMatchObject({ configurationRevision: 1, packs: [dependent] });
        expect(
          (await host.states.loadPortableState(restored.projectId)).definitions,
        ).toEqual(archive.state.definitions);
        expect(
          (await host.states.loadPortableState(restored.projectId)).packBinding,
        ).toEqual(archive.state.packBinding);
        await expect(
          host.reader().read(restored.projectId),
        ).rejects.toMatchObject({ code: "pack_unavailable" });
        // The selected pack arrives, its dependency is still absent.
        install(dependentBytes);
        await expect(
          host.reader().read(restored.projectId),
        ).rejects.toMatchObject({ code: "pack_dependency_failure" });
        // The exact closure becomes resolvable.
        install(legalBytes);
        if (collides) {
          await expect(
            host.reader().read(restored.projectId),
          ).rejects.toMatchObject({
            code: "duplicate_effective_definition",
            message:
              "Project definition roles/counsel collides with the resolved pack closure",
          });
          // The latent collision is visible to the binding preview too.
          expect(
            (await host.binding().preview(restored.projectId, [dependent]))
              .issues,
          ).toEqual([collision("roles", "counsel")]);
        } else {
          const resolved = await host.reader().read(restored.projectId);
          expect(resolved.resolvedPacks).toHaveLength(2);
          expect(
            resolved.projectOwnedDefinitions.map((item) => item.effectiveId),
          ).toEqual(["project:roles/Counsel"]);
        }
      } finally {
        host.database.close();
      }
    }
  });

  test("restore of a binding whose dependency is absent succeeds without a preflight verdict", async () => {
    const { archive } = await archiveOf([dependent], [["roles", "counsel"]]);
    // The selected pack is installed; its dependency legal@1 is not.
    const host = runtime(catalogOf(dependentBytes).catalog);
    try {
      const restored = await host
        .portability()
        .restore({ archive, rootPath: restoreTarget() });
      expect(restored.outcome).toBe("restored");
      await expect(
        host.reader().read(restored.projectId),
      ).rejects.toMatchObject({ code: "pack_dependency_failure" });
    } finally {
      host.database.close();
    }
  });

  test("no fallback to another installed version or digest is used to judge the composition", async () => {
    const otherDigest: PackIdentity = {
      ...legal,
      manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
    };
    for (const [label, packs, installed] of [
      // Same ID and version, another manifest digest, which has roles/counsel.
      ["another digest", [otherDigest], [legalBytes]],
      // Same ID, another version, which has roles/auditor.
      ["another version", [legal], [legalV2Bytes]],
    ] as const) {
      const owned: Owned[] = [
        ["roles", "counsel"],
        ["roles", "auditor"],
      ];
      const { archive } = await archiveOf([...packs], owned);
      const host = runtime(catalogOf(...installed).catalog);
      try {
        const restored = await host
          .portability()
          .restore({ archive, rootPath: restoreTarget() });
        expect(restored.outcome, label).toBe("restored");
        expect(
          (await host.storage.packBindings.get(restored.projectId)).packs,
          label,
        ).toEqual(packs);
        expect(
          (await host.storage.definitions.get(restored.projectId)).owned,
          label,
        ).toHaveLength(2);
        await expect(
          host.reader().read(restored.projectId),
          label,
        ).rejects.toMatchObject({ code: "pack_unavailable" });
      } finally {
        host.database.close();
      }
    }
  });

  test("a restore yielding attached or unchanged is not rejected by the preflight", async () => {
    const host = runtime(catalogOf(legalBytes).catalog);
    const checkout = () => {
      const root = temporaryRoot("ai-office-gp22-checkout-");
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        '[remote "origin"]\n  url = https://example.test/team/gp22.git\n',
      );
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      return root;
    };
    try {
      const imported = await host.importProject(checkout());
      // The local project already holds a colliding, resolvable composition.
      await host.bind(imported.projectId, [legal]);
      await host.own(imported.projectId, [["roles", "counsel"]]);
      const backup = await host.portability().backup(imported.projectId);
      const archive = parsePortableProjectArchive(
        serializePortableProjectArchive(backup.archive),
      );
      const target = checkout();
      expect(
        (await host.portability().restore({ archive, rootPath: target }))
          .outcome,
      ).toBe("attached");
      expect(
        (await host.portability().restore({ archive, rootPath: target }))
          .outcome,
      ).toBe("unchanged");
      await expect(
        host.reader().read(imported.projectId),
      ).rejects.toMatchObject({ code: "duplicate_effective_definition" });
    } finally {
      host.database.close();
    }
  });
});

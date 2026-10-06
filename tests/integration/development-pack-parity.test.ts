import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import { SyncAgentDefinitions } from "@ai-office/application/commands/sync-agent-definitions.ts";
import type { LegacyDevelopmentProfile } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/read-legacy-development-profile.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import type { ResolvedProjectConfiguration } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import { officeTaskKinds } from "@ai-office/domain/office/office-manifest.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteProjectDefinitionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-definition.repository.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import {
  completenessViolations,
  developmentPackBytes,
  developmentPackManifestDigest,
  legacyRoleIds,
  missingGp09Gaps,
  mutatedDevelopmentPackBytes,
  outsidePackVocabulary,
  projectLegacyProfile,
  projectResolvedConfiguration,
  shippedAgentsDirectory,
  shippedOfficeManifestPath,
  testCatalogWith,
  type RawPackManifest,
} from "../helpers/development-pack-parity.ts";
import {
  legacyFixtureDirectory,
  legacyProjectId,
  legacyStores,
  loadPrePackFixture,
  projectMigrations,
  SequenceIds,
  tableRows,
  TickingClock,
  type LegacyStores,
} from "../helpers/legacy-development-fixture.ts";

// GP-10A expressible-subset parity on stored state: the resolved
// configuration of a project bound to the development pack through a catalog
// that exists only here, against the GP-09 legacy profile of the same
// project. Once on the frozen GP-09 fixture, once on the defaults the
// repository ships.

/** GP-09's pinned digest of the fixture office (profile version 1). */
const fixtureProfileDigest =
  "sha256:96ad6eab62fd50dd9290df6c3c2f471604b9290cc7fb5ee2e4c13ba3c9002efa";
/** GP-06's pinned digest of the empty configuration. */
const emptyConfigurationDigest =
  "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19";

const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp10a-"));
  roots.push(root);
  return root;
}

function services(stores: LegacyStores, catalog: InstalledDomainPackCatalog) {
  const bindings = new SqliteProjectPackBindingRepository(stores.database);
  const definitions = new SqliteProjectDefinitionRepository(stores.database);
  return {
    bindings,
    legacy: (projectId: string): Promise<LegacyDevelopmentProfile> =>
      new ReadLegacyDevelopmentProfile({
        projects: stores.projects,
        officeManifests: stores.officeManifests,
        runtime: stores.runtime,
        bindings,
        transactions: stores.transactions,
      }).read(projectId),
    resolved: (projectId: string): Promise<ResolvedProjectConfiguration> =>
      new ReadProjectConfiguration({
        projects: stores.projects,
        bindings,
        definitions,
        transactions: stores.transactions,
        catalog,
      }).read(projectId),
    /** The audited selection the `project:pack:apply` command performs. */
    bind: async (projectId: string, pack: PackIdentity) => {
      const binding = await new ManageProjectPackBinding({
        projects: stores.projects,
        bindings,
        definitions,
        catalog,
        auditEvents: new SqliteAuditEventRepository(stores.database),
        transactions: stores.transactions,
        clock: stores.clock,
        ids: stores.ids,
      }).apply({
        projectId,
        desired: [pack],
        expectedRevision: 0,
        actorId: "gp10a-test",
      });
      expect(binding).toMatchObject({
        configurationRevision: 1,
        packs: [pack],
      });
    },
  };
}

/** The committed GP-09 pre-pack database, replayed and migrated to head. */
function fixtureProject(): LegacyStores {
  const database = loadPrePackFixture(temporaryRoot());
  databases.push(database);
  migrate(database, projectMigrations);
  return legacyStores(
    database,
    new TickingClock("2026-10-06T00:00:00.000Z"),
    new SequenceIds("gp10a"),
  );
}

const shippedProjectId = "shipped-defaults";

/**
 * A project whose legacy state is what the repository distributes: the given
 * office manifest applied, and the given agent directory read by the real
 * loader and written by the real sync, as `office:apply` and `agent:sync` do.
 */
async function projectFrom(
  officeManifestPath: string,
  agentsDirectory: string,
): Promise<LegacyStores> {
  const database = openDatabase(join(temporaryRoot(), "project.sqlite"));
  databases.push(database);
  migrate(database, projectMigrations);
  const stores = legacyStores(
    database,
    new TickingClock("2026-10-06T00:00:00.000Z"),
    new SequenceIds("gp10a"),
  );
  await stores.projects.save(
    Project.create({
      id: shippedProjectId,
      name: "Shipped development defaults",
      now: stores.clock.now(),
    }),
  );
  await new ApplyOfficeManifest(
    stores.projects,
    stores.officeManifests,
    stores.audit,
    stores.ids,
    stores.clock,
    stores.transactions,
  ).execute(
    shippedProjectId,
    parseOfficeManifestJson(readFileSync(officeManifestPath, "utf8")),
  );
  await new SyncAgentDefinitions(
    stores.projects,
    stores.runtime,
    stores.ids,
    stores.clock,
    stores.transactions,
  ).execute(
    shippedProjectId,
    new YamlAgentDefinitionLoader().load(agentsDirectory, {
      requireGuidance: true,
    }),
  );
  return stores;
}

/** Both projections of one project bound to the pack in a test catalog. */
async function boundProjections(
  stores: LegacyStores,
  projectId: string,
  bytes = developmentPackBytes(),
) {
  const { catalog, pack } = testCatalogWith(bytes);
  const { bind, legacy, resolved } = services(stores, catalog);
  await bind(projectId, pack);
  const profile = await legacy(projectId);
  const configuration = await resolved(projectId);
  return {
    profile,
    configuration,
    legacy: projectLegacyProfile(profile),
    pack: projectResolvedConfiguration(configuration),
  };
}

describe("GP-10A expressible-subset parity on the GP-09 fixture state", () => {
  test("a fixture project bound to the pack resolves the roles, agents and task types its legacy profile describes", async () => {
    const stores = fixtureProject();
    const result = await boundProjections(stores, legacyProjectId);
    expect(result.pack).toEqual(result.legacy);
    expect(result.legacy.roles.map((role) => role.id)).toEqual([
      ...legacyRoleIds,
    ]);
    expect(result.legacy.agents).toEqual(
      legacyRoleIds.map((id) => ({ id, role: id })),
    );
    expect(result.legacy.taskTypes).toEqual([...officeTaskKinds].sort());
    // Only the pack is resolved, and only as declarations.
    expect(result.configuration.selectedPacks).toEqual([
      {
        id: "org.ai-office.development",
        version: "0.1.0",
        manifestDigest: developmentPackManifestDigest,
      },
    ]);
    expect(result.configuration.workflows).toEqual([]);
    expect(result.configuration.projectOwnedDefinitions).toEqual([]);
    // The fixture's specialist and its unused role stay Runtime-only: they
    // are not development defaults and the pack does not describe them.
    expect(
      result.profile.runtimeOnly.agents.map((agent) => agent.name),
    ).toEqual(["security"]);
    expect(result.pack.agents.map((agent) => agent.id)).not.toContain(
      "security",
    );
  });

  test("binding the pack leaves the legacy profile and its digest at the GP-09 pinned vector", async () => {
    const stores = fixtureProject();
    const { catalog, pack } = testCatalogWith(developmentPackBytes());
    const { bind, legacy } = services(stores, catalog);
    const unbound = await legacy(legacyProjectId);
    expect(unbound.profileDigest).toBe(fixtureProfileDigest);
    expect(unbound.metadata.packBinding).toEqual({ present: false });
    const before = tableRows(stores.database);

    await bind(legacyProjectId, pack);

    const bound = await legacy(legacyProjectId);
    expect(bound.profileDigest).toBe(fixtureProfileDigest);
    expect(bound.metadata.packBinding).toEqual({ present: true });
    expect({
      ...bound,
      metadata: { ...bound.metadata, packBinding: { present: false } },
    }).toEqual(unbound);
    // Every legacy row is the same: the selection and its audit event are
    // the only rows the binding wrote.
    const after = tableRows(stores.database);
    expect(
      Object.keys(after).filter(
        (table) => after[table]!.join() !== before[table]!.join(),
      ),
    ).toEqual([
      "audit_event",
      "project_pack_binding",
      "project_pack_binding_pack",
    ]);
    expect(after.audit_event!.slice(0, before.audit_event!.length)).toEqual(
      before.audit_event,
    );
    expect(
      after
        .audit_event!.slice(before.audit_event!.length)
        .map((row) => (JSON.parse(row) as { event_type: string }).event_type),
    ).toEqual(["project.pack_binding_applied"]);
  });

  test("the GP-09 fixture files are the committed bytes", () => {
    const checksums = Object.fromEntries(
      readdirSync(legacyFixtureDirectory)
        .filter((name) => name !== "regenerate.ts")
        .sort()
        .map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(legacyFixtureDirectory, name)))
            .digest("hex"),
        ]),
    );
    expect(checksums).toEqual({
      "expected-profile.json":
        "5de212c6cb494aa9edf20139201cd9819db05a0049ae2b51b562d76271d57a01",
      "expected-restored-profile.json":
        "1fae64df8873a374ade9a16a6d85bf325d15136e424185f244c8f650e1c4fa89",
      "format-1.aioffice":
        "230f6fa4df9f92a3d61411cdda76a6366bdacb7d7c9f7cb683836ed820ce90da",
      "format-2.aioffice":
        "8d76868c1fe0136a986ba0c226b1863089d6201cd7f25065240cd9d45568bb33",
      "format-3.aioffice":
        "47704aec1153ae569c5c50d8756bd20e2e5df8b87e7c46ee3a49749e44b95e90",
      "format-4.aioffice":
        "c1d33c2f4c6444b404789b36dadf829616049f50c494e9db5a6a065680bcf5eb",
      "office-manifest.json":
        "2c25a5fcc5efc19e11119701d656b7df831cdb91dcdfc3a48f58a54a2d185ee4",
      "pre-pack-project.sql":
        "b0c8da9ee0687d209527e8ae55d34efd5456cc60b1feb4f429fafd9433e5ec84",
      "runtime-definitions.json":
        "939655b154ab375811a572271cddec538ee87c1bc9e2fec99d3266b8b5af1c31",
    });
  });

  test("an unbound project resolves to the empty configuration even when a catalog holds the pack", async () => {
    const stores = fixtureProject();
    const { catalog } = testCatalogWith(developmentPackBytes());
    const configuration = await services(stores, catalog).resolved(
      legacyProjectId,
    );
    expect(configuration.configurationDigest).toBe(emptyConfigurationDigest);
    expect(configuration.selectedPacks).toEqual([]);
    expect(configuration.roles).toEqual([]);
    expect(configuration.agents).toEqual([]);
    expect(configuration.effectiveDefinitions.taskTypes).toEqual([]);
  });

  test("changing a title, a capability or an agent role in a copy of the pack breaks parity on stored state", async () => {
    for (const mutate of [
      (manifest: RawPackManifest) => {
        manifest.contributions.roles![0]!.title = "Architect";
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.roles![1]!.capabilities = ["run_tests"];
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.agents![0]!.role = "developer";
      },
    ]) {
      const result = await boundProjections(
        fixtureProject(),
        legacyProjectId,
        mutatedDevelopmentPackBytes(mutate),
      );
      expect(result.pack).not.toEqual(result.legacy);
    }
  });
});

describe("GP-10A expressible-subset parity on the shipped defaults", () => {
  /** A private copy of the shipped defaults that a test may edit. */
  function copyOfShippedDefaults() {
    const root = temporaryRoot();
    const agents = join(root, "agents");
    for (const id of legacyRoleIds)
      cpSync(join(shippedAgentsDirectory, id), join(agents, id), {
        recursive: true,
      });
    const office = join(root, "default-office-manifest.json");
    cpSync(shippedOfficeManifestPath, office);
    return { agents, office };
  }
  const edit = (path: string, from: string, to: string) => {
    const text = readFileSync(path, "utf8");
    expect(text).toContain(from);
    writeFileSync(path, text.replace(from, to));
  };

  test("the shipped agents directory and default office manifest, through the real loader and sync, equal the pack", async () => {
    // The directory is exactly the four default roles: nothing is skipped.
    expect(
      readdirSync(shippedAgentsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...legacyRoleIds]);
    const stores = await projectFrom(
      shippedOfficeManifestPath,
      shippedAgentsDirectory,
    );
    const result = await boundProjections(stores, shippedProjectId);
    expect(result.pack).toEqual(result.legacy);
    expect(result.legacy.roles).toHaveLength(4);
    expect(result.legacy.agents).toHaveLength(4);
    expect(result.legacy.taskTypes).toHaveLength(5);
    // Every default is office-derived here: nothing is Runtime-only.
    expect(result.profile.runtimeOnly).toEqual({ roles: [], agents: [] });
    expect(result.profile.diagnostics).toEqual([]);
    expect(result.profile.metadata.packBinding).toEqual({ present: true });
  });

  test("every shipped field is in the projection or in the list of fields outside the pack vocabulary", async () => {
    const stores = await projectFrom(
      shippedOfficeManifestPath,
      shippedAgentsDirectory,
    );
    const { catalog } = testCatalogWith(developmentPackBytes());
    const profile = await services(stores, catalog).legacy(shippedProjectId);
    const vocabulary = outsidePackVocabulary();
    expect(completenessViolations(profile, vocabulary)).toEqual([]);
    expect(missingGp09Gaps(profile, vocabulary)).toEqual([]);
    // The profile carries every field the shipped sources have: a new key in
    // an agent definition or in an office role has to be classified first.
    const profileField: Record<string, string> = {
      id: "agents[].name",
      roleKey: "roles[].id",
      role: "roles[].runtime.name",
      version: "roles[].runtime.version",
      capabilities: "roles[].runtime.capabilities",
      tools: "roles[].runtime.tools",
      modelPolicy: "roles[].runtime.modelPolicy",
      roleGuidance: "roles[].runtime.guidance",
      limits: "roles[].runtime.limits",
    };
    for (const { definition } of new YamlAgentDefinitionLoader().load(
      shippedAgentsDirectory,
      { requireGuidance: true },
    ))
      expect(Object.keys(definition).sort()).toEqual(
        Object.keys(profileField).sort(),
      );
    const office = JSON.parse(
      readFileSync(shippedOfficeManifestPath, "utf8"),
    ) as { office: { roles: Record<string, unknown>[] } };
    for (const role of office.office.roles)
      expect(Object.keys(role).sort()).toEqual([
        "id",
        "purpose",
        "responsibilities",
        "title",
      ]);
    for (const role of profile.roles)
      expect(Object.keys(role).sort()).toEqual([
        "id",
        "purpose",
        "responsibilities",
        "runtime",
        "title",
      ]);
  });

  test("the GP-09 fixture digest does not describe the shipped defaults: their guidance differs while the expressible subset is equal", async () => {
    const shipped = await projectFrom(
      shippedOfficeManifestPath,
      shippedAgentsDirectory,
    );
    const { catalog } = testCatalogWith(developmentPackBytes());
    const profile = await services(shipped, catalog).legacy(shippedProjectId);
    const fixture = await services(fixtureProject(), catalog).legacy(
      legacyProjectId,
    );
    expect(fixture.profileDigest).toBe(fixtureProfileDigest);
    expect(profile.profileDigest).not.toBe(fixtureProfileDigest);
    expect(projectLegacyProfile(profile)).toEqual(
      projectLegacyProfile(fixture),
    );
    for (const id of legacyRoleIds) {
      const guidance = (source: LegacyDevelopmentProfile) =>
        source.roles.find((role) => role.id === id)!.runtime!.guidance!.digest;
      expect(guidance(profile)).not.toBe(guidance(fixture));
    }
  });

  test("a shipped default that changes without the pack breaks parity", async () => {
    const parity = async (
      change: (copy: ReturnType<typeof copyOfShippedDefaults>) => void,
    ) => {
      const copy = copyOfShippedDefaults();
      change(copy);
      const result = await boundProjections(
        await projectFrom(copy.office, copy.agents),
        shippedProjectId,
      );
      return {
        equal: JSON.stringify(result.pack) === JSON.stringify(result.legacy),
        ...result,
      };
    };
    // The untouched copy is at parity, so each failure below is the edit's.
    const untouched = await parity(() => undefined);
    expect(untouched.equal).toBe(true);

    for (const change of [
      // A role capability added, removed and renamed in `agent.yaml`.
      (copy: { agents: string }) =>
        edit(
          join(copy.agents, "developer", "agent.yaml"),
          "  - create_patch\n",
          "  - create_patch\n  - deploy_release\n",
        ),
      (copy: { agents: string }) =>
        edit(join(copy.agents, "qa", "agent.yaml"), "  - run_tests\n", ""),
      (copy: { agents: string }) =>
        edit(
          join(copy.agents, "architect", "agent.yaml"),
          "  - propose_adr\n",
          "  - write_adr\n",
        ),
      // A role key that no longer joins its office role.
      (copy: { agents: string }) =>
        edit(
          join(copy.agents, "reviewer", "agent.yaml"),
          "role_key: reviewer\n",
          "role_key: code-reviewer\n",
        ),
      // A title and a purpose in the default office manifest.
      (copy: { office: string }) =>
        edit(copy.office, '"title": "Reviewer"', '"title": "Code Reviewer"'),
      (copy: { office: string }) =>
        edit(
          copy.office,
          "Deliver a scoped, maintainable implementation backed by relevant validation",
          "Deliver a scoped implementation",
        ),
    ])
      expect((await parity(change)).equal).toBe(false);

    // What the claim does not cover: a change outside the pack vocabulary
    // moves the legacy profile and leaves the expressible subset equal.
    for (const change of [
      (copy: { agents: string }) =>
        edit(
          join(copy.agents, "developer", "system.md"),
          "\n",
          "\nAn added instruction.\n",
        ),
      (copy: { agents: string }) =>
        edit(
          join(copy.agents, "developer", "agent.yaml"),
          "model_policy: balanced\n",
          "model_policy: economical\n",
        ),
      (copy: { agents: string }) =>
        edit(
          join(copy.agents, "developer", "agent.yaml"),
          "role: software-developer\n",
          "role: engineer\n",
        ),
    ]) {
      const result = await parity(change);
      expect(result.equal).toBe(true);
      expect(result.profile.profileDigest).not.toBe(
        untouched.profile.profileDigest,
      );
    }
  });
});

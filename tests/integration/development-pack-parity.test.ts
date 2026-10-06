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
import { legacyRoleGuidanceDigest } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteProjectDefinitionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-definition.repository.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import {
  completenessViolations,
  defaultStateViolations,
  developmentPackBytes,
  developmentPackManifestDigest,
  developmentPackVersion,
  legacyRoleIds,
  legacyRoutes,
  missingGp09Gaps,
  mutatedDevelopmentPackBytes,
  outsidePackVocabulary,
  projectLegacyGuidance,
  projectLegacyProfile,
  projectResolvedConfiguration,
  projectResolvedGuidance,
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

// GP-10A, GP-10B-1 and GP-10B-2 (pack 0.3.0) expressible-subset parity on
// stored state: the
// resolved configuration of a project bound to the development pack through
// a catalog that exists only here, against the GP-09 legacy profile of the
// same project. Once on the frozen GP-09 fixture, once on the defaults the
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

/** Both projections of a project built from an edited copy of the defaults. */
async function parityOfShippedCopy(
  change: (copy: ReturnType<typeof copyOfShippedDefaults>) => void,
) {
  const copy = copyOfShippedDefaults();
  change(copy);
  const result = await boundProjections(
    await projectFrom(copy.office, copy.agents),
    shippedProjectId,
  );
  return {
    equal: JSON.stringify(result.pack) === JSON.stringify(result.legacy),
    /** Guidance is compared apart from the shared shape (GP-10B-2). */
    guidanceEqual:
      JSON.stringify(projectResolvedGuidance(result.configuration)) ===
      JSON.stringify(projectLegacyGuidance(result.profile)),
    ...result,
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
        version: developmentPackVersion,
        manifestDigest: developmentPackManifestDigest,
      },
    ]);
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
    expect(configuration.workflows).toEqual([]);
    expect(configuration.resolvedWorkflowReferences).toEqual([]);
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
    // The shipped defaults use every listed field marked as used, and none
    // of the fields marked as unused by the default state.
    expect(defaultStateViolations(profile, vocabulary)).toEqual([]);
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
    const parity = parityOfShippedCopy;
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

// GP-10B-1: the four development workflows of the pack against the legacy
// default pipelines, over what a schema-1 workflow can express.

/** An office manifest file as a test edits it. */
interface EditableOffice {
  office: { roles: { responsibilities: string[] }[] };
  pipelines: {
    id: string;
    name: string;
    description: string;
    enforcement?: string;
    defaultFor: string[];
    stages: {
      id: string;
      name: string;
      roleId: string;
      objective: string;
      checks: string[];
      requiresApproval: boolean;
      capabilities?: string[];
      requiresIndependentApproval?: boolean;
      requiresDifferentAgentFrom?: string[];
    }[];
  }[];
}

const editOffice =
  (mutate: (office: EditableOffice) => void) => (copy: { office: string }) => {
    const before = readFileSync(copy.office, "utf8");
    const office = JSON.parse(before) as EditableOffice;
    mutate(office);
    const after = `${JSON.stringify(office, null, 2)}\n`;
    expect(after).not.toBe(`${JSON.stringify(JSON.parse(before), null, 2)}\n`);
    writeFileSync(copy.office, after);
  };

const pipelineOf = (office: EditableOffice, id: string) =>
  office.pipelines.find((pipeline) => pipeline.id === id)!;

const packWorkflowIds = ["bugfix", "delivery", "discovery", "release"];

/** The legacy routes of a profile that are not among the pack routes. */
const routesMissingFrom = (
  pack: readonly { taskType: string; workflow: string }[],
  profile: Pick<LegacyDevelopmentProfile, "taskKinds">,
) =>
  legacyRoutes(profile).filter(
    (route) =>
      !pack.some(
        (expressed) =>
          expressed.taskType === route.taskType &&
          expressed.workflow === route.workflow,
      ),
  );

describe("GP-10B-1 expressible-subset parity for workflows on the GP-09 fixture state", () => {
  test("a fixture project bound to the pack resolves the four workflows its legacy pipelines describe, with their stage descriptions, and all five routes", async () => {
    const result = await boundProjections(fixtureProject(), legacyProjectId);
    expect(result.pack.workflows).toEqual(result.legacy.workflows);
    expect(result.pack.routes).toEqual(result.legacy.routes);
    expect(result.pack.workflows.map((workflow) => workflow.id)).toEqual(
      packWorkflowIds,
    );
    expect(result.legacy.workflows).toEqual(
      [...result.profile.pipelines]
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .map((pipeline) => ({
          id: pipeline.id,
          title: pipeline.name,
          description: pipeline.description,
          taskTypes: [...pipeline.defaultFor].sort(),
          stages: pipeline.stages.map((stage) => ({
            id: stage.id,
            role: stage.roleId,
            title: stage.name,
            objective: stage.objective,
            checks: stage.checks,
          })),
        })),
    );
    // The roles carry the office role responsibilities, in order.
    expect(result.pack.roles).toEqual(result.legacy.roles);
    expect(
      result.pack.roles.every((role) => role.responsibilities.length === 5),
    ).toBe(true);
    // Stable identity and origin of what was resolved: pack declarations.
    expect(
      result.configuration.workflows.map((workflow) => [
        workflow.workflowId,
        workflow.origin,
        workflow.customization,
      ]),
    ).toEqual(
      packWorkflowIds.map((id) => [
        `pack:org.ai-office.development/workflows/${id}`,
        "pack_owned",
        "none",
      ]),
    );
    expect(result.configuration.disabledWorkflows).toEqual([]);
    // Every pack route is a legacy route and no legacy route is missing:
    // the GP-10B-1 difference, maintenance -> delivery, is gone.
    const all = legacyRoutes(result.profile);
    for (const route of result.pack.routes) expect(all).toContainEqual(route);
    expect(result.pack.routes).toHaveLength(5);
    expect(result.pack.routes).toContainEqual({
      taskType: "maintenance",
      workflow: "delivery",
    });
    expect(routesMissingFrom(result.pack.routes, result.profile)).toEqual([]);
  });

  test("binding the pack creates no pipeline, run, pin, approval, guard or job from a workflow", async () => {
    const stores = fixtureProject();
    const { catalog, pack } = testCatalogWith(developmentPackBytes());
    const { bind, resolved } = services(stores, catalog);
    const before = tableRows(stores.database);
    await bind(legacyProjectId, pack);
    // Resolving the four workflows is a read.
    expect((await resolved(legacyProjectId)).workflows).toHaveLength(4);
    const after = tableRows(stores.database);
    const untouched = [
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
      "project_owned_definition",
      "project_definition_override",
    ];
    for (const table of untouched) {
      expect(Object.keys(before)).toContain(table);
      expect([table, after[table]]).toEqual([table, before[table]]);
    }
    // The fixture has pipeline runs, stage runs and approvals to disturb.
    for (const table of ["pipeline_run", "pipeline_stage_run", "approval"])
      expect(before[table]!.length).toBeGreaterThan(0);
    expect(
      Object.keys(after).filter(
        (table) => after[table]!.join() !== before[table]!.join(),
      ),
    ).toEqual([
      "audit_event",
      "project_pack_binding",
      "project_pack_binding_pack",
    ]);
    // The one audit event is the selection; none names a pipeline or a run.
    expect(
      after
        .audit_event!.slice(before.audit_event!.length)
        .map((row) => (JSON.parse(row) as { event_type: string }).event_type),
    ).toEqual(["project.pack_binding_applied"]);
  });

  test("changing a workflow title, a stage order, a stage role or a route in a copy of the pack breaks parity on stored state", async () => {
    for (const mutate of [
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![0]!.title = "Delivery";
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![1]!.stages!.reverse();
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![3]!.stages![0]!.role = "architect";
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![0]!.taskType = "research";
      },
      (manifest: RawPackManifest) => {
        delete manifest.contributions.workflows![0]!.additionalTaskTypes;
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![2]!.stages![0]!.title = "Explore";
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![1]!.stages![0]!.objective += ".";
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.workflows![0]!.stages![1]!.checks!.push("More");
      },
      (manifest: RawPackManifest) => {
        manifest.contributions.roles![1]!.responsibilities!.pop();
      },
    ]) {
      const result = await boundProjections(
        fixtureProject(),
        legacyProjectId,
        mutatedDevelopmentPackBytes(mutate),
      );
      expect(result.pack).not.toEqual(result.legacy);
      expect({ ...result.pack, workflows: [], routes: [] }).toEqual({
        ...result.legacy,
        workflows: [],
        routes: [],
      });
    }
  });
});

describe("GP-10B-1 expressible-subset parity for workflows on the shipped defaults", () => {
  test("the shipped default pipelines equal the pack workflows, and a project built from them has no run", async () => {
    const stores = await projectFrom(
      shippedOfficeManifestPath,
      shippedAgentsDirectory,
    );
    const result = await boundProjections(stores, shippedProjectId);
    expect(result.pack.workflows).toEqual(result.legacy.workflows);
    expect(result.pack.routes).toEqual(result.legacy.routes);
    expect(result.pack.workflows.map((workflow) => workflow.id)).toEqual(
      packWorkflowIds,
    );
    const routes = [
      { taskType: "bugfix", workflow: "bugfix" },
      { taskType: "feature", workflow: "delivery" },
      { taskType: "maintenance", workflow: "delivery" },
      { taskType: "release", workflow: "release" },
      { taskType: "research", workflow: "discovery" },
    ];
    expect(result.pack.routes).toEqual(routes);
    // The shipped routes, as a literal, and none of them is missing.
    expect(legacyRoutes(result.profile)).toEqual(routes);
    expect(routesMissingFrom(result.pack.routes, result.profile)).toEqual([]);
    // The shipped manifest has exactly these four pipelines.
    const shipped = JSON.parse(
      readFileSync(shippedOfficeManifestPath, "utf8"),
    ) as EditableOffice;
    expect(shipped.pipelines.map((pipeline) => pipeline.id).sort()).toEqual(
      packWorkflowIds,
    );
    // Nothing was started from a resolved workflow.
    const rows = tableRows(stores.database, [
      "pipeline_run",
      "pipeline_stage_run",
      "pipeline_override",
      "approval",
      "agent_run",
      "job_outbox",
    ]);
    for (const [table, found] of Object.entries(rows))
      expect([table, found]).toEqual([table, []]);
  });

  test("a shipped pipeline that changes in its expressible part without the pack breaks parity", async () => {
    expect((await parityOfShippedCopy(() => undefined)).equal).toBe(true);
    for (const mutate of [
      (office: EditableOffice) => {
        pipelineOf(office, "delivery").name = "Delivery";
      },
      (office: EditableOffice) => {
        pipelineOf(office, "bugfix").description = "Fix a defect";
      },
      (office: EditableOffice) => {
        pipelineOf(office, "bugfix").stages.reverse();
      },
      (office: EditableOffice) => {
        pipelineOf(office, "discovery").stages[0]!.id = "explore";
      },
      (office: EditableOffice) => {
        pipelineOf(office, "release").stages[1]!.roleId = "reviewer";
      },
      // Two expressed routes, swapped.
      (office: EditableOffice) => {
        pipelineOf(office, "discovery").defaultFor = ["release"];
        pipelineOf(office, "release").defaultFor = ["research"];
      },
    ])
      expect((await parityOfShippedCopy(editOffice(mutate))).equal).toBe(false);
  });

  test("a shipped maintenance route that is removed or points elsewhere breaks parity, because the pack carries it", async () => {
    const untouched = await parityOfShippedCopy(() => undefined);
    expect(untouched.equal).toBe(true);
    expect(routesMissingFrom(untouched.pack.routes, untouched.profile)).toEqual(
      [],
    );
    for (const target of [null, "bugfix", "discovery"] as const) {
      const result = await parityOfShippedCopy(
        editOffice((office) => {
          pipelineOf(office, "delivery").defaultFor = ["feature"];
          if (target !== null)
            pipelineOf(office, target).defaultFor.push("maintenance");
        }),
      );
      expect([target, result.equal]).toEqual([target, false]);
      // The route comparison names the change: the legacy side lost or moved
      // maintenance -> delivery, which the pack still declares.
      expect([target, result.pack.routes]).not.toEqual([
        target,
        result.legacy.routes,
      ]);
      expect(
        routesMissingFrom(result.pack.routes, result.profile),
      ).not.toContainEqual({ taskType: "maintenance", workflow: "delivery" });
      expect(routesMissingFrom(result.legacy.routes, result.profile)).toEqual(
        [],
      );
    }
  });

  test("a shipped pipeline, stage or role that changes in what pack 0.3.0 carries breaks parity", async () => {
    for (const mutate of [
      (office: EditableOffice) => {
        pipelineOf(office, "delivery").stages[0]!.name = "Plan";
      },
      (office: EditableOffice) => {
        pipelineOf(office, "bugfix").stages[1]!.objective = "Fix it";
      },
      (office: EditableOffice) => {
        pipelineOf(office, "release").stages[1]!.checks.push("Signed off");
      },
      (office: EditableOffice) => {
        pipelineOf(office, "delivery").stages[1]!.checks.reverse();
      },
      (office: EditableOffice) => {
        office.office.roles[0]!.responsibilities.push("Write the ADR");
      },
      (office: EditableOffice) => {
        office.office.roles[2]!.responsibilities.reverse();
      },
    ])
      expect((await parityOfShippedCopy(editOffice(mutate))).equal).toBe(false);
  });

  test("a shipped pipeline that changes outside the expressible subset moves the legacy profile and leaves parity equal", async () => {
    const untouched = await parityOfShippedCopy(() => undefined);
    expect(untouched.equal).toBe(true);
    const listed = outsidePackVocabulary().entries.map(
      (entry) => `${entry.subject}.${entry.field}`,
    );
    for (const [key, mutate] of [
      [
        "stage.requiresApproval",
        (office: EditableOffice) => {
          pipelineOf(office, "bugfix").stages[2]!.requiresApproval = false;
        },
      ],
      [
        "stage.capabilities",
        (office: EditableOffice) => {
          pipelineOf(office, "bugfix").stages[1]!.capabilities = ["run_tests"];
        },
      ],
      [
        "stage.requiresIndependentApproval",
        (office: EditableOffice) => {
          pipelineOf(office, "bugfix").stages[2]!.requiresIndependentApproval =
            true;
        },
      ],
      [
        "stage.requiresDifferentAgentFrom",
        (office: EditableOffice) => {
          pipelineOf(office, "bugfix").stages[2]!.requiresDifferentAgentFrom = [
            "fix",
          ];
        },
      ],
      [
        "pipeline.enforcement",
        (office: EditableOffice) => {
          pipelineOf(office, "delivery").enforcement = "guidance";
        },
      ],
    ] as const) {
      const result = await parityOfShippedCopy(editOffice(mutate));
      expect([key, result.equal]).toEqual([key, true]);
      expect([key, result.profile.profileDigest]).not.toEqual([
        key,
        untouched.profile.profileDigest,
      ]);
      expect(listed).toContain(key);
      expect(
        outsidePackVocabulary().entries.find(
          (entry) => `${entry.subject}.${entry.field}` === key,
        )!.owner,
      ).toBe("GP-25");
    }
  });
});

// GP-10B-2 PR 2: role guidance on the shipped defaults.

describe("GP-10B-2 PR 2 role guidance parity on the shipped defaults", () => {
  test("the guidance prompt of each role has the digest the legacy profile of the shipped defaults reports", async () => {
    const stores = await projectFrom(
      shippedOfficeManifestPath,
      shippedAgentsDirectory,
    );
    const result = await boundProjections(stores, shippedProjectId);
    const pack = projectResolvedGuidance(result.configuration);
    const legacy = projectLegacyGuidance(result.profile);
    expect(pack).toEqual(legacy);
    expect(legacy.map((entry) => entry.role)).toEqual(
      [...legacyRoleIds].sort(),
    );
    for (const entry of legacy) {
      expect(entry.digest).toBe(
        legacyRoleGuidanceDigest(
          readFileSync(
            join(shippedAgentsDirectory, entry.role, "system.md"),
            "utf8",
          ),
        ),
      );
      expect(entry.digest).not.toBeNull();
    }
    // The pack text is the loader's guidance text, not only the file's.
    for (const { definition } of new YamlAgentDefinitionLoader().load(
      shippedAgentsDirectory,
      { requireGuidance: true },
    ))
      expect(
        result.configuration.effectiveDefinitions.prompts.find(
          (prompt) => prompt.localId === `${definition.roleKey}-guidance`,
        )!.payload,
      ).toMatchObject({ text: definition.roleGuidance });
  });

  test("a shipped guidance file that changes without the pack leaves the expressible subset equal and breaks guidance parity", async () => {
    const untouched = await parityOfShippedCopy(() => undefined);
    expect(untouched.guidanceEqual).toBe(true);
    for (const id of legacyRoleIds) {
      const result = await parityOfShippedCopy((copy) =>
        edit(join(copy.agents, id, "system.md"), "\n", "\nAn added line.\n"),
      );
      expect([id, result.equal]).toEqual([id, true]);
      expect([id, result.guidanceEqual]).toEqual([id, false]);
      expect(result.profile.profileDigest).not.toBe(
        untouched.profile.profileDigest,
      );
    }
    // The pack, edited the same way, is not at guidance parity either.
    for (const mutate of [
      (manifest: RawPackManifest) => {
        manifest.contributions.prompts![0]!.text += "An added line.\n";
      },
      (manifest: RawPackManifest) => {
        delete manifest.contributions.agents![2]!.prompts;
      },
    ]) {
      const result = await boundProjections(
        await projectFrom(shippedOfficeManifestPath, shippedAgentsDirectory),
        shippedProjectId,
        mutatedDevelopmentPackBytes(mutate),
      );
      expect(projectResolvedGuidance(result.configuration)).not.toEqual(
        projectLegacyGuidance(result.profile),
      );
      expect(result.pack).toEqual(result.legacy);
    }
  });

  test("on the GP-09 fixture the guidance is synthetic and is not compared", async () => {
    const result = await boundProjections(fixtureProject(), legacyProjectId);
    expect(result.pack).toEqual(result.legacy);
    expect(projectResolvedGuidance(result.configuration)).not.toEqual(
      projectLegacyGuidance(result.profile),
    );
    expect(result.profile.profileDigest).toBe(fixtureProfileDigest);
  });
});

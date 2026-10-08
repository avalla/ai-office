import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ManageKnowledgeAdmission } from "@ai-office/application/agent-knowledge/manage-knowledge-admission.ts";
import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import {
  canonicalLegacyDevelopmentProfile,
  type LegacyDevelopmentProfile,
} from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { ReadLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/read-legacy-development-profile.ts";
import {
  OfficePipelineNotFoundError,
  ProjectNotFoundError,
} from "@ai-office/application/errors.ts";
import {
  OrchestratePipelineStage,
  PipelineStageOrchestrationError,
} from "@ai-office/application/pipeline/orchestrate-pipeline-stage.ts";
import type {
  AgentKnowledgeStore,
  KnowledgeScope,
  SearchKnowledgeHit,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import {
  parsePortableProjectArchive,
  portableStateAtFormatVersion,
  portableStateChecksum,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { GetOfficeContext } from "@ai-office/application/queries/get-office-context.ts";
import {
  officeTaskKinds,
  type OfficeManifest,
} from "@ai-office/domain/office/office-manifest.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import {
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import {
  buildLegacyArchives,
  buildPrePackDatabase,
  completeActiveStage,
  dumpSqliteDatabase,
  legacyActivePipelineTaskId,
  legacyAgentId,
  legacyApprovedPipelineTaskId,
  legacyArchiveFormats,
  legacyArchiveName,
  legacyExpectedProfile,
  legacyFixturePath,
  legacyOfficeManifest,
  legacyPortability,
  legacyProjectId,
  legacyRepositoryId,
  legacyStores,
  loadPrePackFixture,
  projectMigrations,
  SequenceIds,
  tableRows,
  TickingClock,
  type LegacyStores,
} from "../helpers/legacy-development-fixture.ts";

// GP-09: legacy-state parity. The profile must equal what the Runtime reads
// from legacy state; nothing here claims the Runtime executes from it.

const fixtureDigest =
  "sha256:96ad6eab62fd50dd9290df6c3c2f471604b9290cc7fb5ee2e4c13ba3c9002efa";
/** The same office after a portable restore, which carries no role guidance. */
const restoredDigest =
  "sha256:ca970b1af6bbc7b53cf1da4c83f1354f10af3b9b658c3c490cbb959dd62b187c";

const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp09-"));
  roots.push(root);
  return root;
}

/** The committed pre-pack database, replayed and migrated to head. */
function migratedFixture(): LegacyStores {
  const database = loadPrePackFixture(temporaryRoot());
  databases.push(database);
  migrate(database, projectMigrations);
  // IDs and times after the fixture's own, so nothing collides with it.
  return legacyStores(
    database,
    new TickingClock("2026-10-01T00:00:00.000Z"),
    new SequenceIds("after-upgrade"),
  );
}

function reader(stores: LegacyStores): ReadLegacyDevelopmentProfile {
  return new ReadLegacyDevelopmentProfile({
    projects: stores.projects,
    officeManifests: stores.officeManifests,
    runtime: stores.runtime,
    bindings: new SqliteProjectPackBindingRepository(stores.database),
    transactions: stores.transactions,
  });
}

const sorted = (values: readonly string[]) => [...values].sort();

/**
 * Compares a profile with the Runtime's own readers of the same project and
 * returns every difference. It never calls the derivation: the office comes
 * from the manifest repository, routing from `GetOfficeContext`, which backs
 * `office:pipeline`, and eligibility from the agent and role lookups the
 * pipeline orchestrator performs.
 */
async function parityDifferences(
  profile: LegacyDevelopmentProfile,
  stores: LegacyStores,
): Promise<string[]> {
  const differences: string[] = [];
  const differ = (subject: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      differences.push(subject);
  };
  const current = await stores.officeManifests.findLatest(legacyProjectId);
  const manifest = current!.manifest;
  differ("office.name", profile.office?.name, manifest.office.name);
  differ(
    "roles",
    profile.roles.map(({ runtime: _runtime, ...role }) => role),
    [...manifest.office.roles].sort((left, right) =>
      left.id < right.id ? -1 : 1,
    ),
  );
  differ(
    "pipelines",
    sorted(profile.pipelines.map((pipeline) => pipeline.id)),
    sorted(manifest.pipelines.map((pipeline) => pipeline.id)),
  );

  const context = new GetOfficeContext(
    stores.projects,
    stores.profiles,
    stores.officeManifests,
  );
  for (const kind of officeTaskKinds) {
    const routed = await context
      .resolvePipeline(legacyProjectId, kind)
      .catch((error: unknown) => {
        if (error instanceof OfficePipelineNotFoundError) return null;
        throw error;
      });
    const route = profile.taskKinds.find((item) => item.kind === kind);
    differ(`taskKinds.${kind}`, route?.pipelineId ?? null, routed?.id ?? null);
    if (routed === null) continue;
    const described = profile.pipelines.find((item) => item.id === routed.id);
    differ(
      `pipelines.${routed.id}`,
      described === undefined
        ? null
        : {
            ...described,
            stages: described.stages.map(
              ({ eligibleAgents: _eligible, ...stage }) => stage,
            ),
          },
      routed,
    );
  }

  // The orchestrator's candidate rule, with its own lookups.
  const agents = await stores.runtime.listAgents(legacyProjectId);
  for (const pipeline of manifest.pipelines)
    for (const stage of pipeline.stages) {
      const candidates: string[] = [];
      for (const agent of agents) {
        if (!agent.enabled) continue;
        const role = await stores.runtime.findRole(
          agent.roleId,
          legacyProjectId,
        );
        if (role?.snapshot().key === stage.roleId) candidates.push(agent.name);
      }
      differ(
        `eligibleAgents.${pipeline.id}/${stage.id}`,
        sorted(
          profile.pipelines
            .find((item) => item.id === pipeline.id)
            ?.stages.find((item) => item.id === stage.id)?.eligibleAgents ?? [
            "<stage missing>",
          ],
        ),
        sorted(candidates),
      );
    }
  return differences;
}

async function applyManifest(
  stores: LegacyStores,
  change: (manifest: OfficeManifest) => void,
): Promise<void> {
  const manifest = structuredClone(legacyOfficeManifest());
  change(manifest);
  await new ApplyOfficeManifest(
    stores.projects,
    stores.officeManifests,
    stores.audit,
    stores.ids,
    stores.clock,
    stores.transactions,
  ).execute(legacyProjectId, manifest);
}

describe("GP-09 committed legacy fixtures", () => {
  test("the frozen dump and archives are the committed bytes", () => {
    // The committed files are the source of truth. No test rebuilds them
    // from head code; replacing one changes its checksum here, in review.
    expect(
      Object.fromEntries(
        [
          "pre-pack-project.sql",
          ...legacyArchiveFormats.map(legacyArchiveName),
        ].map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(legacyFixturePath(name)))
            .digest("hex"),
        ]),
      ),
    ).toEqual({
      "pre-pack-project.sql":
        "b0c8da9ee0687d209527e8ae55d34efd5456cc60b1feb4f429fafd9433e5ec84",
      "format-1.aioffice":
        "230f6fa4df9f92a3d61411cdda76a6366bdacb7d7c9f7cb683836ed820ce90da",
      "format-2.aioffice":
        "8d76868c1fe0136a986ba0c226b1863089d6201cd7f25065240cd9d45568bb33",
      "format-3.aioffice":
        "47704aec1153ae569c5c50d8756bd20e2e5df8b87e7c46ee3a49749e44b95e90",
      "format-4.aioffice":
        "c1d33c2f4c6444b404789b36dadf829616049f50c494e9db5a6a065680bcf5eb",
    });
  });

  test("the fixture builders are deterministic: two builds in one run give the same bytes", async () => {
    // Head against head only. Whether head still writes the frozen bytes is
    // not a requirement: the builders run current services, which may change.
    const build = async () => {
      const root = temporaryRoot();
      const database = await buildPrePackDatabase(root);
      databases.push(database);
      return {
        dump: dumpSqliteDatabase(database),
        archives: await buildLegacyArchives(root),
      };
    };
    const first = await build();
    const second = await build();
    expect(second.dump).toBe(first.dump);
    expect(second.archives).toEqual(first.archives);
    expect(Object.keys(first.archives)).toEqual(
      legacyArchiveFormats.map(String),
    );
  });

  test("the committed pre-pack database has no Domain Pack table and holds every legacy record kind", () => {
    const database = loadPrePackFixture(temporaryRoot());
    databases.push(database);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const rows = tableRows(database);
    expect(
      Object.keys(rows).filter((name) => /pack|definition/u.test(name)),
    ).toEqual([]);
    expect(rows.schema_migration!.at(-1)).toContain(
      "0040_task_execution_history.sql",
    );
    expect(
      Object.fromEntries(
        [
          "office_manifest_revision",
          "role",
          "agent",
          "pipeline_run",
          "pipeline_stage_run",
          "pipeline_override",
          "agent_run",
          "task",
          "review",
          "approval",
          "audit_event",
          "project_repository_identity",
        ].map((name) => [name, rows[name]!.length]),
      ),
    ).toEqual({
      office_manifest_revision: 1,
      role: 6,
      agent: 5,
      pipeline_run: 2,
      pipeline_stage_run: 8,
      pipeline_override: 1,
      agent_run: 3,
      task: 5,
      review: 2,
      approval: 2,
      audit_event: 16,
      project_repository_identity: 1,
    });
    // One stage of the fixture carries a recorded approval.
    expect(
      rows.pipeline_stage_run!.filter((row) => row.includes('"approved_by":"')),
    ).toHaveLength(1);
  });

  test("migrating the pre-pack database to head leaves every pre-existing row byte-identical", () => {
    const database = loadPrePackFixture(temporaryRoot());
    databases.push(database);
    const before = tableRows(database);
    expect(migrate(database, projectMigrations).applied).toEqual([
      "0041_project_pack_binding.sql",
      "0042_project_definition_ownership.sql",
      "0043_requirement_updated_event.sql",
      "0044_project_role_omission.sql",
      "0045_project_agent_disable.sql",
      "0046_project_workflow_override.sql",
      "0047_milestone_archived_status.sql",
      "0048_review_ready_task_dependencies.sql",
      "0049_task_completion_requires_completed_prerequisites.sql",
    ]);
    const preExisting = Object.keys(before).filter(
      (name) => name !== "schema_migration",
    );
    expect(tableRows(database, preExisting)).toEqual(
      Object.fromEntries(
        preExisting.map((name) => [
          name,
          name === "milestone"
            ? before[name]!.map((row) =>
                JSON.stringify({
                  ...(JSON.parse(row) as Record<string, unknown>),
                  archived_at: null,
                }),
              )
            : before[name],
        ]),
      ),
    );
    // The upgrade selects no pack and creates no definition.
    const added = tableRows(database);
    expect(added.project_pack_binding).toEqual([
      JSON.stringify({
        project_id: legacyProjectId,
        configuration_revision: 0,
        changed_at: null,
      }),
    ]);
    for (const name of [
      "project_pack_binding_pack",
      "project_owned_definition",
      "project_definition_override",
    ])
      expect(added[name]).toEqual([]);
    expect(migrate(database, projectMigrations).applied).toEqual([]);
  });

  test("an active pipeline run is advanced and approved after the upgrade with its pin unchanged", async () => {
    const stores = migratedFixture();
    const active = (await stores.pipelines.findActiveByTask(
      legacyActivePipelineTaskId,
      legacyProjectId,
    ))!;
    const runId = active.snapshot().id;
    const pin = () =>
      stores.database
        .query(
          `SELECT manifest_revision_id, manifest_revision, definition_json, started_by, created_at
           FROM pipeline_run WHERE id = ?`,
        )
        .get(runId);
    const pinned = pin();
    expect(active.currentStage()!.stageId).toBe("design");

    const staleVersion = active.snapshot().version;
    await completeActiveStage(
      stores,
      runId,
      legacyActivePipelineTaskId,
      "architect",
    );
    // The pre-pack run's optimistic fence still rejects a stale transition.
    active.cancel("stale-operator", stores.clock.now());
    expect(await stores.pipelines.save(active, staleVersion)).toBe(false);
    expect(
      (await stores.pipelineRuns.show(legacyProjectId, runId)).currentStage(),
    ).toMatchObject({ stageId: "implement", status: "active" });

    for (const agent of ["developer", "reviewer"])
      await completeActiveStage(
        stores,
        runId,
        legacyActivePipelineTaskId,
        agent,
      );
    // `review` requires approval: completion leaves the run waiting on it.
    const waiting = await stores.pipelineRuns.show(legacyProjectId, runId);
    expect(waiting.currentStage()).toMatchObject({
      stageId: "review",
      status: "awaiting_approval",
    });
    // The guard still holds: a stage cannot be completed past its approval.
    await expect(
      completeActiveStage(stores, runId, legacyActivePipelineTaskId, "qa"),
    ).rejects.toThrow();
    const approved = await stores.pipelineRuns.approveStage({
      projectId: legacyProjectId,
      pipelineRunId: runId,
      principal: localOperatorPrincipal,
      rationale: "Accepted after upgrade",
    });
    expect(approved.currentStage()).toMatchObject({
      stageId: "verify",
      status: "active",
    });
    expect(approved.snapshot().definition).toEqual(
      legacyOfficeManifest().pipelines.find((item) => item.id === "delivery"),
    );
    expect(pin()).toEqual(pinned);

    // The run that was already approved before the upgrade completes too.
    const earlier = (await stores.pipelines.findActiveByTask(
      legacyApprovedPipelineTaskId,
      legacyProjectId,
    ))!;
    await completeActiveStage(
      stores,
      earlier.snapshot().id,
      legacyApprovedPipelineTaskId,
      "qa",
    );
    expect(
      (
        await stores.pipelineRuns.show(legacyProjectId, earlier.snapshot().id)
      ).snapshot().status,
    ).toBe("completed");
  });
});

describe("GP-09 legacy-state parity on the upgraded fixture", () => {
  test("the profile is the pinned one and equals the Runtime's office, routing and eligibility readers", async () => {
    const stores = migratedFixture();
    const profile = await reader(stores).read(legacyProjectId);
    expect(profile.profileDigest).toBe(fixtureDigest);
    expect(JSON.parse(JSON.stringify(profile))).toEqual(
      legacyExpectedProfile("expected-profile.json"),
    );
    expect(await parityDifferences(profile, stores)).toEqual([]);
    expect(profile.taskKinds.map((route) => route.pipelineId)).toEqual([
      "delivery",
      "bugfix",
      "delivery",
      "discovery",
      "release",
    ]);
  });

  test("parity holds for unrouted kinds, disabled agents, several agents per role and a role without a Runtime role", async () => {
    const stores = migratedFixture();
    await applyManifest(stores, (manifest) => {
      manifest.pipelines = manifest.pipelines.filter(
        (pipeline) => pipeline.id !== "discovery",
      );
      manifest.office.roles = [
        ...manifest.office.roles,
        {
          id: "writer",
          title: "Writer",
          purpose: "Write",
          responsibilities: ["Write"],
        },
      ];
      manifest.pipelines[1]!.stages[0]!.roleId = "writer";
    });
    const now = stores.clock.now();
    await stores.runtime.saveAgent({
      id: legacyAgentId("developer-2"),
      projectId: legacyProjectId,
      roleId: `role:${legacyProjectId}:developer`,
      name: "developer-2",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const qa = (await stores.runtime.findAgent(legacyAgentId("qa")))!;
    await stores.runtime.saveAgent({ ...qa, enabled: false, updatedAt: now });

    const profile = await reader(stores).read(legacyProjectId);
    expect(await parityDifferences(profile, stores)).toEqual([]);
    expect(profile.metadata.officeManifestRevision).toBe(2);
    expect(
      profile.taskKinds.find((route) => route.kind === "research")!.pipelineId,
    ).toBeNull();
    const delivery = profile.pipelines.find((item) => item.id === "delivery")!;
    expect(delivery.stages.map((stage) => stage.eligibleAgents)).toEqual([
      ["architect"],
      ["developer", "developer-2"],
      ["reviewer"],
      [],
    ]);
    expect(profile.diagnostics).toEqual(
      expect.arrayContaining([
        { code: "manifest_role_without_runtime_role", subject: "writer" },
        { code: "runtime_role_outside_manifest", subject: "security-reviewer" },
        { code: "runtime_role_without_agent", subject: "release-engineer" },
        { code: "task_kind_unrouted", subject: "research" },
        { code: "stage_without_eligible_agent", subject: "bugfix/reproduce" },
        { code: "stage_without_eligible_agent", subject: "delivery/verify" },
      ]),
    );
    expect(profile.profileDigest).not.toBe(fixtureDigest);
  });

  test("the real orchestrator assigns exactly the agents the view lists as eligible", async () => {
    const prepare = async (disabled: readonly string[]) => {
      const stores = migratedFixture();
      const now = stores.clock.now();
      for (const [name, enabled] of [
        ["architect-2", true],
        ["architect-off", false],
      ] as const)
        await stores.runtime.saveAgent({
          id: legacyAgentId(name),
          projectId: legacyProjectId,
          roleId: `role:${legacyProjectId}:architect`,
          name,
          enabled,
          createdAt: now,
          updatedAt: now,
        });
      for (const name of disabled) {
        const agent = (await stores.runtime.findAgent(legacyAgentId(name)))!;
        await stores.runtime.saveAgent({
          ...agent,
          enabled: false,
          updatedAt: now,
        });
      }
      return stores;
    };
    const described = (
      await reader(await prepare([])).read(legacyProjectId)
    ).pipelines
      .find((item) => item.id === "delivery")!
      .stages.find((stage) => stage.id === "design")!.eligibleAgents;
    expect(described).toEqual(["architect", "architect-2"]);

    // Ask the orchestrator repeatedly, each time without its earlier picks,
    // until it finds nobody: the picks are its whole candidate set.
    const picked: string[] = [];
    for (;;) {
      const stores = await prepare(picked);
      const run = (await stores.pipelines.findActiveByTask(
        legacyActivePipelineTaskId,
        legacyProjectId,
      ))!;
      const orchestrator = new OrchestratePipelineStage(
        stores.pipelines,
        stores.runtime,
        stores.tasks,
        stores.pipelineRuns,
        stores.scheduling,
      );
      try {
        await orchestrator.execute({
          projectId: legacyProjectId,
          pipelineRunId: run.snapshot().id,
          pipelineStageRunId: run.currentStage()!.id,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineStageOrchestrationError);
        // With every candidate gone the view lists none either.
        expect(
          (await reader(stores).read(legacyProjectId)).pipelines
            .find((item) => item.id === "delivery")!
            .stages.find((stage) => stage.id === "design")!.eligibleAgents,
        ).toEqual([]);
        break;
      }
      const assigned = (
        await stores.pipelineRuns.show(legacyProjectId, run.snapshot().id)
      ).currentStage()!.assignedAgentId!;
      picked.push((await stores.runtime.findAgent(assigned))!.name);
      expect(picked.length).toBeLessThanOrEqual(described.length);
    }
    expect(sorted(picked)).toEqual(sorted(described));
  });

  test.each<[string, (manifest: OfficeManifest) => void, string[]]>([
    [
      "a stage role",
      (manifest) =>
        void (manifest.pipelines[0]!.stages[3]!.roleId = "reviewer"),
      ["pipelines.delivery", "eligibleAgents.delivery/verify"],
    ],
    [
      "a stage approval flag",
      (manifest) =>
        void (manifest.pipelines[0]!.stages[1]!.requiresApproval = true),
      ["pipelines.delivery"],
    ],
    [
      "the routing of a task kind",
      (manifest) => {
        manifest.pipelines[0]!.defaultFor = ["feature"];
        manifest.pipelines[1]!.defaultFor = ["bugfix", "maintenance"];
      },
      ["taskKinds.maintenance", "pipelines.delivery", "pipelines.bugfix"],
    ],
  ])(
    "the comparison fails when %s differs between the profile and the Runtime",
    async (_name, change, expected) => {
      const stores = migratedFixture();
      const before = await reader(stores).read(legacyProjectId);
      expect(await parityDifferences(before, stores)).toEqual([]);
      await applyManifest(stores, change);
      // The earlier profile no longer describes what the Runtime reads.
      const differences = await parityDifferences(before, stores);
      expect(differences).toEqual(expect.arrayContaining(expected));
      // A profile read now is in parity again, with a different digest.
      const after = await reader(stores).read(legacyProjectId);
      expect(await parityDifferences(after, stores)).toEqual([]);
      expect(after.profileDigest).not.toBe(before.profileDigest);
    },
  );

  test("the comparison fails when an agent's eligibility differs", async () => {
    const stores = migratedFixture();
    const before = await reader(stores).read(legacyProjectId);
    const agent = (await stores.runtime.findAgent(legacyAgentId("developer")))!;
    await stores.runtime.saveAgent({
      ...agent,
      enabled: false,
      updatedAt: stores.clock.now(),
    });
    expect(await parityDifferences(before, stores)).toEqual(
      expect.arrayContaining([
        "eligibleAgents.delivery/implement",
        "eligibleAgents.bugfix/fix",
      ]),
    );
  });

  test("reading the profile writes no row and no audit event", async () => {
    const stores = migratedFixture();
    const before = tableRows(stores.database);
    const first = await reader(stores).read(legacyProjectId);
    const second = await reader(stores).read(legacyProjectId);
    expect(canonicalLegacyDevelopmentProfile(second)).toBe(
      canonicalLegacyDevelopmentProfile(first),
    );
    await expect(reader(stores).read("absent-project")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(tableRows(stores.database)).toEqual(before);
    expect(before.audit_event).toHaveLength(16);
  });

  test("a project with no office and no Runtime role reads as the valid empty view", async () => {
    const stores = migratedFixture();
    await stores.projects.save(
      Project.create({
        id: "officeless",
        name: "No office",
        now: stores.clock.now(),
      }),
    );
    const profile = await reader(stores).read("officeless");
    expect(profile).toMatchObject({
      profileDigest:
        "sha256:5f040cf62cdf54e2cacf480c04166469a56f75c473b5d6623da8b7a716c114ab",
      office: null,
      roles: [],
      agents: [],
      taskKinds: [],
      pipelines: [],
      runtimeOnly: { roles: [], agents: [] },
      diagnostics: [],
    });
    // Another project's state never appears in it.
    expect(JSON.stringify(profile)).not.toContain("architect");
  });

  test("a pack binding changes only the binding metadata, never the profile or its digest", async () => {
    const stores = migratedFixture();
    const unbound = await reader(stores).read(legacyProjectId);
    expect(unbound.metadata.packBinding).toEqual({ present: false });
    await new SqliteProjectPackBindingRepository(stores.database).replace(
      legacyProjectId,
      0,
      [
        {
          id: parseDomainPackId("org.example.custom"),
          version: parseDomainPackVersion("1.0.0"),
          manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
        },
      ],
      stores.clock.now(),
    );
    const bound = await reader(stores).read(legacyProjectId);
    expect(bound.metadata.packBinding).toEqual({ present: true });
    expect(bound.profileDigest).toBe(fixtureDigest);
    expect({
      ...bound,
      metadata: { ...bound.metadata, packBinding: { present: false } },
    }).toEqual(unbound);
    expect(await parityDifferences(bound, stores)).toEqual([]);
  });
});

describe("GP-09 frozen portable archives of formats 1 to 4", () => {
  function openHost() {
    const root = temporaryRoot();
    const database = openDatabase(join(root, "project.sqlite"));
    databases.push(database);
    migrate(database, projectMigrations);
    const stores = legacyStores(
      database,
      new TickingClock("2026-10-02T00:00:00.000Z"),
      new SequenceIds("restore-host"),
    );
    return {
      stores,
      ...legacyPortability(database, stores.clock, stores.ids),
    };
  }

  test.each(legacyArchiveFormats)(
    "the committed format-%i archive restores with equal state, its pinned profile and its knowledge scope",
    async (format) => {
      const bytes = readFileSync(
        legacyFixturePath(legacyArchiveName(format)),
        "utf8",
      );
      const archive = parsePortableProjectArchive(bytes);
      expect(archive.manifest.formatVersion).toBe(format);
      expect(serializePortableProjectArchive(archive)).toBe(bytes);
      // What each format carries beyond the one before it.
      expect(archive.state.governance.taskRequirements?.length).toBe(
        format >= 2 ? 1 : undefined,
      );
      expect(archive.state.taskDependencies?.length).toBe(
        format >= 3 ? 1 : undefined,
      );
      expect(archive.state.taskExecutionHistory?.length).toBe(
        format >= 4 ? 2 : undefined,
      );

      const host = openHost();
      const target = temporaryRoot();
      writeFileSync(join(target, "package.json"), '{"name":"legacy"}\n');
      const restored = await host.service.restore({
        archive,
        rootPath: target,
      });
      expect(restored).toMatchObject({
        outcome: "restored",
        projectIdentity: legacyRepositoryId,
        stateChecksum: archive.manifest.revision.stateChecksum,
      });
      // A new Runtime-local project ID; the portable identity is the archive's.
      expect(restored.projectId).not.toBe(legacyProjectId);

      // Equal state, measured the way restore itself measures it: the local
      // state at the archive's format has the archive's checksum.
      const local = await host.states.loadPortableState(restored.projectId);
      const atFormat = portableStateAtFormatVersion(local, format);
      expect(portableStateChecksum(atFormat)).toBe(
        archive.manifest.revision.stateChecksum,
      );
      expect(atFormat).toEqual(archive.state);
      // No pack is selected and no definition is created by the restore.
      expect(local.packBinding).toEqual({
        configurationRevision: 0,
        packs: [],
      });
      expect(local.definitions).toEqual({
        revision: 0,
        owned: [],
        overrides: [],
      });

      // Restore's own verdict: the archive is this project's current state.
      expect(
        (await host.service.restore({ archive, rootPath: target })).outcome,
      ).toBe("unchanged");

      // Re-export. The exporter's base format has been 6 since GP-07, for
      // every project, so the archive is not written back at its own format;
      // its state at that format is still exactly the archive's.
      const exported = await host.service.backup(restored.projectId);
      expect(exported.archive.manifest.formatVersion).toBe(6);
      expect(
        portableStateAtFormatVersion(exported.archive.state, format),
      ).toEqual(archive.state);

      // The pinned profile: the office of the fixture, without guidance.
      const profile = await new ReadLegacyDevelopmentProfile({
        projects: host.stores.projects,
        officeManifests: host.stores.officeManifests,
        runtime: host.stores.runtime,
        bindings: new SqliteProjectPackBindingRepository(host.stores.database),
        transactions: host.stores.transactions,
      }).read(restored.projectId);
      expect(profile.profileDigest).toBe(restoredDigest);
      expect(JSON.parse(JSON.stringify(profile))).toEqual(
        legacyExpectedProfile("expected-restored-profile.json"),
      );

      // Knowledge recorded for this repository before the transfer is found
      // from the restored project: the scope is tenant plus repository ID.
      const scopes: KnowledgeScope[] = [];
      const record = { id: "knowledge-1" } as unknown as SearchKnowledgeHit;
      const store = {
        findKnowledge: async (scope: KnowledgeScope) => {
          scopes.push(scope);
          return scope.tenantId === "tenant-a" &&
            scope.repositoryId === legacyRepositoryId
            ? [record]
            : [];
        },
      } as unknown as AgentKnowledgeStore;
      const knowledge = new ManageKnowledgeAdmission(
        host.stores.projects,
        host.stores.tasks,
        host.stores.runtime,
        host.stores.identities,
        { state: "connected", tenantId: "tenant-a", store },
        host.stores.audit,
        host.stores.clock,
        host.stores.profiles,
        host.stores.governance,
      );
      expect(
        await knowledge.search({
          projectId: restored.projectId,
          text: "legacy decision",
        }),
      ).toEqual([record]);
      expect(scopes).toEqual([
        { tenantId: "tenant-a", repositoryId: legacyRepositoryId },
      ]);
    },
  );

  test("a restored archive has the same profile on every format, differing from the source only by guidance", () => {
    const strip = (
      name: "expected-profile.json" | "expected-restored-profile.json",
    ) => {
      const profile = legacyExpectedProfile(name) as LegacyDevelopmentProfile;
      const withoutGuidance = <T extends { guidance: unknown }>(role: T) => ({
        ...role,
        guidance: null,
      });
      return {
        ...profile,
        profileDigest: "",
        roles: profile.roles.map((role) => ({
          ...role,
          runtime: role.runtime === null ? null : withoutGuidance(role.runtime),
        })),
        runtimeOnly: {
          ...profile.runtimeOnly,
          roles: profile.runtimeOnly.roles.map(withoutGuidance),
        },
        vocabularyGaps: [],
      };
    };
    expect(strip("expected-restored-profile.json")).toEqual(
      strip("expected-profile.json"),
    );
    expect(restoredDigest).not.toBe(fixtureDigest);
  });
});

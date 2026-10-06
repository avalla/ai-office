import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  ManageProjectPortability,
  ProjectPortabilityError,
  ProjectRestorePolicyTargetError,
} from "@ai-office/application/project-portability/manage-project-portability.ts";
import {
  parsePortableProjectArchive,
  portableProjectDefinitionFormatVersion,
  portableProjectDescriptiveVocabularyFormatVersion,
  portableProjectWorkflowOverrideFormatVersion,
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

// GP-25: typed pack policies through resolution, project definitions, the
// upgrade plan, the selection guard and the portable archive, on SQLite.
// Policies are declarations here: nothing in this file starts a run.

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
    metadata: { name: id, description: "Policy contribution fixture" },
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

const roles = [{ id: "counsel" }, { id: "paralegal" }, { id: "clerk" }];
const taskTypes = [{ id: "matter" }];
// `archive` is a stage of `review` that no policy of version 1 names.
const review = {
  id: "review",
  title: "Review",
  taskType: "matter",
  stages: [
    { id: "draft", role: "paralegal" },
    { id: "check", role: "counsel" },
    { id: "sign", role: "counsel" },
    { id: "archive", role: "clerk" },
  ],
};
const intake = {
  id: "intake",
  taskType: "matter",
  stages: [{ id: "file", role: "clerk" }],
};
const memo = {
  id: "memo",
  taskType: "matter",
  stages: [{ id: "write", role: "paralegal" }],
};
const audit = {
  id: "audit",
  taskType: "matter",
  stages: [{ id: "inspect", role: "counsel" }],
};
const reviewPolicy = {
  id: "review-governance",
  title: "Review governance",
  description: "Counsel approves what a paralegal drafted",
  workflow: "review",
  enforcement: "enforced",
  stages: [
    {
      stage: "check",
      requiresApproval: true,
      requiresIndependentApproval: true,
      requiresDifferentAgentFrom: ["draft"],
      operations: ["document.read"],
    },
    {
      stage: "sign",
      requiresApproval: true,
      requiresDifferentAgentFrom: ["check", "draft"],
    },
  ],
};
const intakePolicy = {
  id: "intake-approval",
  workflow: "intake",
  stages: [{ stage: "file", requiresApproval: true }],
};
const auditPolicy = {
  id: "audit-governance",
  workflow: "audit",
  enforcement: "enforced",
};

const v1Bytes = packBytes("1.0.0", {
  roles,
  taskTypes,
  workflows: [review, intake, memo],
  policies: [reviewPolicy, intakePolicy],
});
// Version 2 changes the policy of `review`: one more admitted operation on
// `check`, and `archive` becomes a governed stage.
const reviewPolicyV2 = {
  ...reviewPolicy,
  stages: [
    { stage: "archive", requiresApproval: true },
    {
      ...reviewPolicy.stages[0]!,
      operations: ["document.read", "document.write"],
    },
    reviewPolicy.stages[1]!,
  ],
};
const v2Bytes = packBytes("2.0.0", {
  roles,
  taskTypes,
  workflows: [review, intake, memo],
  policies: [reviewPolicyV2, intakePolicy],
});
// Version 3 leaves every surviving workflow's policy as in version 1: it
// drops `intake` together with its policy and adds a governed `audit`.
const v3Bytes = packBytes("3.0.0", {
  roles,
  taskTypes,
  workflows: [review, memo, audit],
  policies: [reviewPolicy, auditPolicy],
});
// Version 4 adds a policy to the existing, so far ungoverned `memo`.
const v4Bytes = packBytes("4.0.0", {
  roles,
  taskTypes,
  workflows: [review, intake, memo],
  policies: [
    reviewPolicy,
    intakePolicy,
    { id: "memo-governance", workflow: "memo", enforcement: "enforced" },
  ],
});
// Version 5 keeps `intake` and removes its policy.
const v5Bytes = packBytes("5.0.0", {
  roles,
  taskTypes,
  workflows: [review, intake, memo],
  policies: [reviewPolicy],
});
// Version 6 renames the policy of `review` and changes no clause.
const v6Bytes = packBytes("6.0.0", {
  roles,
  taskTypes,
  workflows: [review, intake, memo],
  policies: [{ ...reviewPolicy, id: "review-rules" }, intakePolicy],
});
// Version 7 changes presentation only.
const v7Bytes = packBytes("7.0.0", {
  roles,
  taskTypes,
  workflows: [review, intake, memo],
  policies: [{ ...reviewPolicy, title: "Review rules" }, intakePolicy],
});
// The same definitions as version 1 without any policy.
const ungovernedBytes = packBytes(
  "1.0.0",
  { roles, taskTypes, workflows: [review, intake, memo] },
  "org.example.plain",
);
const otherBytes = packBytes(
  "1.0.0",
  {
    roles: [{ id: "auditor" }],
    taskTypes: [{ id: "inspection" }],
    workflows: [
      {
        id: "inspection",
        taskType: "inspection",
        stages: [{ id: "inspect", role: "auditor" }],
      },
    ],
    policies: [
      {
        id: "inspection-governance",
        workflow: "inspection",
        stages: [{ stage: "inspect", requiresApproval: true }],
      },
    ],
  },
  "org.example.other",
);
const untypedBytes = packBytes(
  "1.0.0",
  { policies: [{ id: "plain", title: "Plain" }] },
  "org.example.untyped",
);
const mixedBytes = packBytes(
  "1.0.0",
  {
    roles,
    taskTypes,
    workflows: [intake],
    policies: [intakePolicy, { id: "plain" }],
  },
  "org.example.mixed",
);

const v1 = identityOf(v1Bytes);
const v2 = identityOf(v2Bytes);
const v3 = identityOf(v3Bytes);
const v4 = identityOf(v4Bytes);
const v5 = identityOf(v5Bytes);
const v6 = identityOf(v6Bytes);
const v7 = identityOf(v7Bytes);
const ungoverned = identityOf(ungovernedBytes);
const other = identityOf(otherBytes);
const untyped = identityOf(untypedBytes);
const mixed = identityOf(mixedBytes);

const everyArtifact = [
  v1Bytes,
  v2Bytes,
  v3Bytes,
  v4Bytes,
  v5Bytes,
  v6Bytes,
  v7Bytes,
  ungovernedBytes,
  otherBytes,
  untypedBytes,
  mixedBytes,
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
  const root = temporaryRoot("ai-office-gp25-");
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
    ) => {
      const current = await storage.definitions.get(projectId);
      await storage.definitions.replace(
        {
          ...current,
          overrides: [
            ...current.overrides,
            {
              origin: "project_override" as const,
              source: { ...pack, kind: "workflows" as const, localId },
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

const clause = (
  stage: string,
  clauses: {
    requiresApproval?: boolean;
    requiresIndependentApproval?: boolean;
    requiresDifferentAgentFrom?: string[];
    operations?: string[];
  } = {},
) => ({
  stage,
  requiresApproval: false,
  requiresIndependentApproval: false,
  requiresDifferentAgentFrom: [],
  operations: [],
  ...clauses,
});

/** The policy of `review` in version 1, as every report states it. */
const reviewClauses = {
  policyId: pid("policies", "review-governance"),
  workflowId: pid("workflows", "review"),
  enforcement: "enforced",
  stages: [
    clause("check", {
      requiresApproval: true,
      requiresIndependentApproval: true,
      requiresDifferentAgentFrom: ["draft"],
      operations: ["document.read"],
    }),
    clause("sign", {
      requiresApproval: true,
      requiresDifferentAgentFrom: ["check", "draft"],
    }),
  ],
};
const reviewClausesV2 = {
  ...reviewClauses,
  stages: [
    clause("archive", { requiresApproval: true }),
    {
      ...reviewClauses.stages[0]!,
      operations: ["document.read", "document.write"],
    },
    reviewClauses.stages[1]!,
  ],
};
const intakeClauses = {
  policyId: pid("policies", "intake-approval"),
  workflowId: pid("workflows", "intake"),
  enforcement: "guidance",
  stages: [clause("file", { requiresApproval: true })],
};
const auditClauses = {
  policyId: pid("policies", "audit-governance"),
  workflowId: pid("workflows", "audit"),
  enforcement: "enforced",
  stages: [],
};

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

describe("GP-25 policy resolution and the derived policy view", () => {
  test("a pack whose policies are all typed resolves, and the view lists them with stable identities", async () => {
    const host = await project();
    await host.bind([v1]);
    const view = await host.configuration();
    // GP-06 definition order: by local ID inside one pack and kind.
    expect(view.policies).toEqual([
      {
        ...intakeClauses,
        effectiveId: effective(v1, "policies", "intake-approval"),
        origin: "pack_owned",
        state: "active",
      },
      {
        ...reviewClauses,
        effectiveId: effective(v1, "policies", "review-governance"),
        origin: "pack_owned",
        title: "Review governance",
        description: "Counsel approves what a paralegal drafted",
        state: "active",
      },
    ]);
    // The identities carry no version or digest and name the workflow view.
    expect(view.policies.map((policy) => policy.workflowId)).toEqual(
      ["intake", "review"].map((id) => pid("workflows", id)),
    );
    expect(view.workflows.map((workflow) => workflow.workflowId)).toEqual(
      ["intake", "memo", "review"].map((id) => pid("workflows", id)),
    );
    // The workflow view itself declares no approval or guard.
    expect(Object.keys(view.workflows[0]!.stages[0]!).sort()).toEqual([
      "id",
      "roleId",
    ]);
    // Another version keeps both stable identities.
    await host.bind([v7]);
    const next = await host.configuration();
    expect(next.policies[1]).toMatchObject({
      policyId: reviewClauses.policyId,
      workflowId: reviewClauses.workflowId,
      effectiveId: effective(v7, "policies", "review-governance"),
      title: "Review rules",
    });
  });

  test("the policy view is derived and outside the version-1 digest material", async () => {
    const host = await project();
    await host.bind([v1]);
    const governed = await host.configuration();
    expect(governed.configurationDigest).toBe(digestOfMaterial(governed));
    expect(governed.pin.configurationDigest).toBe(governed.configurationDigest);
    // The pack payload is digest material, so a clause still moves the digest.
    expect(
      governed.effectiveDefinitions.policies.map((item) => item.payload),
    ).toEqual([
      parseDomainPackManifest(v1Bytes).contributions.policies.find(
        (item) => item.id === "intake-approval",
      ),
      parseDomainPackManifest(v1Bytes).contributions.policies.find(
        (item) => item.id === "review-governance",
      ),
    ]);
    // A configuration without policies has an empty view and the documented
    // empty-input vector is unchanged.
    await host.bind([ungoverned]);
    const plain = await host.configuration();
    expect(plain.policies).toEqual([]);
    expect(plain.configurationDigest).toBe(digestOfMaterial(plain));
    await host.bind([]);
    const empty = await host.configuration();
    expect(empty.policies).toEqual([]);
    expect(empty.definitionRevision).toBe(0);
    await host.storage.projects.save(
      Project.create({ id: "untouched", name: "Untouched", now }),
    );
    expect((await host.configuration("untouched")).configurationDigest).toBe(
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    );
  });

  test("a pack with an untyped policy still fails closed, also beside typed ones", async () => {
    const host = await project();
    for (const pack of [untyped, mixed]) {
      await host.bind([pack]);
      const failure = await host.configuration().catch((error) => error);
      expect(failure).toBeInstanceOf(ProjectConfigurationResolutionError);
      expect(failure).toMatchObject({
        code: "unsupported_security_composition",
        message: `Pack ${pack.id}@${pack.version} has schema-1 policy declarations without typed clauses`,
      });
    }
    // The same closure fails when a governed pack is selected beside it.
    await host.bind([v1, untyped]);
    expect(await resolutionCode(host.configuration())).toBe(
      "unsupported_security_composition",
    );
  });
});

describe("GP-25 policies are pack-owned", () => {
  test("no project operation exists for a policy, and nothing is written", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    for (const operation of ["replace", "extend", "disable"] as const)
      expect(
        await conflict(
          host.mutate(
            host.mutation(
              v1,
              "review-governance",
              operation,
              operation === "disable"
                ? undefined
                : { id: "review-governance", title: "Weaker" },
              "policies",
            ),
          ),
        ),
      ).toMatchObject({ code: "unsupported_override_operation" });
    const owned = await conflict(
      host.mutate({
        action: "put_owned",
        kind: "policies",
        id: "project-policy",
        enabled: true,
        payload: { id: "project-policy" },
      }),
    );
    expect(owned.code).toBe("protected_security_invariant");
    expect(await host.authority()).toEqual(before);
    // Stored state of that kind is still rejected by the resolver.
    const stored = await host.storage.definitions.get("a");
    await expect(
      host.storage.definitions.replace(
        {
          ...stored,
          overrides: [
            {
              origin: "project_override",
              source: { ...v1, kind: "policies", localId: "review-governance" },
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
  });

  test("a workflow payload cannot carry a governance key, on the envelope or on a stage", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    const envelope = {
      id: "review",
      taskType: "matter",
      stages: review.stages,
    };
    const governance: [string, unknown][] = [
      ["enforcement", "guidance"],
      ["requiresApproval", false],
      ["requiresIndependentApproval", false],
      ["requiresDifferentAgentFrom", []],
      ["operations", ["document.write"]],
      ["capabilities", ["document.write"]],
    ];
    for (const [key, value] of governance) {
      const payloads = [
        { ...envelope, [key]: value },
        {
          ...envelope,
          stages: review.stages.map((stage) =>
            stage.id === "check" ? { ...stage, [key]: value } : stage,
          ),
        },
      ];
      for (const payload of payloads) {
        const replaced = host.mutation(v1, "review", "replace", payload);
        expect([
          key,
          (await conflict(host.definitions().preview("a", replaced))).code,
        ]).toEqual([key, "protected_security_invariant"]);
        expect([key, (await conflict(host.mutate(replaced))).code]).toEqual([
          key,
          "protected_security_invariant",
        ]);
      }
      // A project-owned workflow is the same envelope.
      expect([
        key,
        (
          await conflict(
            host.mutate({
              action: "put_owned",
              kind: "workflows",
              id: "own",
              enabled: true,
              payload: { id: "own", taskType: "t", stages: [], [key]: value },
            }),
          )
        ).code,
      ]).toEqual([key, "protected_security_invariant"]);
      expect([
        key,
        (
          await conflict(
            host.mutate({
              action: "put_owned",
              kind: "workflows",
              id: "own",
              enabled: true,
              payload: {
                id: "own",
                taskType: "t",
                stages: [{ id: "s", role: "r", [key]: value }],
              },
            }),
          )
        ).code,
      ]).toEqual([key, "protected_security_invariant"]);
    }
    // Any other unknown stage key keeps its GP-13 code.
    expect(
      (
        await conflict(
          host.mutate(
            host.mutation(v1, "review", "replace", {
              ...envelope,
              stages: [{ id: "check", role: "counsel", guard: "x" }],
            }),
          ),
        )
      ).code,
    ).toBe("malformed_origin_reference");
    expect(await host.authority()).toEqual(before);
  });
});

describe("GP-25 a workflow replacement keeps what the policy governs", () => {
  const replacement = (stages: { id: string; role: string }[]) => ({
    id: "review",
    title: "Project review",
    taskType: "matter",
    stages,
  });
  const stage = (id: string) => review.stages.find((item) => item.id === id)!;
  const violations = [
    {
      name: "drops a governed stage",
      stages: [stage("draft"), stage("sign"), stage("archive")],
      preview:
        "Workflow workflows/review must keep stage check, which policy policies/review-governance of exact source governs",
      resolution: `Policy ${effective(v1, "policies", "review-governance")} governs stage check, which workflow ${effective(v1, "workflows", "review")} does not declare`,
    },
    {
      name: "drops a stage that is only a separation predecessor",
      stages: [stage("check"), stage("sign")],
      preview:
        "Workflow workflows/review must keep stage draft, which policy policies/review-governance of exact source governs",
      resolution: `Policy ${effective(v1, "policies", "review-governance")} governs stage draft, which workflow ${effective(v1, "workflows", "review")} does not declare`,
    },
    {
      name: "moves a separation predecessor after its dependant",
      stages: [stage("check"), stage("draft"), stage("sign")],
      preview:
        "Workflow workflows/review must keep stage draft before stage check, as policy policies/review-governance of exact source requires",
      resolution: `Policy ${effective(v1, "policies", "review-governance")} requires stage draft before stage check in workflow ${effective(v1, "workflows", "review")}`,
    },
  ];

  test.each(violations)(
    "a replacement that $name is reported by preview, refused by apply and writes nothing",
    async ({ stages, preview }) => {
      const host = await project();
      await host.bind([v1]);
      const before = await host.authority();
      const mutation = host.mutation(
        v1,
        "review",
        "replace",
        replacement(stages),
      );
      const report = await host.definitions().preview("a", mutation);
      expect(report.issues[0]).toEqual({
        code: "policy_target_missing",
        message: preview,
      });
      expect(await conflict(host.mutate(mutation))).toEqual({
        code: "policy_target_missing",
        message: preview,
      });
      expect(await host.authority()).toEqual(before);
      expect(host.audits("project.definition_changed")).toEqual([]);
    },
  );

  test.each(violations)(
    "a stored replacement that $name fails resolution and is reported by project:definition:show",
    async ({ stages, preview, resolution }) => {
      const host = await project();
      await host.bind([v1]);
      await host.storeOverride(v1, "review", replacement(stages));
      const failure = await host.configuration().catch((error) => error);
      expect(failure).toBeInstanceOf(ProjectConfigurationResolutionError);
      expect(failure).toMatchObject({
        code: "policy_target_missing",
        message: resolution,
      });
      expect((await host.definitions().inspect("a")).issues).toEqual([
        {
          code: "policy_target_missing",
          message: preview,
          source: { ...v1, kind: "workflows", localId: "review" },
        },
      ]);
    },
  );

  test("every violation of one replacement is reported, in the policy's stage order", async () => {
    const host = await project();
    await host.bind([v1]);
    const report = await host
      .definitions()
      .preview(
        "a",
        host.mutation(v1, "review", "replace", replacement([stage("sign")])),
      );
    expect(report.issues.map((issue) => issue.message)).toEqual([
      "Workflow workflows/review must keep stage check, which policy policies/review-governance of exact source governs",
      "Workflow workflows/review must keep stage draft, which policy policies/review-governance of exact source governs",
    ]);
  });

  test("a replacement that keeps every governed stage may rename, reorder, drop ungoverned stages and add stages, which carry no clause", async () => {
    const host = await project();
    await host.bind([v1]);
    const mutation = host.mutation(
      v1,
      "review",
      "replace",
      replacement([
        { id: "triage", role: "clerk" },
        stage("draft"),
        { id: "research", role: "paralegal" },
        // The governed stages keep their IDs; a role may change.
        { id: "check", role: "paralegal" },
        stage("sign"),
      ]),
    );
    expect((await host.definitions().preview("a", mutation)).issues).toEqual(
      [],
    );
    await host.mutate(mutation);
    const view = await host.configuration();
    const workflow = view.workflows.find(
      (item) => item.workflowId === pid("workflows", "review"),
    )!;
    expect(workflow).toMatchObject({
      title: "Project review",
      customization: "replace",
    });
    expect(workflow.stages.map((item) => item.id)).toEqual([
      "triage",
      "draft",
      "research",
      "check",
      "sign",
    ]);
    const policy = view.policies.find(
      (item) => item.workflowId === workflow.workflowId,
    )!;
    // Exactly the pack's clauses: the added stages are not governed.
    expect(policy).toMatchObject({ ...reviewClauses, state: "active" });
    expect(policy.stages.map((item) => item.stage)).toEqual(["check", "sign"]);
  });

  test("a replacement that keeps the governed stage IDs may add the GP-10B-2 descriptive fields and still resolves", async () => {
    const host = await project();
    await host.bind([v1]);
    const mutation = host.mutation(v1, "review", "replace", {
      id: "review",
      title: "Project review",
      taskType: "matter",
      stages: [
        { ...stage("draft"), title: "Draft", objective: "Write it" },
        {
          id: "check",
          role: "counsel",
          title: "Check",
          objective: "Review it",
          checks: ["Cited", "Signed"],
        },
        stage("sign"),
      ],
    });
    expect((await host.definitions().preview("a", mutation)).issues).toEqual(
      [],
    );
    await host.mutate(mutation);
    const view = await host.configuration();
    const workflow = view.workflows.find(
      (item) => item.workflowId === pid("workflows", "review"),
    )!;
    expect(workflow.stages.find((item) => item.id === "check")).toMatchObject({
      title: "Check",
      objective: "Review it",
      checks: ["Cited", "Signed"],
    });
    const policy = view.policies.find(
      (item) => item.workflowId === workflow.workflowId,
    )!;
    expect(policy).toMatchObject({ ...reviewClauses, state: "active" });
  });

  test("a stage that carries a governance key and a descriptive field is refused as governance, and an unknown key beside one keeps its GP-13 code", async () => {
    const host = await project();
    await host.bind([v1]);
    const before = await host.authority();
    const code = async (extra: Record<string, unknown>) =>
      (
        await conflict(
          host.mutate(
            host.mutation(v1, "review", "replace", {
              id: "review",
              title: "Project review",
              taskType: "matter",
              stages: [{ id: "check", role: "counsel", ...extra }],
            }),
          ),
        )
      ).code;
    expect(
      await code({ title: "Check", checks: ["x"], requiresApproval: true }),
    ).toBe("protected_security_invariant");
    expect(await code({ title: "Check", guard: "x" })).toBe(
      "malformed_origin_reference",
    );
    expect(await host.authority()).toEqual(before);
  });

  test("extending a governed workflow keeps its policy active", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(
      host.mutation(v1, "intake", "extend", { title: "Project intake" }),
    );
    const view = await host.configuration();
    expect(
      view.policies.find((item) => item.policyId === intakeClauses.policyId),
    ).toMatchObject({ ...intakeClauses, state: "active" });
  });

  test("disabling a governed workflow resolves, and its policy is reported as inert", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(host.mutation(v1, "review", "disable"));
    const view = await host.configuration();
    expect(view.disabledWorkflows).toEqual([pid("workflows", "review")]);
    expect(
      view.policies.map(({ policyId, state }) => ({ policyId, state })),
    ).toEqual([
      { policyId: intakeClauses.policyId, state: "active" },
      { policyId: reviewClauses.policyId, state: "inert" },
    ]);
    expect(view.policies[1]).toMatchObject(reviewClauses);
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

describe("GP-25 policy changes in the upgrade plan", () => {
  test("the plan reports policy changes and the target policies under planDigest, and the audit event records both without a definition body", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(host.mutation(v1, "intake", "extend", { title: "Mine" }));
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.policyChanges).toEqual({
      availability: "available",
      changes: [
        {
          workflowId: pid("workflows", "review"),
          change: "changed",
          before: reviewClauses,
          after: reviewClausesV2,
          customized: false,
        },
      ],
    });
    expect(plan.targetPolicies).toEqual([intakeClauses, reviewClausesV2]);
    expect(plan.planDigest).toBe(planDigestOf(plan));
    // Both fields are approval material.
    expect(
      planDigestOf({
        ...plan,
        policyChanges: { ...plan.policyChanges, changes: [] },
      }),
    ).not.toBe(plan.planDigest);
    expect(planDigestOf({ ...plan, targetPolicies: [] })).not.toBe(
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
    expect(events[0]).toMatchObject({
      planDigest: plan.planDigest,
      policyChanges: plan.policyChanges,
      targetPolicies: plan.targetPolicies,
    });
    const recorded = JSON.stringify(events[0]);
    for (const body of [
      "Review governance",
      "Counsel approves what a paralegal drafted",
      "Mine",
    ])
      expect(recorded).not.toContain(body);
    expect((await host.configuration()).policies[1]).toMatchObject(
      reviewClausesV2,
    );
  });

  test("added and removed policies, a renamed policy and a customized workflow are reported; presentation alone is not a policy change", async () => {
    const host = await project();
    await host.bind([v1]);
    await host.mutate(host.mutation(v1, "review", "disable"));
    const changes = async (desired: PackIdentity) => {
      const plan = await host
        .upgrade()
        .preview({ projectId: "a", desired: [desired] });
      expect(plan.policyChanges.availability).toBe("available");
      return plan.policyChanges.availability === "available"
        ? plan.policyChanges.changes
        : [];
    };
    expect(await changes(v3)).toEqual([
      {
        workflowId: pid("workflows", "audit"),
        change: "added",
        after: auditClauses,
        customized: false,
      },
      {
        workflowId: pid("workflows", "intake"),
        change: "removed",
        before: intakeClauses,
        customized: false,
      },
    ]);
    expect(await changes(v5)).toEqual([
      {
        workflowId: pid("workflows", "intake"),
        change: "removed",
        before: intakeClauses,
        customized: false,
      },
    ]);
    expect(await changes(v6)).toEqual([
      {
        workflowId: pid("workflows", "review"),
        change: "changed",
        before: reviewClauses,
        after: { ...reviewClauses, policyId: pid("policies", "review-rules") },
        customized: true,
      },
    ]);
    // A new title is a template change of the policy definition only.
    const presentation = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v7] });
    expect(presentation.policyChanges).toEqual({
      availability: "available",
      changes: [],
    });
    expect(presentation.templates).toMatchObject({
      availability: "available",
      changes: [
        {
          packId,
          kind: "policies",
          localId: "review-governance",
          change: "changed",
        },
      ],
    });
  });

  test("a no-op plan carries both fields empty", async () => {
    const host = await project();
    await host.bind([v1]);
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v1] });
    expect(plan).toMatchObject({
      noop: true,
      policyChanges: { availability: "available", changes: [] },
      targetPolicies: [],
    });
    expect(plan.planDigest).toBe(planDigestOf(plan));
  });

  test("policy changes are unavailable when the previous artifacts are not installed, and approval still binds the target policies", async () => {
    const host = await project();
    await host.bind([v1]);
    const onlyTarget = catalogOf(v2Bytes);
    const plan = await host
      .upgrade(onlyTarget)
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.policyChanges).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    expect(plan.templates).toEqual(plan.policyChanges);
    expect(plan.targetPolicies).toEqual([intakeClauses, reviewClausesV2]);
    expect(plan.issues).toEqual([]);
    expect(plan.planDigest).toBe(planDigestOf(plan));
  });

  test("a replacement that does not satisfy the new version's policy blocks the upgrade", async () => {
    const host = await project();
    await host.bind([v1]);
    // Version 1 does not govern `archive`; version 2 does.
    await host.mutate(
      host.mutation(v1, "review", "replace", {
        id: "review",
        taskType: "matter",
        stages: review.stages.filter((item) => item.id !== "archive"),
      }),
    );
    const before = await host.authority();
    const plan = await host
      .upgrade()
      .preview({ projectId: "a", desired: [v2] });
    expect(plan.issues).toEqual([
      {
        code: "prospective_configuration_invalid",
        detail: "policy_target_missing",
        message: `The reconciled project configuration would not resolve: Policy ${effective(v2, "policies", "review-governance")} governs stage archive, which workflow ${effective(v2, "workflows", "review")} does not declare`,
      },
    ]);
    expect(plan.prospectiveConfigurationDigest).toBeUndefined();
    const blocked = await host
      .upgrade()
      .apply({
        projectId: "a",
        desired: [v2],
        approvedPlanDigest: plan.planDigest,
        actorId: "approver",
      })
      .catch((error) => error);
    expect(blocked).toBeInstanceOf(ProjectPackUpgradeError);
    expect(blocked).toMatchObject({ code: "upgrade_blocked" });
    expect(await host.authority()).toEqual(before);
  });
});

describe("GP-25 project:pack:apply refuses a policy change of an existing workflow", () => {
  const refusal = (workflow: string) => ({
    code: "policy_change_requires_upgrade",
    message: `The selection changes the policy of workflow ${pid("workflows", workflow)}; review and approve it with project:pack:upgrade`,
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
      name: "a changed clause",
      target: v2,
      workflow: "review",
      changes: [
        {
          workflowId: pid("workflows", "review"),
          change: "changed",
          before: reviewClauses,
          after: reviewClausesV2,
        },
      ],
    },
    {
      name: "a policy added to an existing workflow",
      target: v4,
      workflow: "memo",
      changes: [
        {
          workflowId: pid("workflows", "memo"),
          change: "added",
          after: {
            policyId: pid("policies", "memo-governance"),
            workflowId: pid("workflows", "memo"),
            enforcement: "enforced",
            stages: [],
          },
        },
      ],
    },
    {
      name: "a policy removed from an existing workflow",
      target: v5,
      workflow: "intake",
      changes: [
        {
          workflowId: pid("workflows", "intake"),
          change: "removed",
          before: intakeClauses,
        },
      ],
    },
    {
      name: "a renamed policy",
      target: v6,
      workflow: "review",
      changes: [
        {
          workflowId: pid("workflows", "review"),
          change: "changed",
          before: reviewClauses,
          after: {
            ...reviewClauses,
            policyId: pid("policies", "review-rules"),
          },
        },
      ],
    },
  ])(
    "$name is reported by preview and refused by apply with the typed error; nothing is written",
    async ({ target, workflow, changes }) => {
      const host = await project();
      await apply(host, [v1], 0);
      const before = await host.authority();
      const preview = await host.binding().preview("a", [target]);
      expect(preview.policyChanges).toEqual({
        availability: "available",
        changes,
      });
      expect(preview.issues).toEqual([refusal(workflow)]);
      const refused = await apply(host, [target], 1).catch((error) => error);
      expect(refused).toBeInstanceOf(ProjectPackBindingRefusedError);
      expect(refused).toMatchObject(refusal(workflow));
      expect(await host.authority()).toEqual(before);
      expect(host.audits("project.pack_binding_applied")).toHaveLength(1);
    },
  );

  test("adding and removing a pack, and a version that leaves every existing workflow's policy unchanged, are still applied", async () => {
    const host = await project();
    // Addition of a governed pack to an empty selection.
    const first = await host.binding().preview("a", [v1]);
    expect(first.issues).toEqual([]);
    expect(first.policyChanges).toEqual({
      availability: "available",
      changes: [
        {
          workflowId: pid("workflows", "intake"),
          change: "added",
          after: intakeClauses,
        },
        {
          workflowId: pid("workflows", "review"),
          change: "added",
          after: reviewClauses,
        },
      ],
    });
    expect(await apply(host, [v1], 0)).toMatchObject({
      configurationRevision: 1,
    });
    // A second governed pack beside it.
    expect((await host.binding().preview("a", [other, v1])).issues).toEqual([]);
    expect(await apply(host, [other, v1], 1)).toMatchObject({
      configurationRevision: 2,
    });
    expect(
      (await host.configuration()).policies.map((policy) => policy.policyId),
    ).toEqual([
      intakeClauses.policyId,
      reviewClauses.policyId,
      pid("policies", "inspection-governance", "org.example.other"),
    ]);
    // Version 3 drops `intake` with its policy and adds a governed `audit`.
    const additive = await host.binding().preview("a", [other, v3]);
    expect(additive.issues).toEqual([]);
    expect(additive.policyChanges).toMatchObject({
      availability: "available",
      changes: [
        { workflowId: pid("workflows", "audit"), change: "added" },
        { workflowId: pid("workflows", "intake"), change: "removed" },
      ],
    });
    expect(await apply(host, [other, v3], 2)).toMatchObject({
      configurationRevision: 3,
    });
    // Presentation only.
    await host.bind([v1]);
    expect((await host.binding().preview("a", [v7])).issues).toEqual([]);
    expect(await apply(host, [v7], 4)).toMatchObject({
      configurationRevision: 5,
    });
    // Removal of the governed pack.
    const removal = await host.binding().preview("a", []);
    expect(removal.issues).toEqual([]);
    expect(await apply(host, [], 5)).toMatchObject({
      configurationRevision: 6,
      packs: [],
    });
    expect((await host.configuration()).policies).toEqual([]);
  });

  test("an unchanged selection reads no artifact and reports no policy change", async () => {
    const host = await project();
    await apply(host, [v1], 0);
    const preview = await host.binding().preview("a", [v1]);
    expect(preview.policyChanges).toEqual({
      availability: "available",
      changes: [],
    });
    const empty = new InMemoryInstalledDomainPackCatalog(1, []);
    expect(await apply(host, [v1], 1, host.binding(empty))).toMatchObject({
      configurationRevision: 1,
    });
  });

  test("the policy refusal is listed after the capability refusal, and policy changes are unavailable when the current artifacts are not installed", async () => {
    const capabilities = [{ id: "draft" }, { id: "sign" }];
    const governed = (version: string, set: string[], operations: string[]) =>
      packBytes(
        version,
        {
          roles: [{ id: "counsel", capabilities: set }],
          taskTypes,
          capabilities,
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
        },
        "org.example.both",
      );
    const firstBytes = governed("1.0.0", ["draft"], ["a"]);
    const secondBytes = governed("2.0.0", ["draft", "sign"], ["a", "b"]);
    const first = identityOf(firstBytes);
    const second = identityOf(secondBytes);
    const host = await project(firstBytes, secondBytes);
    await apply(host, [first], 0);
    const preview = await host.binding().preview("a", [second]);
    expect(preview.issues.map((issue) => issue.code)).toEqual([
      "role_capability_change_requires_upgrade",
      "policy_change_requires_upgrade",
    ]);
    await expect(apply(host, [second], 1)).rejects.toMatchObject({
      code: "role_capability_change_requires_upgrade",
    });

    const onlySecond = catalogOf(secondBytes);
    const unresolved = await host.binding(onlySecond).preview("a", [second]);
    expect(unresolved.policyChanges).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    // The GP-11 rule already refuses this selection change; no second issue.
    expect(unresolved.issues.map((issue) => issue.code)).toEqual([
      "role_capability_change_requires_upgrade",
    ]);
    await expect(
      apply(host, [second], 1, host.binding(onlySecond)),
    ).rejects.toBeInstanceOf(ProjectPackBindingRefusedError);
    expect(await host.storage.packBindings.get("a")).toMatchObject({
      configurationRevision: 1,
      packs: [first],
    });
  });
});

describe("GP-25 creates nothing in the Runtime", () => {
  test("binding a pack with policies to the GP-09 fixture leaves run, approval and job tables identical", async () => {
    const database = loadPrePackFixture(temporaryRoot("ai-office-gp25-gp09-"));
    databases.push(database);
    migrate(database, projectMigrations);
    const stores = legacyStores(
      database,
      new TickingClock("2026-10-06T00:00:00.000Z"),
      new SequenceIds("gp25"),
    );
    // A copy of the development reference pack with policies; the committed
    // pack is not edited by this pull request.
    const bytes = mutatedDevelopmentPackBytes((manifest) => {
      (manifest.contributions as Record<string, unknown[]>).policies = [
        {
          id: "delivery-governance",
          workflow: "delivery",
          enforcement: "enforced",
          stages: [{ stage: "review", requiresApproval: true }],
        },
        {
          id: "bugfix-governance",
          workflow: "bugfix",
          stages: [
            {
              stage: "review",
              requiresApproval: true,
              requiresIndependentApproval: true,
              requiresDifferentAgentFrom: ["fix"],
              operations: ["filesystem.read"],
            },
          ],
        },
      ];
    });
    const { catalog, pack } = testCatalogWith(bytes);
    const bindings = new SqliteProjectPackBindingRepository(database);
    const definitions = new SqliteProjectDefinitionRepository(database);
    const before = tableRows(database);
    const binding = await new ManageProjectPackBinding({
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
      actorId: "gp25-test",
    });
    expect(binding.packs).toEqual([pack]);
    // Resolving the policies is a read.
    const resolved = await new ReadProjectConfiguration({
      projects: stores.projects,
      bindings,
      definitions,
      transactions: stores.transactions,
      catalog,
    }).read(legacyProjectId);
    expect(
      resolved.policies.map(({ policyId, state, enforcement }) => ({
        policyId,
        state,
        enforcement,
      })),
    ).toEqual([
      {
        policyId: "pack:org.ai-office.development/policies/bugfix-governance",
        state: "active",
        enforcement: "guidance",
      },
      {
        policyId: "pack:org.ai-office.development/policies/delivery-governance",
        state: "active",
        enforcement: "enforced",
      },
    ]);
    const after = tableRows(database);
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
      "capability_grants",
      "action_requests",
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
    expect(
      after
        .audit_event!.slice(before.audit_event!.length)
        .map((row) => (JSON.parse(row) as { event_type: string }).event_type),
    ).toEqual(["project.pack_binding_applied"]);
  });
});

describe("GP-25 portable archive and restore", () => {
  const validReplacement = {
    id: "review",
    title: "Project review",
    taskType: "matter",
    stages: [
      ...review.stages.filter((item) => item.id !== "archive"),
      { id: "publish", role: "clerk" },
    ],
  };
  const violatingReplacement = {
    id: "review",
    taskType: "matter",
    stages: review.stages.filter((item) => item.id !== "check"),
  };

  /** A source host without installed packs: state that passed no check. */
  async function archiveOf(pack: PackIdentity, payload?: object) {
    const origin = runtime(new InMemoryInstalledDomainPackCatalog(1, []));
    const source = temporaryRoot("ai-office-gp25-source-");
    writeFileSync(join(source, "package.json"), '{"name":"gp25"}\n');
    const imported = await origin.importProject(source);
    await origin.bind([pack], imported.projectId);
    if (payload !== undefined)
      await origin.storeOverride(pack, "review", payload, imported.projectId);
    const backup = await origin.portability().backup(imported.projectId);
    return {
      archive: parsePortableProjectArchive(
        serializePortableProjectArchive(backup.archive),
      ),
      identity: backup.projectIdentity,
    };
  }

  function restoreTarget(): string {
    const target = temporaryRoot("ai-office-gp25-target-");
    writeFileSync(join(target, "package.json"), '{"name":"gp25"}\n');
    return target;
  }

  test("a project bound to a pack with policies is archived at the format it had before, and restores", async () => {
    for (const payload of [undefined, validReplacement]) {
      const governed = await archiveOf(v1, payload);
      const plain = await archiveOf(ungoverned, payload);
      expect(governed.archive.manifest.formatVersion).toBe(
        plain.archive.manifest.formatVersion,
      );
      // No format is added: the definition format, or the GP-13 workflow
      // override format when the project replaced a workflow.
      expect(governed.archive.manifest.formatVersion).toBe(
        payload === undefined
          ? portableProjectDefinitionFormatVersion
          : portableProjectWorkflowOverrideFormatVersion,
      );
      expect(governed.archive.manifest.contents).toEqual(
        plain.archive.manifest.contents,
      );
      // No policy state exists in the archive: the pack tuple is all it names.
      expect(
        JSON.stringify([
          governed.archive.state.packBinding,
          governed.archive.state.definitions,
        ]),
      ).not.toContain("polic");
      const host = runtime(catalogOf(v1Bytes));
      const restored = await host
        .portability()
        .restore({ archive: governed.archive, rootPath: restoreTarget() });
      expect(restored.outcome).toBe("restored");
      const view = await host.configuration(restored.projectId);
      expect(view.policies.map((policy) => policy.policyId)).toEqual([
        intakeClauses.policyId,
        reviewClauses.policyId,
      ]);
      expect(view.policies[1]).toMatchObject({
        ...reviewClauses,
        state: "active",
      });
    }
  });

  test("restore preflight rejects a stored replacement that does not keep a governed stage, atomically", async () => {
    const { archive, identity } = await archiveOf(v1, violatingReplacement);
    const host = runtime(catalogOf(v1Bytes));
    const target = restoreTarget();
    const before = host.database
      .query<{ count: number }, []>("SELECT total_changes() AS count")
      .get()!.count;
    const rejected = await host
      .portability()
      .restore({ archive, rootPath: target })
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(ProjectRestorePolicyTargetError);
    expect(rejected).toBeInstanceOf(ProjectPortabilityError);
    expect(rejected).toMatchObject({
      code: "policy_target_missing",
      message:
        "Portable restore rejected (policy_target_missing): workflow replacement workflows/review of pack org.example.legal@1.0.0 does not keep stage check, which policy policies/review-governance governs; nothing was restored",
    });
    expect(
      host.database
        .query<{ count: number }, []>("SELECT total_changes() AS count")
        .get()!.count,
    ).toBe(before);
    expect(await host.identities.findProjectId(identity)).toBeNull();
    for (const table of [
      "project",
      "project_pack_binding",
      "project_definition_head",
      "project_definition_override",
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
  });

  test("a format-10 archive (descriptive stage fields) still runs the policy restore preflight", async () => {
    const described = (stages: { id: string; role: string }[]) => ({
      id: "review",
      taskType: "matter",
      stages: stages.map((item) => ({ ...item, title: `Title ${item.id}` })),
    });
    const valid = await archiveOf(v1, described(review.stages));
    expect(valid.archive.manifest.formatVersion).toBe(
      portableProjectDescriptiveVocabularyFormatVersion,
    );
    const host = runtime(catalogOf(v1Bytes));
    const restored = await host
      .portability()
      .restore({ archive: valid.archive, rootPath: restoreTarget() });
    expect(restored.outcome).toBe("restored");
    const violating = await archiveOf(
      v1,
      described(review.stages.filter((item) => item.id !== "check")),
    );
    expect(violating.archive.manifest.formatVersion).toBe(
      portableProjectDescriptiveVocabularyFormatVersion,
    );
    const rejected = await runtime(catalogOf(v1Bytes))
      .portability()
      .restore({ archive: violating.archive, rootPath: restoreTarget() })
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(ProjectRestorePolicyTargetError);
    expect(rejected).toMatchObject({ code: "policy_target_missing" });
  });

  test("without the exact closure there is no restore verdict, and resolution fails closed once the pack is installed", async () => {
    const { archive } = await archiveOf(v1, violatingReplacement);
    // Another version of the pack is installed; it is never used to judge.
    const host = runtime(catalogOf(v2Bytes));
    const restored = await host
      .portability()
      .restore({ archive, rootPath: restoreTarget() });
    expect(restored.outcome).toBe("restored");
    expect(await resolutionCode(host.configuration(restored.projectId))).toBe(
      "pack_unavailable",
    );
    expect(
      await resolutionCode(
        host.configuration(restored.projectId, catalogOf(v1Bytes, v2Bytes)),
      ),
    ).toBe("policy_target_missing");
  });
});

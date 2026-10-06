import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ProjectPackUpgradeError,
  ReconcileProjectPackUpgrade,
} from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import { ProjectDefinitionConflictError } from "@ai-office/application/domain-pack/project-definition.ts";
import { ProjectConfigurationResolutionError } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { portableProjectArchiveSchemaV8 } from "@ai-office/application/project-portability/project-snapshot.ts";
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
    metadata: { name: "Legal", description: "Agent archetype fixture" },
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
  { id: "counsel", title: "Counsel", capabilities: ["draft", "review"] },
  { id: "clerk", capabilities: ["file"] },
  { id: "paralegal" },
];
const shared = {
  roles,
  prompts: [{ id: "brief" }, { id: "style" }, { id: "tone" }],
  knowledge: [{ id: "precedents" }, { id: "statutes" }],
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
};
const v1Bytes = packBytes("1.0.0", {
  ...shared,
  agents: [
    {
      id: "drafter",
      title: "Drafter",
      role: "counsel",
      prompts: ["brief", "style"],
      knowledge: ["statutes"],
      capabilities: ["draft"],
    },
    { id: "filer", role: "clerk", capabilities: ["file"] },
    { id: "researcher", knowledge: ["precedents"] },
    { id: "intern", title: "Intern" },
  ],
});
// Same roles and capability sets. The drafter is renamed, drops a prompt and
// its knowledge and requests `review`; the filer gets a title; the researcher
// gets the title a project extension would supply, a description and a role;
// the intern is removed; an auditor is added.
const v2Bytes = packBytes("2.0.0", {
  ...shared,
  agents: [
    {
      id: "drafter",
      title: "Lead drafter",
      role: "counsel",
      prompts: ["brief"],
      capabilities: ["draft", "review"],
    },
    { id: "filer", title: "Filer", role: "clerk", capabilities: ["file"] },
    {
      id: "researcher",
      title: "Researcher",
      description: "Finds precedents",
      role: "paralegal",
      knowledge: ["precedents", "statutes"],
    },
    { id: "auditor", role: "counsel" },
  ],
});
// counsel loses `review`, the prompt `tone` and the role `paralegal` are gone.
const v3Bytes = packBytes("3.0.0", {
  roles: [
    { id: "counsel", title: "Counsel", capabilities: ["draft"] },
    { id: "clerk", capabilities: ["file"] },
  ],
  prompts: [{ id: "brief" }, { id: "style" }],
  knowledge: shared.knowledge,
  capabilities: shared.capabilities,
  agents: [
    {
      id: "drafter",
      title: "Drafter",
      role: "counsel",
      prompts: ["brief", "style"],
      knowledge: ["statutes"],
      capabilities: ["draft"],
    },
    { id: "filer", role: "clerk", capabilities: ["file"] },
    { id: "researcher", knowledge: ["precedents"] },
    { id: "intern", title: "Intern" },
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
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp12-"));
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
  const selection = () => new ManageProjectPackBinding(ports());
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
    kind = "agents",
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
    selection,
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

const source = (pack: PackIdentity, localId: string, kind = "agents") => ({
  ...pack,
  kind,
  localId,
});
const pid = (kind: string, localId: string) =>
  `pack:${packId}/${kind}/${localId}`;
const agentId = (localId: string) => pid("agents", localId);
const agentOf = (
  view: Awaited<ReturnType<Harness["configuration"]>>,
  id: string,
) => view.agents.find((item) => item.agentId === id);

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

describe("GP-12 agent customization in project definitions", () => {
  test("replacing a pack agent is previewed, stored in one order and audited without its body", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const mutation = {
      action: "put_override",
      source: source(h.v1, "filer"),
      operation: "replace",
      payload: {
        id: "filer",
        title: "Our reviewer",
        role: "counsel",
        prompts: ["tone", "brief"],
        knowledge: ["statutes", "precedents"],
        capabilities: ["review", "draft"],
      },
    };
    const preview = await h.definitions.preview("a", mutation);
    expect(preview.issues).toEqual([]);
    expect(await h.revision()).toBe(0);

    const state = await h.mutate(mutation);

    expect(state.overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v1, "filer"),
        operation: "replace",
        revision: 1,
        payload: {
          id: "filer",
          title: "Our reviewer",
          role: "counsel",
          prompts: ["brief", "tone"],
          knowledge: ["precedents", "statutes"],
          capabilities: ["draft", "review"],
        },
        actorId: "author",
        changedAt: now.toISOString(),
      },
    ]);
    expect(await h.storage.definitions.get("a")).toEqual(state);
    const audit = h.audits("project.definition_changed");
    expect(audit).toEqual([
      {
        actorId: "author",
        payload: {
          action: "put_override",
          origin: "project_override",
          identity: source(h.v1, "filer"),
          operation: "replace",
          previousRevision: 0,
          newRevision: 1,
          previousEntryRevision: null,
          newEntryRevision: 1,
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("Our reviewer");
    expect(agentOf(await h.configuration(), agentId("filer"))).toEqual({
      agentId: agentId("filer"),
      effectiveId: `pack:${packId}@1.0.0#${h.v1.manifestDigest}/agents/filer`,
      origin: "pack_owned",
      title: "Our reviewer",
      roleId: pid("roles", "counsel"),
      prompts: [pid("prompts", "brief"), pid("prompts", "tone")],
      knowledge: [pid("knowledge", "precedents"), pid("knowledge", "statutes")],
      capabilities: [
        pid("capabilities", "draft"),
        pid("capabilities", "review"),
      ],
      customization: "replace",
    });
  });

  test("a reference the source does not declare, or a request beyond the role, is reported before anything is stored", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const before = await h.authority();
    const cases: [object, string, string][] = [
      [{ role: "partner" }, "source_definition_missing", "roles/partner"],
      [
        { prompts: ["brief", "closing"] },
        "source_definition_missing",
        "prompts/closing",
      ],
      [
        { knowledge: ["treaties"] },
        "source_definition_missing",
        "knowledge/treaties",
      ],
      [
        { role: "counsel", capabilities: ["sign"] },
        "source_definition_missing",
        "capabilities/sign",
      ],
      // `file` is clerk's and `draft` is counsel's.
      [
        { role: "counsel", capabilities: ["draft", "file"] },
        "agent_capability_exceeds_role",
        "capabilities/file",
      ],
      [
        { role: "clerk", capabilities: ["draft"] },
        "agent_capability_exceeds_role",
        "capabilities/draft",
      ],
      [
        { role: "paralegal", capabilities: ["file"] },
        "agent_capability_exceeds_role",
        "capabilities/file",
      ],
    ];
    for (const [fields, code, subject] of cases) {
      const mutation = {
        action: "put_override",
        source: source(h.v1, "filer"),
        operation: "replace",
        payload: { id: "filer", ...fields },
      };
      const preview = await h.definitions.preview("a", mutation);
      expect(
        preview.issues.map((issue) => issue.code),
        subject,
      ).toEqual([code]);
      expect(preview.issues[0]?.message).toContain(subject);
      expect(await conflictCode(h.mutate(mutation)), subject).toBe(code);
    }
    expect(await h.authority()).toEqual(before);
    expect(before.definitions.revision).toBe(0);
  });

  test("project:definition:show reports a stored replacement that exceeds its role", async () => {
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
            source: { ...h.v1, kind: "agents", localId: "filer" },
            operation: "replace",
            revision: 1,
            payload: { id: "filer", role: "clerk", capabilities: ["draft"] },
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
        code: "agent_capability_exceeds_role",
        message: expect.stringContaining("capabilities/draft") as unknown,
        source: source(h.v1, "filer"),
      },
    ]);
    // The resolver is the authority and fails closed on the same state.
    await expect(h.configuration()).rejects.toMatchObject({
      code: "agent_capability_exceeds_role",
    });
  });

  test("every list stored through the mutation and upgrade paths is in the order archive format 8 requires", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const exportable = async () => {
      const { revision, owned, overrides } =
        await h.storage.definitions.get("a");
      // Exactly the `definitions` section a backup writes.
      return portableProjectArchiveSchemaV8.shape.state.shape.definitions.safeParse(
        { revision, owned, overrides },
      );
    };
    await h.override(h.v1, "filer", "replace", {
      id: "filer",
      role: "counsel",
      prompts: ["tone", "style", "brief"],
      knowledge: ["statutes", "precedents"],
      capabilities: ["review", "draft"],
    });
    await h.override(h.v1, "researcher", "extend", { title: "Ours" });
    for (const id of ["voice", "house"]) await h.add("prompts", id);
    await h.add("agents", "helper", {
      id: "helper",
      prompts: ["voice", "house"],
    });
    expect((await exportable()).success).toBe(true);
    expect(
      (await h.storage.definitions.get("a")).overrides.find(
        (item) => item.source.localId === "filer",
      )?.payload,
    ).toEqual({
      id: "filer",
      role: "counsel",
      prompts: ["brief", "style", "tone"],
      knowledge: ["precedents", "statutes"],
      capabilities: ["draft", "review"],
    });

    // A converted extension copies the new template's lists.
    const resolutions = [
      { source: source(h.v1, "researcher"), action: "convert_to_replace" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);
    expect(
      (await h.storage.definitions.get("a")).overrides.find(
        (item) => item.source.localId === "researcher",
      )?.payload,
    ).toMatchObject({ knowledge: ["precedents", "statutes"] });
    expect((await exportable()).success).toBe(true);
  });

  test("the mutation contract refuses malformed and out-of-scope agent payloads; nothing is written", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const before = await h.authority();
    const replace = (fields: object) =>
      h.override(h.v1, "filer", "replace", { id: "filer", ...fields });

    expect(await conflictCode(replace({ capabilities: ["file"] }))).toBe(
      "agent_capability_exceeds_role",
    );
    expect(await conflictCode(replace({ prompts: [] }))).toBe(
      "malformed_origin_reference",
    );
    expect(await conflictCode(replace({ prompts: ["brief", "brief"] }))).toBe(
      "conflicting_ownership_metadata",
    );
    expect(await conflictCode(replace({ model: "large" }))).toBe(
      "protected_security_invariant",
    );
    expect(
      await conflictCode(
        h.override(h.v1, "researcher", "extend", {
          title: "Researcher",
          role: "counsel",
        }),
      ),
    ).toBe("protected_security_invariant");
    expect(
      await conflictCode(
        h.override(
          h.v1,
          "counsel",
          "replace",
          { id: "counsel", prompts: ["brief"] },
          "roles",
        ),
      ),
    ).toBe("protected_security_invariant");
    expect(
      await conflictCode(
        h.add("agents", "helper", { id: "helper", capabilities: ["file"] }),
      ),
    ).toBe("protected_security_invariant");
    expect(
      await conflictCode(h.override(h.v1, "filer", "disable", { id: "filer" })),
    ).toBe("malformed_origin_reference");
    expect(await h.authority()).toEqual(before);
  });

  test("disabling a pack agent is stored and audited, and removing the override restores it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const mutation = {
      action: "put_override",
      source: source(h.v1, "drafter"),
      operation: "disable",
    };
    expect((await h.definitions.preview("a", mutation)).issues).toEqual([]);

    const state = await h.mutate(mutation);

    expect(state.overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v1, "drafter"),
        operation: "disable",
        revision: 1,
        actorId: "author",
        changedAt: now.toISOString(),
      },
    ]);
    expect(await h.storage.definitions.get("a")).toEqual(state);
    expect(h.audits("project.definition_changed")).toMatchObject([
      {
        actorId: "author",
        payload: {
          action: "put_override",
          identity: source(h.v1, "drafter"),
          operation: "disable",
          newRevision: 1,
        },
      },
    ]);
    const resolved = await h.configuration();
    expect(resolved.disabledAgents).toEqual([agentId("drafter")]);
    expect(resolved.agents.map((item) => item.agentId)).toEqual([
      agentId("filer"),
      agentId("intern"),
      agentId("researcher"),
    ]);

    await h.mutate({
      action: "remove_override",
      source: source(h.v1, "drafter"),
    });
    const restored = await h.configuration();
    expect(restored.disabledAgents).toEqual([]);
    expect(agentOf(restored, agentId("drafter"))).toMatchObject({
      roleId: pid("roles", "counsel"),
      customization: "none",
    });
  });

  test("omitting the role of an enabled agent fails closed until the agent is disabled or replaced", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "clerk", "disable", undefined, "roles");
    await expect(h.configuration()).rejects.toMatchObject({
      code: "disabled_required_definition",
    });
    await expect(h.configuration()).rejects.toBeInstanceOf(
      ProjectConfigurationResolutionError,
    );
    await h.override(h.v1, "filer", "disable");
    const resolved = await h.configuration();
    expect(resolved.disabledAgents).toEqual([agentId("filer")]);
    expect(resolved.omittedRoles).toEqual([pid("roles", "clerk")]);
  });

  test("a project-added agent references project definitions and carries no capabilities", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.add("roles", "auditor");
    await h.add("prompts", "house");
    await h.add("knowledge", "handbook");
    const state = await h.add("agents", "helper", {
      id: "helper",
      title: "Helper",
      role: "auditor",
      prompts: ["house"],
      knowledge: ["handbook"],
    });
    expect(state.owned.find((item) => item.kind === "agents")).toEqual({
      origin: "project_owned",
      kind: "agents",
      id: "helper",
      revision: 1,
      enabled: true,
      payload: {
        id: "helper",
        title: "Helper",
        role: "auditor",
        prompts: ["house"],
        knowledge: ["handbook"],
      },
      actorId: "author",
      changedAt: now.toISOString(),
    });
    expect(agentOf(await h.configuration(), "project:agents/helper")).toEqual({
      agentId: "project:agents/helper",
      effectiveId: "project:agents/helper",
      origin: "project_owned",
      title: "Helper",
      roleId: "project:roles/auditor",
      prompts: ["project:prompts/house"],
      knowledge: ["project:knowledge/handbook"],
      capabilities: [],
      customization: "none",
    });
    // A pack definition is outside a project agent's namespace: stored, as
    // GP-07 stores a workflow reference, and rejected by the resolver.
    await h.add("agents", "stray", { id: "stray", role: "counsel" });
    await expect(h.configuration()).rejects.toMatchObject({
      code: "missing_agent_reference",
    });
  });
});

describe("GP-12 agent archetypes across a pack upgrade", () => {
  test("a replaced agent keeps its identity and the project's envelope; the change is reported", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "drafter", "replace", {
      id: "drafter",
      title: "Our drafter",
      role: "counsel",
      prompts: ["tone"],
      capabilities: ["review"],
    });
    const before = await h.configuration();
    const stored = (await h.storage.definitions.get("a")).overrides[0]!;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "drafter"),
        operation: "replace",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "drafter"),
      },
    ]);
    // Every changed agent is in the existing template change list.
    expect(
      plan.templates.availability === "available" &&
        plan.templates.changes.filter((item) => item.kind === "agents"),
    ).toEqual([
      {
        packId,
        kind: "agents",
        localId: "auditor",
        change: "added",
        customized: false,
      },
      {
        packId,
        kind: "agents",
        localId: "drafter",
        change: "changed",
        customized: true,
      },
      {
        packId,
        kind: "agents",
        localId: "filer",
        change: "changed",
        customized: false,
      },
      {
        packId,
        kind: "agents",
        localId: "intern",
        change: "removed",
        customized: false,
      },
      {
        packId,
        kind: "agents",
        localId: "researcher",
        change: "changed",
        customized: false,
      },
    ]);
    // Role sets are the approved bound; an agent request adds no second report.
    expect(plan.roleCapabilityChanges).toEqual({
      availability: "available",
      changes: [],
    });
    expect(JSON.stringify(plan)).not.toContain("Our drafter");
    await applyUpgrade(h, [h.v2], plan.planDigest);

    // The project entry is carried over whole; only its pack tuple moved.
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      { ...stored, source: source(h.v2, "drafter") },
    ]);
    const after = await h.configuration();
    expect(after.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    expect(agentOf(after, agentId("drafter"))).toEqual({
      ...agentOf(before, agentId("drafter")),
      effectiveId: `pack:${packId}@2.0.0#${h.v2.manifestDigest}/agents/drafter`,
    });
    expect(agentOf(after, agentId("drafter"))).toMatchObject({
      title: "Our drafter",
      prompts: [pid("prompts", "tone")],
      capabilities: [pid("capabilities", "review")],
      customization: "replace",
    });
    // Every agent present in both versions keeps its stable identity.
    for (const id of ["drafter", "filer", "researcher"].map(agentId)) {
      expect(agentOf(before, id)?.agentId).toBe(id);
      expect(agentOf(after, id)?.agentId).toBe(id);
      expect(agentOf(after, id)?.effectiveId).not.toBe(
        agentOf(before, id)?.effectiveId,
      );
    }
  });

  test("a request that exceeds the new version's role set blocks until the project changes it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "filer", "replace", {
      id: "filer",
      title: "Our reviewer",
      role: "counsel",
      capabilities: ["review"],
    });
    const before = await h.authority();

    // 3.0.0 narrows counsel to `draft`.
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v3] });
    expect(plan.issues).toEqual([
      {
        code: "prospective_configuration_invalid",
        detail: "agent_capability_exceeds_role",
        message: expect.stringMatching(
          /would not resolve: .*agents\/filer.*capabilities\/review.*roles\/counsel/u,
        ) as unknown,
      },
    ]);
    expect(plan.prospectiveConfigurationDigest).toBeUndefined();
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "filer"),
        operation: "replace",
        outcome: "retargeted",
        upstream: "unchanged",
        target: source(h.v3, "filer"),
      },
    ]);
    await expect(
      applyUpgrade(h, [h.v3], plan.planDigest),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    await expect(
      applyUpgrade(h, [h.v3], plan.planDigest),
    ).rejects.toBeInstanceOf(ProjectPackUpgradeError);
    // It is not an override conflict: no resolution answers it.
    const answered = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v3],
      resolutions: [
        { source: source(h.v1, "filer"), action: "remove_override" },
      ],
    });
    expect(answered.issues.map((issue) => issue.detail)).toEqual([
      "agent_capability_exceeds_role",
    ]);
    expect(answered.ignoredResolutions).toHaveLength(1);
    expect(await h.authority()).toEqual(before);

    // The project resolves it explicitly: a request valid in both versions.
    await h.mutate({
      action: "put_override",
      source: source(h.v1, "filer"),
      operation: "replace",
      expectedEntryRevision: 1,
      payload: {
        id: "filer",
        title: "Our reviewer",
        role: "counsel",
        capabilities: ["draft"],
      },
    });
    const clean = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v3] });
    expect(clean.issues).toEqual([]);
    await applyUpgrade(h, [h.v3], clean.planDigest);
    expect(agentOf(await h.configuration(), agentId("filer"))).toMatchObject({
      title: "Our reviewer",
      roleId: pid("roles", "counsel"),
      capabilities: [pid("capabilities", "draft")],
    });
  });

  test("a reference that no longer resolves in the new version blocks the upgrade", async () => {
    for (const [fields, subject] of [
      [{ prompts: ["brief", "tone"] }, "prompts/tone"],
      [{ role: "paralegal" }, "roles/paralegal"],
    ] as const) {
      const h = await harness();
      await h.bind([h.v1]);
      await h.override(h.v1, "researcher", "replace", {
        id: "researcher",
        ...fields,
      });
      const before = await h.authority();
      const plan = await h
        .upgrade()
        .preview({ projectId: "a", desired: [h.v3] });
      expect(plan.issues, subject).toEqual([
        {
          code: "prospective_configuration_invalid",
          detail: "missing_agent_reference",
          message: expect.stringContaining(subject) as unknown,
        },
      ]);
      expect(plan.issues[0]?.message).toContain("agents/researcher");
      await expect(
        applyUpgrade(h, [h.v3], plan.planDigest),
      ).rejects.toMatchObject({ code: "upgrade_blocked" });
      expect(await h.authority()).toEqual(before);
    }
  });

  test("an extension the new version leaves room for follows the upgrade and takes the new references", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "drafter", "extend", { description: "Ours" });

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      { operation: "extend", outcome: "retargeted", upstream: "changed" },
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect(agentOf(await h.configuration(), agentId("drafter"))).toEqual({
      agentId: agentId("drafter"),
      effectiveId: `pack:${packId}@2.0.0#${h.v2.manifestDigest}/agents/drafter`,
      origin: "pack_owned",
      title: "Lead drafter",
      description: "Ours",
      roleId: pid("roles", "counsel"),
      prompts: [pid("prompts", "brief")],
      knowledge: [],
      capabilities: [
        pid("capabilities", "draft"),
        pid("capabilities", "review"),
      ],
      customization: "extend",
    });
  });

  test("an extension the new version fills is converted to a replacement that keeps both sides", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "researcher", "extend", { title: "Our researcher" });
    const before = await h.authority();

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.issues).toMatchObject([
      { code: "unresolved_override_conflict", detail: "extend_conflict" },
    ]);
    expect(await h.authority()).toEqual(before);

    const resolutions = [
      { source: source(h.v1, "researcher"), action: "convert_to_replace" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "researcher"),
        operation: "extend",
        outcome: "converted_to_replace",
        upstream: "changed",
        target: source(h.v2, "researcher"),
        conflict: "extend_conflict",
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("Our researcher");
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);

    // The project's title wins; every other field, references included, is
    // the new template's.
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v2, "researcher"),
        operation: "replace",
        revision: 2,
        payload: {
          id: "researcher",
          title: "Our researcher",
          description: "Finds precedents",
          role: "paralegal",
          knowledge: ["precedents", "statutes"],
        },
        actorId: "operator",
        changedAt: later.toISOString(),
      },
    ]);
    const after = await h.configuration();
    expect(after.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    expect(agentOf(after, agentId("researcher"))).toMatchObject({
      title: "Our researcher",
      description: "Finds precedents",
      roleId: pid("roles", "paralegal"),
      knowledge: [pid("knowledge", "precedents"), pid("knowledge", "statutes")],
      customization: "replace",
    });
  });

  test("a disabled agent stays disabled when the new version changes it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "drafter", "disable");

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "drafter"),
        operation: "disable",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "drafter"),
      },
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    const resolved = await h.configuration();
    expect(resolved.disabledAgents).toEqual([agentId("drafter")]);
    expect(resolved.agents.map((item) => item.agentId)).not.toContain(
      agentId("drafter"),
    );
  });

  test("a disabled agent removed upstream blocks until its override is removed, and is not recreated", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "intern", "disable");
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
    // A disable carries no definition to retain.
    const retained = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v2],
      resolutions: [
        { source: source(h.v1, "intern"), action: "retain_as_project_owned" },
      ],
    });
    expect(retained.issues).toMatchObject([{ code: "invalid_resolution" }]);
    expect(await h.authority()).toEqual(before);

    const resolutions = [
      { source: source(h.v1, "intern"), action: "remove_override" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v2], plan.planDigest, resolutions);
    const resolved = await h.configuration();
    expect([
      ...resolved.agents.map((item) => item.agentId),
      ...resolved.disabledAgents,
    ]).not.toContain(agentId("intern"));
    expect((await h.storage.definitions.get("a")).overrides).toEqual([]);
  });

  test("a replaced agent removed upstream is retained only when it references no pack definition", async () => {
    // With references: a project-owned agent could not resolve them.
    const referencing = await harness();
    await referencing.bind([referencing.v1]);
    await referencing.override(referencing.v1, "intern", "replace", {
      id: "intern",
      title: "Our intern",
      role: "counsel",
    });
    const before = await referencing.authority();
    const retain = (h: Harness) => [
      { source: source(h.v1, "intern"), action: "retain_as_project_owned" },
    ];
    const refused = await referencing.upgrade().preview({
      projectId: "a",
      desired: [referencing.v2],
      resolutions: retain(referencing),
    });
    expect(refused.issues).toEqual([
      {
        code: "invalid_resolution",
        detail: "source_definition_removed",
        message: expect.stringContaining(
          "cannot be retained as project-owned",
        ) as unknown,
      },
    ]);
    expect(refused.issues[0]?.message).toContain("pack definitions");
    expect(refused.overrides).toMatchObject([{ outcome: "conflict" }]);
    expect(await referencing.authority()).toEqual(before);

    // Without references it stands alone as a project agent.
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "intern", "replace", {
      id: "intern",
      title: "Our intern",
    });
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions: retain(h) });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      {
        outcome: "retained_as_project_owned",
        retainedAs: { kind: "agents", id: "intern" },
      },
    ]);
    await applyUpgrade(h, [h.v2], plan.planDigest, retain(h));
    const resolved = await h.configuration();
    expect(agentOf(resolved, "project:agents/intern")).toEqual({
      agentId: "project:agents/intern",
      effectiveId: "project:agents/intern",
      origin: "project_owned",
      title: "Our intern",
      prompts: [],
      knowledge: [],
      capabilities: [],
      customization: "none",
    });
    expect(resolved.agents.map((item) => item.agentId)).not.toContain(
      agentId("intern"),
    );
  });

  test("a project-added agent survives an upgrade untouched, and a pack that starts to provide it blocks", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.add("roles", "liaison");
    await h.add("agents", "helper", { id: "helper", role: "liaison" });
    const owned = (await h.storage.definitions.get("a")).owned;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect((await h.storage.definitions.get("a")).owned).toEqual(owned);
    expect(
      agentOf(await h.configuration(), "project:agents/helper"),
    ).toMatchObject({ roleId: "project:roles/liaison" });

    // 2.0.0 adds a pack agent `auditor`.
    const collision = await harness();
    await collision.bind([collision.v1]);
    await collision.add("agents", "auditor");
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

  test("a new version whose agent names a role the project omits blocks the upgrade", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // In 1.0.0 no agent names paralegal; in 2.0.0 the researcher does.
    await h.override(h.v1, "paralegal", "disable", undefined, "roles");
    expect((await h.configuration()).omittedRoles).toEqual([
      pid("roles", "paralegal"),
    ]);
    const before = await h.authority();
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([
      {
        code: "prospective_configuration_invalid",
        detail: "disabled_required_definition",
        message: expect.stringContaining("agents/researcher") as unknown,
      },
    ]);
    expect(await h.authority()).toEqual(before);
  });

  test("a new agent that names an omitted role is handled by lifting the omission, upgrading, disabling the agent and omitting again", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // 2.0.0 adds `auditor`, which names counsel; no 1.0.0 agent may name it.
    await h.override(h.v1, "drafter", "disable");
    await h.override(h.v1, "counsel", "disable", undefined, "roles");
    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "disabled_required_definition",
      },
    ]);
    expect(blocked.issues[0]?.message).toContain("agents/auditor");
    // The agent does not exist in the selected version, so it cannot be
    // disabled beforehand.
    expect(await conflictCode(h.override(h.v1, "auditor", "disable"))).toBe(
      "source_definition_missing",
    );

    await h.mutate({
      action: "remove_override",
      source: source(h.v1, "counsel", "roles"),
    });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    await applyUpgrade(h, [h.v2], plan.planDigest);
    await h.override(h.v2, "auditor", "disable");
    await h.override(h.v2, "counsel", "disable", undefined, "roles");
    const resolved = await h.configuration();
    expect(resolved.omittedRoles).toEqual([pid("roles", "counsel")]);
    expect(resolved.disabledAgents).toEqual([
      agentId("auditor"),
      agentId("drafter"),
    ]);
  });

  test("a descriptive replacement stays complete when the new version gives the agent a role", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "researcher", "replace", {
      id: "researcher",
      title: "Our researcher",
    });
    // 2.0.0 gives the researcher a role and more knowledge.
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      { operation: "replace", outcome: "retargeted", upstream: "changed" },
    ]);
    expect(
      plan.templates.availability === "available" &&
        plan.templates.changes.find((item) => item.localId === "researcher"),
    ).toMatchObject({ kind: "agents", change: "changed", customized: true });
    await applyUpgrade(h, [h.v2], plan.planDigest);
    expect(agentOf(await h.configuration(), agentId("researcher"))).toEqual({
      agentId: agentId("researcher"),
      effectiveId: `pack:${packId}@2.0.0#${h.v2.manifestDigest}/agents/researcher`,
      origin: "pack_owned",
      title: "Our researcher",
      prompts: [],
      knowledge: [],
      capabilities: [],
      customization: "replace",
    });
  });

  test("an agent request change is a template change, not a role capability change", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // The role sets of 1.0.0 and 2.0.0 are identical; only agents differ.
    const preview = await h.selection().preview("a", [h.v2]);
    expect(preview.issues).toEqual([]);
    expect(preview.roleCapabilityChanges).toEqual({
      availability: "available",
      changes: [],
    });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.roleCapabilityChanges).toEqual({
      availability: "available",
      changes: [],
    });
    expect(
      plan.templates.availability === "available" &&
        plan.templates.changes.find((item) => item.localId === "drafter"),
    ).toEqual({
      packId,
      kind: "agents",
      localId: "drafter",
      change: "changed",
      customized: false,
    });
  });

  test("the plan does not depend on storage, registration or declaration order", async () => {
    // The same manifests with every list written in another order.
    const reverse = <T>(items: readonly T[]) => [...items].reverse();
    const reordered = [
      packBytes("1.0.0", {
        roles: reverse(roles).map((role) => ({
          ...role,
          ...(role.capabilities === undefined
            ? {}
            : { capabilities: reverse(role.capabilities) }),
        })),
        prompts: reverse(shared.prompts),
        knowledge: reverse(shared.knowledge),
        capabilities: reverse(shared.capabilities),
        agents: [
          { id: "intern", title: "Intern" },
          { id: "researcher", knowledge: ["precedents"] },
          { id: "filer", role: "clerk", capabilities: ["file"] },
          {
            id: "drafter",
            title: "Drafter",
            role: "counsel",
            prompts: ["style", "brief"],
            knowledge: ["statutes"],
            capabilities: ["draft"],
          },
        ],
      }),
      packBytes("2.0.0", {
        roles: reverse(roles),
        prompts: reverse(shared.prompts),
        knowledge: reverse(shared.knowledge),
        capabilities: reverse(shared.capabilities),
        agents: [
          { id: "auditor", role: "counsel" },
          {
            id: "researcher",
            title: "Researcher",
            description: "Finds precedents",
            role: "paralegal",
            knowledge: ["statutes", "precedents"],
          },
          {
            id: "filer",
            title: "Filer",
            role: "clerk",
            capabilities: ["file"],
          },
          {
            id: "drafter",
            title: "Lead drafter",
            role: "counsel",
            prompts: ["brief"],
            capabilities: ["review", "draft"],
          },
        ],
      }),
    ];
    const first = await harness([v1Bytes, v2Bytes]);
    // Registered newest first.
    const second = await harness([reordered[1]!, reordered[0]!]);
    const steps = (h: Harness, pack: PackIdentity, shuffled: boolean) => [
      () =>
        h.override(pack, "drafter", "replace", {
          id: "drafter",
          title: "D",
          role: "counsel",
          prompts: shuffled ? ["tone", "brief"] : ["brief", "tone"],
          capabilities: shuffled ? ["review", "draft"] : ["draft", "review"],
        }),
      () => h.override(pack, "researcher", "extend", { title: "R" }),
      () => h.override(pack, "filer", "disable"),
      () => h.override(pack, "intern", "disable"),
      () => h.add("agents", "helper"),
      () => h.add("agents", "advisor"),
    ];
    await first.bind([first.v1]);
    for (const step of steps(first, first.v1, false)) await step();
    // `second` registered 2.0.0 first, so its packs are [v2, v1].
    const [secondV2, secondV1] = second.packs as [PackIdentity, PackIdentity];
    expect(secondV1).toEqual(first.v1);
    expect(secondV2).toEqual(first.v2);
    await second.bind([secondV1]);
    for (const step of steps(second, secondV1, true).reverse()) await step();

    const resolutions = [
      { source: source(first.v1, "researcher"), action: "convert_to_replace" },
      { source: source(first.v1, "intern"), action: "remove_override" },
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
    expect(right.agents).toEqual(left.agents);
    expect(left.configurationDigest).toBe(one.prospectiveConfigurationDigest);
  });
});

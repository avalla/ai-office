import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ProjectPackUpgradeError,
  ReconcileProjectPackUpgrade,
} from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import { ProjectDefinitionConflictError } from "@ai-office/application/domain-pack/project-definition.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../packages/domain-pack-contracts/src/jcs.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const now = new Date("2026-10-05T00:00:00.000Z");
const later = new Date("2026-10-06T00:00:00.000Z");
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
    metadata: { name: "Legal", description: "Role archetype fixture" },
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

const flow = (role: string) => ({
  taskTypes: [{ id: "matter" }],
  workflows: [
    { id: "flow", taskType: "matter", stages: [{ id: "intake", role }] },
  ],
});

const v1Bytes = packBytes("1.0.0", {
  roles: [
    { id: "counsel", title: "Counsel", capabilities: ["draft", "review"] },
    { id: "clerk", capabilities: ["file"] },
    { id: "paralegal" },
    { id: "intern", title: "Intern" },
  ],
  ...flow("counsel"),
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
});
// counsel is renamed and gains `sign`; clerk gets a title and loses `file`;
// paralegal gains the title a project extension would supply; intern is
// removed; auditor is added with a capability.
const v2Bytes = packBytes("2.0.0", {
  roles: [
    {
      id: "counsel",
      title: "Lead counsel",
      capabilities: ["sign", "draft", "review"],
    },
    { id: "clerk", title: "Clerk" },
    { id: "paralegal", title: "Paralegal", description: "Assists" },
    { id: "auditor", capabilities: ["review"] },
  ],
  ...flow("counsel"),
  capabilities: [
    { id: "draft" },
    { id: "file" },
    { id: "review" },
    { id: "sign" },
  ],
});
// The workflow starts to require clerk.
const v3Bytes = packBytes("3.0.0", {
  roles: [
    { id: "counsel", title: "Counsel", capabilities: ["draft", "review"] },
    { id: "clerk", capabilities: ["file"] },
    { id: "paralegal" },
    { id: "intern", title: "Intern" },
  ],
  ...flow("clerk"),
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
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
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp11-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const { catalog, packs } = catalogOf(...artifacts);
  await storage.projects.save(Project.create({ id: "a", name: "A", now }));
  let sequence = 0;
  const ports = (selected = catalog, clock = now) => ({
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
  const upgrade = (selected = catalog) =>
    new ReconcileProjectPackUpgrade(ports(selected, later));
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
    kind = "roles",
  ) =>
    mutate({
      action: "put_override",
      source: { ...pack, kind, localId },
      operation,
      ...(payload === undefined ? {} : { payload }),
    });
  const addRole = (id: string, payload: object = { id }) =>
    mutate({ action: "put_owned", kind: "roles", id, enabled: true, payload });
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
    audits: audits("project.pack_upgrade_applied").length,
  });
  const configuration = (selected = catalog) =>
    new ReadProjectConfiguration({
      projects: storage.projects,
      bindings: storage.packBindings,
      definitions: storage.definitions,
      transactions: storage.transactions,
      catalog: selected,
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
    addRole,
    audits,
    authority,
    configuration,
  };
}

const source = (pack: PackIdentity, localId: string, kind = "roles") => ({
  ...pack,
  kind,
  localId,
});
const roleId = (localId: string) => `pack:${packId}/roles/${localId}`;

async function conflictCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
    return (error as ProjectDefinitionConflictError).code;
  }
  throw new Error("Expected a definition conflict");
}

describe("GP-11 role omission and capability ownership in project definitions", () => {
  test("omitting a pack role is stored and audited", async () => {
    const h = await harness();
    await h.bind([h.v1]);

    const preview = await h.definitions.preview("a", {
      action: "put_override",
      source: source(h.v1, "clerk"),
      operation: "disable",
    });
    expect(preview.issues).toEqual([]);
    expect(await h.revision()).toBe(0);

    const state = await h.override(h.v1, "clerk", "disable");

    expect(state.overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v1, "clerk"),
        operation: "disable",
        revision: 1,
        actorId: "author",
        changedAt: now.toISOString(),
      },
    ]);
    expect(await h.storage.definitions.get("a")).toEqual(state);
    expect(h.audits("project.definition_changed")).toEqual([
      {
        actorId: "author",
        payload: {
          action: "put_override",
          origin: "project_override",
          identity: source(h.v1, "clerk"),
          operation: "disable",
          previousRevision: 0,
          newRevision: 1,
          previousEntryRevision: null,
          newEntryRevision: 1,
        },
      },
    ]);
    const resolved = await h.configuration();
    expect(resolved.omittedRoles).toEqual([roleId("clerk")]);
    expect(resolved.roles.map((item) => item.roleId)).not.toContain(
      roleId("clerk"),
    );

    // Removing the override restores the pack role; nothing else changed.
    await h.mutate({
      action: "remove_override",
      source: source(h.v1, "clerk"),
    });
    expect((await h.configuration()).omittedRoles).toEqual([]);
  });

  test("a disable override carries no payload and stays unsupported for other kinds", async () => {
    const h = await harness();
    await h.bind([h.v1]);

    expect(
      await conflictCode(h.override(h.v1, "clerk", "disable", { id: "clerk" })),
    ).toBe("malformed_origin_reference");
    expect(
      await conflictCode(
        h.override(h.v1, "matter", "disable", undefined, "taskTypes"),
      ),
    ).toBe("unsupported_override_operation");
    for (const kind of [
      "agents",
      "artifactTypes",
      "evidenceTypes",
      "knowledge",
      "workflows",
      "capabilities",
      "policies",
      "validators",
    ])
      expect(
        await conflictCode(h.override(h.v1, "x", "disable", undefined, kind)),
      ).toBe("unsupported_override_operation");
    expect(await h.storage.definitions.get("a")).toMatchObject({
      revision: 0,
      overrides: [],
    });
    expect(h.audits("project.definition_changed")).toEqual([]);
  });

  test("project payloads cannot carry capabilities; nothing is written", async () => {
    const h = await harness();
    await h.bind([h.v1]);

    expect(
      await conflictCode(
        h.override(h.v1, "counsel", "replace", {
          id: "counsel",
          capabilities: ["file"],
        }),
      ),
    ).toBe("protected_security_invariant");
    expect(
      await conflictCode(
        h.override(h.v1, "paralegal", "extend", {
          title: "Paralegal",
          capabilities: ["file"],
        }),
      ),
    ).toBe("protected_security_invariant");
    expect(
      await conflictCode(
        h.addRole("auditor", { id: "auditor", capabilities: ["file"] }),
      ),
    ).toBe("protected_security_invariant");
    expect(await h.storage.definitions.get("a")).toEqual({
      projectId: "a",
      revision: 0,
      owned: [],
      overrides: [],
    });
  });
});

describe("GP-11 role archetypes across a pack upgrade", () => {
  test("the plan lists every role capability change and the target sets, and its digest covers them", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", {
      id: "counsel",
      title: "Our counsel",
    });

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });

    expect(plan.issues).toEqual([]);
    expect(plan.roleCapabilityChanges).toEqual({
      availability: "available",
      changes: [
        {
          roleId: roleId("auditor"),
          added: ["review"],
          removed: [],
          customized: false,
        },
        {
          roleId: roleId("clerk"),
          added: [],
          removed: ["file"],
          customized: false,
        },
        {
          roleId: roleId("counsel"),
          added: ["sign"],
          removed: [],
          customized: true,
        },
      ],
    });
    expect(plan.targetRoleCapabilities).toEqual([
      { roleId: roleId("auditor"), capabilities: ["review"] },
      { roleId: roleId("counsel"), capabilities: ["draft", "review", "sign"] },
    ]);

    // The approval token is the digest of every other report field.
    const digestOf = (report: object) =>
      `sha256:${createHash("sha256")
        .update("ai-office-pack-upgrade-plan-v1\n", "utf8")
        .update(canonicalizeJcsJson(report as never), "utf8")
        .digest("hex")}`;
    const { planDigest, ...report } = plan;
    expect(digestOf(report)).toBe(planDigest);
    expect(
      digestOf({
        ...report,
        targetRoleCapabilities: [
          { roleId: roleId("auditor"), capabilities: ["review"] },
          { roleId: roleId("counsel"), capabilities: ["draft", "review"] },
        ],
      }),
    ).not.toBe(planDigest);
    expect(
      digestOf({
        ...report,
        roleCapabilityChanges: { availability: "available", changes: [] },
      }),
    ).not.toBe(planDigest);
  });

  test("two targets that differ only in a role capability set need different approvals", async () => {
    const withSign = await harness();
    // The same target version, but counsel does not gain `sign`.
    const withoutSign = await harness([
      v1Bytes,
      packBytes("2.0.0", {
        roles: [
          {
            id: "counsel",
            title: "Lead counsel",
            capabilities: ["draft", "review"],
          },
          { id: "clerk", title: "Clerk" },
          { id: "paralegal", title: "Paralegal", description: "Assists" },
          { id: "auditor", capabilities: ["review"] },
        ],
        ...flow("counsel"),
        capabilities: [
          { id: "draft" },
          { id: "file" },
          { id: "review" },
          { id: "sign" },
        ],
      }),
    ]);
    const plans = [];
    for (const h of [withSign, withoutSign]) {
      await h.bind([h.v1]);
      plans.push(
        await h.upgrade().preview({ projectId: "a", desired: [h.v2] }),
      );
    }
    const [first, second] = plans;
    expect(first!.templates).toEqual(second!.templates);
    expect(first!.overrides).toEqual(second!.overrides);
    expect(first!.targetRoleCapabilities).not.toEqual(
      second!.targetRoleCapabilities,
    );
    expect(first!.roleCapabilityChanges).not.toEqual(
      second!.roleCapabilityChanges,
    );
    expect(first!.planDigest).not.toBe(second!.planDigest);
    // An approval of one plan is not an approval of the other.
    await expect(
      withSign.upgrade().apply({
        projectId: "a",
        desired: [withSign.v2],
        approvedPlanDigest: second!.planDigest,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({ code: "plan_not_approved" });
  });

  test("a renamed role keeps its identity and the project's presentation, and takes the new version's capabilities", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", {
      id: "counsel",
      title: "Our counsel",
    });
    const before = await h.configuration();
    const stored = (await h.storage.definitions.get("a")).overrides[0]!;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "counsel"),
        operation: "replace",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "counsel"),
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("Our counsel");
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    // The project entry is carried over whole; only its pack tuple moved.
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      { ...stored, source: source(h.v2, "counsel") },
    ]);
    const after = await h.configuration();
    expect(after.configurationDigest).toBe(plan.prospectiveConfigurationDigest);
    const role = (view: typeof after) =>
      view.roles.find((item) => item.roleId === roleId("counsel"))!;
    expect(role(before)).toMatchObject({
      title: "Our counsel",
      customization: "replace",
      capabilities: [
        `pack:${packId}/capabilities/draft`,
        `pack:${packId}/capabilities/review`,
      ],
    });
    expect(role(after)).toEqual({
      roleId: roleId("counsel"),
      effectiveId: `pack:${packId}@2.0.0#${h.v2.manifestDigest}/roles/counsel`,
      origin: "pack_owned",
      title: "Our counsel",
      capabilities: [
        `pack:${packId}/capabilities/draft`,
        `pack:${packId}/capabilities/review`,
        `pack:${packId}/capabilities/sign`,
      ],
      customization: "replace",
    });
    expect(role(after).effectiveId).not.toBe(role(before).effectiveId);
    // Every role present in both versions keeps its stable identity.
    const ids = (view: typeof after) =>
      new Set([...view.roles.map((item) => item.roleId), ...view.omittedRoles]);
    for (const id of [roleId("counsel"), roleId("clerk"), roleId("paralegal")])
      expect(ids(before).has(id) && ids(after).has(id)).toBe(true);
    // The workflow stage still resolves to the same slot.
    expect(after.resolvedWorkflowReferences[0]?.stages[0]?.roleId).toBe(
      role(after).effectiveId,
    );
  });

  test("the audit event records the capability changes and target sets by identity only", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", {
      id: "counsel",
      title: "Our counsel",
    });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    const [audit] = h.audits("project.pack_upgrade_applied");
    expect(audit?.actorId).toBe("operator");
    expect(audit?.payload).toMatchObject({
      planDigest: plan.planDigest,
      roleCapabilityChanges: plan.roleCapabilityChanges,
      targetRoleCapabilities: plan.targetRoleCapabilities,
    });
    expect(JSON.stringify(audit?.payload)).not.toContain("Our counsel");
    expect(JSON.stringify(audit?.payload)).not.toContain("Lead counsel");
  });

  test("an extension the new version fills is converted to a replacement that keeps both sides", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "paralegal", "extend", { title: "Our paralegal" });
    const before = await h.authority();

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.overrides).toMatchObject([
      { outcome: "conflict", conflict: "extend_conflict", upstream: "changed" },
    ]);
    expect(blocked.issues).toMatchObject([
      { code: "unresolved_override_conflict", detail: "extend_conflict" },
    ]);

    const resolutions = [
      { source: source(h.v1, "paralegal"), action: "convert_to_replace" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    expect(plan.ignoredResolutions).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "paralegal"),
        operation: "extend",
        outcome: "converted_to_replace",
        upstream: "changed",
        target: source(h.v2, "paralegal"),
        conflict: "extend_conflict",
      },
    ]);
    expect(plan.planDigest).not.toBe(blocked.planDigest);
    // The report names identities and outcomes, never a definition body.
    expect(JSON.stringify(plan)).not.toContain("Our paralegal");
    expect(JSON.stringify(plan)).not.toContain("Assists");
    expect(await h.authority()).toEqual(before);

    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      resolutions,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    // A changed entry: the operator and time are recorded, the revision moves.
    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      {
        origin: "project_override",
        source: source(h.v2, "paralegal"),
        operation: "replace",
        revision: 2,
        payload: {
          id: "paralegal",
          title: "Our paralegal",
          description: "Assists",
        },
        actorId: "operator",
        changedAt: later.toISOString(),
      },
    ]);
    const resolved = await h.configuration();
    expect(resolved.configurationDigest).toBe(
      plan.prospectiveConfigurationDigest,
    );
    expect(
      resolved.roles.find((item) => item.roleId === roleId("paralegal")),
    ).toMatchObject({
      title: "Our paralegal",
      description: "Assists",
      customization: "replace",
    });
    expect(
      h.audits("project.pack_upgrade_applied")[0]?.payload.overrides,
    ).toEqual(plan.overrides);
  });

  test("convert_to_replace is refused for every conflict other than an extension conflict", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    // intern is removed by 2.0.0: a replace and, separately, an omission.
    await h.override(h.v1, "intern", "replace", {
      id: "intern",
      title: "Ours",
    });
    const before = await h.authority();
    const convert = (pack: PackIdentity, localId: string) => [
      { source: source(pack, localId), action: "convert_to_replace" },
    ];

    const removed = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v2],
      resolutions: convert(h.v1, "intern"),
    });
    expect(removed.overrides).toMatchObject([
      { outcome: "conflict", conflict: "source_definition_removed" },
    ]);
    expect(removed.issues).toMatchObject([
      { code: "invalid_resolution", detail: "source_definition_removed" },
    ]);

    const detached = await h.upgrade().preview({
      projectId: "a",
      desired: [],
      resolutions: convert(h.v1, "intern"),
    });
    expect(detached.issues).toMatchObject([
      { code: "invalid_resolution", detail: "source_pack_removed" },
    ]);

    await expect(
      h.upgrade().apply({
        projectId: "a",
        desired: [h.v2],
        resolutions: convert(h.v1, "intern"),
        approvedPlanDigest: removed.planDigest,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    expect(await h.authority()).toEqual(before);

    // An unknown action is a malformed request, not a silent no-op.
    await expect(
      h.upgrade().preview({
        projectId: "a",
        desired: [h.v2],
        resolutions: [
          { source: source(h.v1, "intern"), action: "convert_to_extend" },
        ],
      }),
    ).rejects.toBeInstanceOf(ProjectPackUpgradeError);
  });

  test("convert_to_replace on an override without a conflict is reported as unused and changes nothing", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "clerk", "extend", { description: "Files" });
    const resolutions = [
      { source: source(h.v1, "clerk"), action: "convert_to_replace" },
    ];

    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });

    // 2.0.0 sets a title, not the extended description: no conflict.
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      { operation: "extend", outcome: "retargeted", upstream: "changed" },
    ]);
    expect(plan.ignoredResolutions).toEqual(resolutions);
  });

  test("an omitted role stays omitted when the new version changes it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "clerk", "disable");
    const stored = (await h.storage.definitions.get("a")).overrides[0]!;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "clerk"),
        operation: "disable",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "clerk"),
      },
    ]);
    expect(plan.roleCapabilityChanges).toMatchObject({
      changes: expect.arrayContaining([
        {
          roleId: roleId("clerk"),
          added: [],
          removed: ["file"],
          customized: true,
        },
      ]) as unknown,
    });
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    expect((await h.storage.definitions.get("a")).overrides).toEqual([
      { ...stored, source: source(h.v2, "clerk") },
    ]);
    const resolved = await h.configuration();
    expect(resolved.omittedRoles).toEqual([roleId("clerk")]);
    expect(resolved.roles.map((item) => item.roleId)).toEqual([
      roleId("auditor"),
      roleId("counsel"),
      roleId("paralegal"),
    ]);
  });

  test("an omitted role removed upstream blocks until its override is removed, and is not recreated", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "intern", "disable");
    const before = await h.authority();

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.overrides).toMatchObject([
      {
        operation: "disable",
        outcome: "conflict",
        upstream: "removed",
        conflict: "source_definition_removed",
      },
    ]);
    expect(blocked.issues).toMatchObject([
      { code: "unresolved_override_conflict" },
    ]);
    // An omission carries no definition to retain or convert.
    for (const action of ["retain_as_project_owned", "convert_to_replace"])
      expect(
        (
          await h.upgrade().preview({
            projectId: "a",
            desired: [h.v2],
            resolutions: [{ source: source(h.v1, "intern"), action }],
          })
        ).issues,
      ).toMatchObject([
        { code: "invalid_resolution", detail: "source_definition_removed" },
      ]);
    expect(await h.authority()).toEqual(before);

    const resolutions = [
      { source: source(h.v1, "intern"), action: "remove_override" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      resolutions,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    const state = await h.storage.definitions.get("a");
    expect(state.overrides).toEqual([]);
    expect(state.owned).toEqual([]);
    const resolved = await h.configuration();
    expect([
      ...resolved.roles.map((item) => item.roleId),
      ...resolved.omittedRoles,
    ]).not.toContain(roleId("intern"));
    expect(JSON.stringify(resolved)).not.toContain("intern");
  });

  test("an upgrade whose workflow starts to require an omitted role is blocked", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "clerk", "disable");
    const before = await h.authority();

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v3] });

    expect(plan.overrides).toMatchObject([{ outcome: "retargeted" }]);
    expect(plan.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "disabled_required_definition",
      },
    ]);
    expect(plan.prospectiveConfigurationDigest).toBeUndefined();
    await expect(
      h.upgrade().apply({
        projectId: "a",
        desired: [h.v3],
        approvedPlanDigest: plan.planDigest,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    expect(await h.authority()).toEqual(before);
  });

  test("a project-added role survives an upgrade untouched, and a pack that starts to provide it blocks", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.addRole("liaison", { id: "liaison", title: "Liaison" });
    const liaison = (await h.storage.definitions.get("a")).owned[0]!;

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.issues).toEqual([]);
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    expect((await h.storage.definitions.get("a")).owned).toEqual([liaison]);
    expect(
      (await h.configuration()).roles.find(
        (item) => item.roleId === "project:roles/liaison",
      ),
    ).toEqual({
      roleId: "project:roles/liaison",
      effectiveId: "project:roles/liaison",
      origin: "project_owned",
      title: "Liaison",
      capabilities: [],
      customization: "none",
    });

    // 2.0.0 adds a pack role `auditor`; a project that already owns one blocks.
    const collision = await harness();
    await collision.bind([collision.v1]);
    await collision.addRole("auditor", { id: "auditor", title: "Ours" });
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
      collision.upgrade().apply({
        projectId: "a",
        desired: [collision.v2],
        approvedPlanDigest: blocked.planDigest,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({ code: "upgrade_blocked" });
    expect(await collision.authority()).toEqual(before);
  });

  test("retaining a removed role keeps the project's definition and reports the lost pack capabilities", async () => {
    // 2.0.0 here removes clerk, which declared `file`.
    const h = await harness([
      v1Bytes,
      packBytes("2.0.0", {
        roles: [
          {
            id: "counsel",
            title: "Counsel",
            capabilities: ["draft", "review"],
          },
        ],
        ...flow("counsel"),
        capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
      }),
    ]);
    await h.bind([h.v1]);
    await h.override(h.v1, "clerk", "replace", { id: "clerk", title: "Ours" });
    const resolutions = [
      { source: source(h.v1, "clerk"), action: "retain_as_project_owned" },
    ];

    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    expect(plan.roleCapabilityChanges).toEqual({
      availability: "available",
      changes: [
        {
          roleId: roleId("clerk"),
          added: [],
          removed: ["file"],
          customized: true,
        },
      ],
    });
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      resolutions,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    const resolved = await h.configuration();
    expect(
      resolved.roles.find((item) => item.roleId === "project:roles/clerk"),
    ).toMatchObject({
      origin: "project_owned",
      title: "Ours",
      capabilities: [],
    });
    expect(resolved.roles.map((item) => item.roleId)).not.toContain(
      roleId("clerk"),
    );
  });

  test("with the previous artifacts gone the changes are unavailable but approval still binds the target sets", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    const { catalog: onlyTarget } = catalogOf(v2Bytes);

    const plan = await h
      .upgrade(onlyTarget)
      .preview({ projectId: "a", desired: [h.v2] });

    expect(plan.issues).toEqual([]);
    expect(plan.templates).toMatchObject({ availability: "unavailable" });
    expect(plan.roleCapabilityChanges).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    expect(plan.targetRoleCapabilities).toEqual([
      { roleId: roleId("auditor"), capabilities: ["review"] },
      { roleId: roleId("counsel"), capabilities: ["draft", "review", "sign"] },
    ]);
    await h.upgrade(onlyTarget).apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    expect(h.audits("project.pack_upgrade_applied")[0]?.payload).toMatchObject({
      roleCapabilityChanges: { availability: "unavailable" },
      targetRoleCapabilities: plan.targetRoleCapabilities,
    });
  });

  test("a no-op plan reads no artifact and reports no capability change", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "clerk", "disable");

    const plan = await h
      .upgrade(catalogOf().catalog)
      .preview({ projectId: "a", desired: [h.v1] });

    expect(plan).toMatchObject({
      noop: true,
      issues: [],
      roleCapabilityChanges: { availability: "available", changes: [] },
      targetRoleCapabilities: [],
    });
  });

  test("the plan does not depend on storage, registration or declaration order", async () => {
    // The same manifests with every list written in another order.
    const reordered = [
      packBytes("1.0.0", {
        roles: [
          { id: "intern", title: "Intern" },
          { id: "paralegal" },
          { id: "clerk", capabilities: ["file"] },
          {
            id: "counsel",
            title: "Counsel",
            capabilities: ["review", "draft"],
          },
        ],
        ...flow("counsel"),
        capabilities: [{ id: "review" }, { id: "file" }, { id: "draft" }],
      }),
      packBytes("2.0.0", {
        roles: [
          { id: "auditor", capabilities: ["review"] },
          { id: "paralegal", title: "Paralegal", description: "Assists" },
          { id: "clerk", title: "Clerk" },
          {
            id: "counsel",
            title: "Lead counsel",
            capabilities: ["review", "draft", "sign"],
          },
        ],
        ...flow("counsel"),
        capabilities: [
          { id: "sign" },
          { id: "review" },
          { id: "file" },
          { id: "draft" },
        ],
      }),
    ];
    const first = await harness([v1Bytes, v2Bytes]);
    // Registered newest first.
    const second = await harness([reordered[1]!, reordered[0]!]);
    const steps = (h: typeof first, pack: PackIdentity) => [
      () =>
        h.override(pack, "counsel", "replace", { id: "counsel", title: "C" }),
      () => h.override(pack, "paralegal", "extend", { title: "P" }),
      () => h.override(pack, "clerk", "disable"),
      () => h.override(pack, "intern", "disable"),
      () => h.addRole("liaison"),
      () => h.addRole("advisor"),
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
      { source: source(first.v1, "paralegal"), action: "convert_to_replace" },
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
  });
});

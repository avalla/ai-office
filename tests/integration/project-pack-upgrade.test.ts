import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { StaleProjectDefinitionError } from "@ai-office/application/domain-pack/project-definition.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
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

const now = new Date("2026-10-05T00:00:00.000Z");
const template = parseDomainPackManifest(
  readFileSync(new URL("../fixtures/domain-pack/custom.json", import.meta.url)),
);

interface Entry {
  id: string;
  title?: string;
  description?: string;
}

/** Exact manifest bytes of one version of the `org.example.custom` fixture. */
function packBytes(
  version: string,
  contributions: { roles?: Entry[]; prompts?: Entry[] },
  id = "org.example.custom",
): Uint8Array {
  const manifest = {
    ...template,
    id,
    version,
    contributions: { ...template.contributions, ...contributions },
  } as unknown as typeof template;
  return new TextEncoder().encode(
    JSON.stringify({
      ...manifest,
      manifestDigest: computeManifestDigest(manifest),
    }),
  );
}

const v1Bytes = packBytes("1.0.0", {
  roles: [{ id: "counsel", title: "Legal" }, { id: "paralegal" }],
  prompts: [{ id: "greeting" }],
});
// counsel changes, paralegal is removed, clerk is added, greeting is unchanged.
const v2Bytes = packBytes("2.0.0", {
  roles: [{ id: "clerk" }, { id: "counsel", title: "Counsel" }],
  prompts: [{ id: "greeting" }],
});
// paralegal gains the title a project extension would have supplied.
const v3Bytes = packBytes("3.0.0", {
  roles: [
    { id: "counsel", title: "Legal" },
    { id: "paralegal", title: "Paralegal" },
  ],
  prompts: [{ id: "greeting" }],
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

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp08-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const {
    catalog,
    packs: [v1, v2, v3],
  } = catalogOf(v1Bytes, v2Bytes, v3Bytes);
  await storage.projects.save(Project.create({ id: "a", name: "A", now }));
  let sequence = 0;
  const ports = (
    selected: InstalledDomainPackCatalog,
    auditEvents: AuditEventRepository,
    transactions: TransactionRunner,
  ) => ({
    projects: storage.projects,
    definitions: storage.definitions,
    bindings: storage.packBindings,
    catalog: selected,
    auditEvents,
    transactions,
    clock: { now: () => now },
    ids: { generate: () => `audit-${++sequence}` },
  });
  const upgrade = (
    selected: InstalledDomainPackCatalog = catalog,
    auditEvents: AuditEventRepository = storage.auditEvents,
    transactions: TransactionRunner = storage.transactions,
  ) =>
    new ReconcileProjectPackUpgrade(ports(selected, auditEvents, transactions));
  const definitions = new ManageProjectDefinitions(
    ports(catalog, storage.auditEvents, storage.transactions),
  );
  const bind = async (packs: PackIdentity[]) => {
    await storage.packBindings.replace(
      "a",
      (await storage.packBindings.get("a")).configurationRevision,
      packs,
      now,
    );
  };
  const override = async (
    pack: PackIdentity,
    localId: string,
    operation: "replace" | "extend" | "disable",
    payload?: Entry | Omit<Entry, "id">,
    kind = "roles",
  ) => {
    await definitions.apply({
      projectId: "a",
      expectedRevision: (await storage.definitions.get("a")).revision,
      actorId: "author",
      mutation: {
        action: "put_override",
        source: { ...pack, kind, localId },
        operation,
        ...(payload === undefined ? {} : { payload }),
      },
    });
  };
  const upgradeAudits = () =>
    database
      .query<{ payload_json: string; actor_id: string }, []>(
        "SELECT payload_json, actor_id FROM audit_event WHERE event_type='project.pack_upgrade_applied' ORDER BY id",
      )
      .all();
  const authority = async () => ({
    binding: await storage.packBindings.get("a"),
    definitions: await storage.definitions.get("a"),
    audits: upgradeAudits().length,
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
    v1: v1!,
    v2: v2!,
    v3: v3!,
    upgrade,
    bind,
    override,
    upgradeAudits,
    authority,
    configuration,
  };
}

const source = (pack: PackIdentity, localId: string, kind = "roles") => ({
  ...pack,
  kind,
  localId,
});

describe("GP-08 pack upgrade reconciliation", () => {
  test("preview is a deterministic read-only report of template changes and override outcomes", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", {
      id: "counsel",
      title: "Our counsel",
    });
    const before = await h.authority();

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });

    expect(plan).toMatchObject({
      projectId: "a",
      bindingRevision: 1,
      definitionRevision: 1,
      currentPacks: [h.v1],
      proposedPacks: [h.v2],
      added: [],
      removed: [],
      changed: [{ before: h.v1, after: h.v2 }],
      issues: [],
      noop: false,
      ignoredResolutions: [],
      activePins: {
        availability: "unavailable",
        reason: "pack_configuration_run_pins_not_modelled",
      },
    });
    expect(plan.templates).toEqual({
      availability: "available",
      changes: [
        {
          packId: "org.example.custom",
          kind: "roles",
          localId: "clerk",
          change: "added",
          customized: false,
        },
        {
          packId: "org.example.custom",
          kind: "roles",
          localId: "counsel",
          change: "changed",
          customized: true,
        },
        {
          packId: "org.example.custom",
          kind: "roles",
          localId: "paralegal",
          change: "removed",
          customized: false,
        },
      ],
    });
    expect(plan.overrides).toEqual([
      {
        source: source(h.v1, "counsel"),
        operation: "replace",
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "counsel"),
      },
    ]);
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(plan)).not.toContain("Our counsel");
    expect(
      (await h.upgrade().preview({ projectId: "a", desired: [h.v2] }))
        .planDigest,
    ).toBe(plan.planDigest);
    expect(await h.authority()).toEqual(before);
  });

  test("apply upgrades the selection and retargets a customized definition without rewriting it", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", {
      id: "counsel",
      title: "Our counsel",
    });
    await h.override(h.v1, "greeting", "disable", undefined, "prompts");
    const untouched = () =>
      h.database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'project_pack_binding%' AND name NOT LIKE 'project_definition%' AND name NOT IN ('project_owned_definition','audit_event') ORDER BY name",
        )
        .all()
        .map(({ name }) => [
          name,
          h.database.query(`SELECT * FROM "${name}"`).all(),
        ]);
    const other = JSON.stringify(untouched());
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });

    const result = await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    expect(result).toEqual({
      result: "applied",
      planDigest: plan.planDigest,
      bindingRevision: 2,
      definitionRevision: 3,
      packs: [h.v2],
    });
    const state = await h.storage.definitions.get("a");
    expect(state.overrides).toMatchObject([
      {
        source: source(h.v2, "greeting", "prompts"),
        operation: "disable",
        revision: 2,
        actorId: "operator",
      },
      {
        source: source(h.v2, "counsel"),
        operation: "replace",
        payload: { id: "counsel", title: "Our counsel" },
        revision: 2,
        actorId: "operator",
      },
    ]);
    const resolved = await h.configuration();
    expect(resolved.configurationDigest).toBe(
      plan.prospectiveConfigurationDigest,
    );
    expect(
      resolved.effectiveDefinitions.roles.find(
        (role) => role.localId === "counsel",
      )?.payload,
    ).toEqual({ id: "counsel", title: "Our counsel" });
    expect(resolved.disabledDefinitions).toHaveLength(1);

    const audits = h.upgradeAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBe("operator");
    expect(JSON.parse(audits[0]!.payload_json)).toMatchObject({
      intent: "upgrade",
      planDigest: plan.planDigest,
      previousBindingRevision: 1,
      newBindingRevision: 2,
      previousDefinitionRevision: 2,
      newDefinitionRevision: 3,
      previousPacks: [h.v1],
      packs: [h.v2],
      templates: {
        availability: "available",
        added: 1,
        removed: 1,
        changed: 1,
      },
      prospectiveConfigurationDigest: plan.prospectiveConfigurationDigest,
      result: "applied",
    });
    expect(audits[0]!.payload_json).not.toContain("Our counsel");
    // No office, role, agent, pipeline, task or run state is touched.
    expect(JSON.stringify(untouched())).toBe(other);
  });

  test("repeating an applied upgrade is a no-op, even with the artifacts gone", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    const intent = {
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    };
    await h.upgrade().apply(intent);
    const applied = await h.authority();

    for (const catalog of [h.catalog, catalogOf().catalog]) {
      const repeated = await h.upgrade(catalog).apply(intent);
      expect(repeated).toMatchObject({
        result: "unchanged",
        bindingRevision: 2,
        definitionRevision: 2,
        packs: [h.v2],
      });
      expect(
        await h.upgrade(catalog).preview({ projectId: "a", desired: [h.v2] }),
      ).toMatchObject({ noop: true, issues: [] });
    }
    expect(await h.authority()).toEqual(applied);
  });

  test("apply requires the digest of the current plan", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const before = await h.authority();
    const stale = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });

    for (const approvedPlanDigest of ["", "sha256:0", stale.planDigest])
      await expect(
        h.upgrade().apply({
          projectId: "a",
          desired: [h.v2],
          approvedPlanDigest,
          actorId: "operator",
        }),
      ).rejects.toMatchObject({
        name: "ProjectPackUpgradeError",
        code: "plan_not_approved",
      });
    expect((await h.authority()).binding).toEqual(before.binding);
    expect(h.upgradeAudits()).toHaveLength(0);
  });

  test("a customized definition removed upstream blocks until explicitly resolved, and is never discarded silently", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "paralegal", "replace", {
      id: "paralegal",
      title: "Our paralegal",
    });
    const before = await h.authority();

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(blocked.overrides).toEqual([
      {
        source: source(h.v1, "paralegal"),
        operation: "replace",
        outcome: "conflict",
        upstream: "removed",
        conflict: "source_definition_removed",
      },
    ]);
    expect(blocked.issues).toMatchObject([
      {
        code: "unresolved_override_conflict",
        detail: "source_definition_removed",
      },
    ]);
    expect(blocked.prospectiveConfigurationDigest).toBeUndefined();
    const error: unknown = await h
      .upgrade()
      .apply({
        projectId: "a",
        desired: [h.v2],
        approvedPlanDigest: blocked.planDigest,
        actorId: "operator",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectPackUpgradeError);
    expect(error).toMatchObject({
      code: "upgrade_blocked",
      issues: [{ detail: "source_definition_removed" }],
    });
    expect(await h.authority()).toEqual(before);

    const resolutions = [
      { source: source(h.v1, "paralegal"), action: "retain_as_project_owned" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2], resolutions });
    expect(plan.issues).toEqual([]);
    expect(plan.overrides).toMatchObject([
      {
        outcome: "retained_as_project_owned",
        retainedAs: { kind: "roles", id: "paralegal" },
      },
    ]);
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      resolutions,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    const state = await h.storage.definitions.get("a");
    expect(state.overrides).toEqual([]);
    expect(state.owned).toMatchObject([
      {
        origin: "project_owned",
        kind: "roles",
        id: "paralegal",
        enabled: true,
        revision: 1,
        payload: { id: "paralegal", title: "Our paralegal" },
      },
    ]);
    expect((await h.configuration()).configurationDigest).toBe(
      plan.prospectiveConfigurationDigest,
    );
    // The same intent again changes nothing; its resolution is now unused.
    expect(
      await h.upgrade().apply({
        projectId: "a",
        desired: [h.v2],
        resolutions,
        approvedPlanDigest: plan.planDigest,
        actorId: "operator",
      }),
    ).toMatchObject({ result: "unchanged" });
    expect(h.upgradeAudits()).toHaveLength(1);
  });

  test("an extension the new template already fills is a conflict that only an explicit removal resolves", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "paralegal", "extend", { title: "Our paralegal" });

    const blocked = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v3] });
    expect(blocked.overrides).toMatchObject([
      { outcome: "conflict", upstream: "changed", conflict: "extend_conflict" },
    ]);
    const retained = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v3],
      resolutions: [
        {
          source: source(h.v1, "paralegal"),
          action: "retain_as_project_owned",
        },
      ],
    });
    expect(retained.issues).toMatchObject([
      { code: "invalid_resolution", detail: "extend_conflict" },
    ]);

    const resolutions = [
      { source: source(h.v1, "paralegal"), action: "remove_override" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v3], resolutions });
    expect(plan.overrides).toMatchObject([
      { outcome: "removed", conflict: "extend_conflict" },
    ]);
    await h.upgrade().apply({
      projectId: "a",
      desired: [h.v3],
      resolutions,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    expect((await h.storage.definitions.get("a")).overrides).toEqual([]);
    expect(JSON.parse(h.upgradeAudits()[0]!.payload_json)).toMatchObject({
      overrides: [
        {
          source: source(h.v1, "paralegal"),
          outcome: "removed",
          conflict: "extend_conflict",
        },
      ],
    });
  });

  test("an extension the new template still leaves open follows the upgrade", async () => {
    const h = await harness();
    await h.bind([h.v3]);
    await h.override(h.v3, "counsel", "extend", { description: "Ours" });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.overrides).toMatchObject([
      {
        outcome: "retargeted",
        upstream: "changed",
        target: source(h.v2, "counsel"),
      },
    ]);
    expect(plan.issues).toEqual([]);
  });

  test("detaching a pack with a project override is blocked until the override is resolved", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });

    const blocked = await h.upgrade().preview({ projectId: "a", desired: [] });
    expect(blocked.removed).toEqual([h.v1]);
    expect(blocked.issues).toMatchObject([
      { code: "unresolved_override_conflict", detail: "source_pack_removed" },
    ]);

    const resolutions = [
      { source: source(h.v1, "counsel"), action: "retain_as_project_owned" },
    ];
    const plan = await h
      .upgrade()
      .preview({ projectId: "a", desired: [], resolutions });
    await h.upgrade().apply({
      projectId: "a",
      desired: [],
      resolutions,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    expect((await h.storage.packBindings.get("a")).packs).toEqual([]);
    expect((await h.storage.definitions.get("a")).owned).toMatchObject([
      { kind: "roles", id: "counsel" },
    ]);
    expect((await h.configuration()).selectedPacks).toEqual([]);
  });

  test("overrides left on an old version by an earlier selection change are reconciled without changing the selection", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    await h.bind([h.v2]);
    await expect(h.configuration()).rejects.toMatchObject({
      code: "unresolved_override",
    });

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan).toMatchObject({
      noop: false,
      changed: [],
      templates: { availability: "available", changes: [] },
      overrides: [{ outcome: "retargeted", upstream: "changed" }],
    });
    const result = await h.upgrade().apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    expect(result).toMatchObject({ bindingRevision: 2, definitionRevision: 2 });
    expect((await h.configuration()).configurationDigest).toBe(
      plan.prospectiveConfigurationDigest,
    );
  });

  test("a second override already on the target definition is a conflict", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    await h.bind([h.v2]);
    await h.override(h.v2, "counsel", "replace", { id: "counsel", title: "B" });

    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    expect(plan.overrides).toMatchObject([
      { source: source(h.v1, "counsel"), conflict: "target_override_exists" },
      { source: source(h.v2, "counsel"), outcome: "unchanged" },
    ]);
    expect(plan.issues).toMatchObject([{ detail: "target_override_exists" }]);
  });

  test("an unavailable target or an invalid reconciled configuration blocks the upgrade", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const before = await h.authority();
    const { catalog: withoutTarget } = catalogOf(v1Bytes);
    const missing = await h
      .upgrade(withoutTarget)
      .preview({ projectId: "a", desired: [h.v2] });
    expect(missing.issues).toMatchObject([
      { code: "target_closure_unresolved", detail: "missing_pack" },
    ]);

    // The project already owns the role the new version starts to provide.
    await new ManageProjectDefinitions({
      projects: h.storage.projects,
      definitions: h.storage.definitions,
      bindings: h.storage.packBindings,
      catalog: h.catalog,
      auditEvents: h.storage.auditEvents,
      transactions: h.storage.transactions,
      clock: { now: () => now },
      ids: { generate: () => "definition-audit" },
    }).apply({
      projectId: "a",
      expectedRevision: 0,
      actorId: "author",
      mutation: {
        action: "put_owned",
        kind: "roles",
        id: "clerk",
        enabled: true,
        payload: { id: "clerk" },
      },
    });
    const colliding = await h
      .upgrade()
      .preview({ projectId: "a", desired: [h.v2] });
    expect(colliding.issues).toMatchObject([
      {
        code: "prospective_configuration_invalid",
        detail: "duplicate_effective_definition",
      },
    ]);
    for (const [catalog, plan] of [
      [withoutTarget, missing],
      [h.catalog, colliding],
    ] as const)
      await expect(
        h.upgrade(catalog).apply({
          projectId: "a",
          desired: [h.v2],
          approvedPlanDigest: plan.planDigest,
          actorId: "operator",
        }),
      ).rejects.toMatchObject({ code: "upgrade_blocked" });
    expect((await h.authority()).binding).toEqual(before.binding);
    expect(h.upgradeAudits()).toHaveLength(0);
  });

  test("an unavailable previous version is reported, not guessed, and does not block", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    const { catalog: onlyTarget } = catalogOf(v2Bytes);

    const plan = await h
      .upgrade(onlyTarget)
      .preview({ projectId: "a", desired: [h.v2] });
    expect(plan.templates).toEqual({
      availability: "unavailable",
      reason: "previous_closure_unresolved",
      detail: "missing_pack",
    });
    expect(plan.overrides).toMatchObject([
      { outcome: "retargeted", upstream: "unknown" },
    ]);
    expect(plan.issues).toEqual([]);
    await h.upgrade(onlyTarget).apply({
      projectId: "a",
      desired: [h.v2],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    expect(JSON.parse(h.upgradeAudits()[0]!.payload_json)).toMatchObject({
      templates: { availability: "unavailable" },
    });
  });

  test("an audit failure rolls back the selection, the definitions and the audit row", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    const before = await h.authority();
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    const failing: AuditEventRepository = {
      ...h.storage.auditEvents,
      append: async (event) => {
        await h.storage.auditEvents.append(event);
        throw new Error("audit unavailable");
      },
    };

    await expect(
      h.upgrade(h.catalog, failing).apply({
        projectId: "a",
        desired: [h.v2],
        approvedPlanDigest: plan.planDigest,
        actorId: "operator",
      }),
    ).rejects.toThrow("audit unavailable");
    expect(await h.authority()).toEqual(before);
  });

  test("a change between the approved plan and the write fails stale and writes nothing", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    await h.override(h.v1, "counsel", "replace", { id: "counsel" });
    const plan = await h.upgrade().preview({ projectId: "a", desired: [h.v2] });
    let runs = 0;
    const racing: TransactionRunner = {
      run: async (work) => {
        // The first transaction is the plan's read; race the write.
        if (++runs === 2)
          await h.override(h.v1, "greeting", "disable", undefined, "prompts");
        return h.storage.transactions.run(work);
      },
    };

    await expect(
      h.upgrade(h.catalog, h.storage.auditEvents, racing).apply({
        projectId: "a",
        desired: [h.v2],
        approvedPlanDigest: plan.planDigest,
        actorId: "operator",
      }),
    ).rejects.toBeInstanceOf(StaleProjectDefinitionError);
    expect((await h.storage.packBindings.get("a")).packs).toEqual([h.v1]);
    expect((await h.storage.definitions.get("a")).overrides).toHaveLength(2);
    expect(h.upgradeAudits()).toHaveLength(0);
  });

  test("malformed intents fail typed; unused resolutions are reported and change nothing", async () => {
    const h = await harness();
    await h.bind([h.v1]);
    const resolution = {
      source: source(h.v1, "counsel"),
      action: "remove_override",
    };
    for (const resolutions of [
      {},
      [{ ...resolution, extra: true }],
      [{ ...resolution, action: "discard" }],
      [{ ...resolution, source: { ...resolution.source, kind: "unknown" } }],
      [resolution, resolution],
    ])
      await expect(
        h.upgrade().preview({ projectId: "a", desired: [h.v2], resolutions }),
      ).rejects.toMatchObject({
        name: "ProjectPackUpgradeError",
        code: "malformed_request",
      });
    await expect(
      h.upgrade().preview({ projectId: "a", desired: [h.v1, h.v2] }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      h.upgrade().preview({ projectId: "missing", desired: [] }),
    ).rejects.toMatchObject({ name: "ProjectNotFoundError" });

    const plan = await h.upgrade().preview({
      projectId: "a",
      desired: [h.v2],
      resolutions: [resolution],
    });
    expect(plan.ignoredResolutions).toEqual([resolution]);
    expect(plan.issues).toEqual([]);
    expect(plan.planDigest).not.toBe(
      (await h.upgrade().preview({ projectId: "a", desired: [h.v2] }))
        .planDigest,
    );
  });
});

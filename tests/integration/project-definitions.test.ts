import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import {
  parseDefinitionMutation,
  StaleProjectDefinitionError,
} from "@ai-office/application/domain-pack/project-definition.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
  parseDomainPackId,
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

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp07-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const legalBytes = readFileSync(
    new URL("../fixtures/domain-pack/legal.json", import.meta.url),
  );
  const legal = catalog.register({
    bytes: legalBytes,
    artifactDigest: computeArtifactDigest(legalBytes),
    provenance: { installerId: "local-distribution", reference: "legal" },
  });
  const parsed = parseDomainPackManifest(
    readFileSync(
      new URL("../fixtures/domain-pack/custom.json", import.meta.url),
    ),
  );
  const withPrompt = {
    ...parsed,
    contributions: {
      ...parsed.contributions,
      prompts: [
        { id: "greeting" as (typeof parsed.contributions.roles)[number]["id"] },
      ],
    },
  };
  const promptBytes = new TextEncoder().encode(
    JSON.stringify({
      ...withPrompt,
      manifestDigest: computeManifestDigest(withPrompt),
    }),
  );
  const promptPack = catalog.register({
    bytes: promptBytes,
    artifactDigest: computeArtifactDigest(promptBytes),
    provenance: { installerId: "local-distribution", reference: "prompts" },
  });
  await storage.projects.save(
    Project.create({
      id: "a",
      name: "A",
      now: new Date("2026-10-03T00:00:00.000Z"),
    }),
  );
  await storage.projects.save(
    Project.create({
      id: "b",
      name: "B",
      now: new Date("2026-10-03T00:00:00.000Z"),
    }),
  );
  let sequence = 0;
  const service = (
    auditEvents = storage.auditEvents,
    transactions = storage.transactions,
  ) =>
    new ManageProjectDefinitions({
      projects: storage.projects,
      definitions: storage.definitions,
      bindings: storage.packBindings,
      catalog,
      auditEvents,
      transactions,
      clock: { now: () => new Date("2026-10-03T00:00:00.000Z") },
      ids: { generate: () => `audit-${++sequence}` },
    });
  const bind = async (packs: (typeof legal)[] = [legal]) => {
    await storage.packBindings.replace(
      "a",
      (await storage.packBindings.get("a")).configurationRevision,
      packs,
      new Date("2026-10-03T00:00:00.000Z"),
    );
  };
  return { database, storage, catalog, legal, promptPack, service, bind };
}

const source = (
  pack: { id: string; version: string; manifestDigest: string },
  kind = "roles",
  localId = "counsel",
) => ({ ...pack, kind, localId });
const putOverride = (
  pack: { id: string; version: string; manifestDigest: string },
  operation: string,
  payload?: object,
  kind = "roles",
  localId = "counsel",
) => ({
  action: "put_override",
  source: source(pack, kind, localId),
  operation,
  ...(payload === undefined ? {} : { payload }),
});
const apply = (
  service: ReturnType<Awaited<ReturnType<typeof harness>>["service"]>,
  mutation: unknown,
  expectedRevision: number,
) =>
  service.apply({
    projectId: "a",
    mutation,
    expectedRevision,
    actorId: "operator",
  });

describe("GP-07 authoritative definition ownership", () => {
  test("schema-1 operation matrix rejects every unsupported kind and operation", () => {
    const descriptive = new Set([
      "roles",
      "taskTypes",
      "agents",
      "artifactTypes",
      "evidenceTypes",
      "knowledge",
      "prompts",
    ]);
    for (const kind of contributionKinds)
      for (const operation of ["replace", "extend", "disable"] as const) {
        const mutation = putOverride(
          {
            id: "org.example.legal",
            version: "1.0.0",
            manifestDigest: `sha256:${"a".repeat(64)}`,
          },
          operation,
          operation === "disable"
            ? undefined
            : operation === "extend"
              ? { title: "Added" }
              : { id: "counsel" },
          kind,
        );
        const supported =
          operation === "disable" ? kind === "prompts" : descriptive.has(kind);
        if (supported)
          expect(() => parseDefinitionMutation(mutation)).not.toThrow();
        else
          expect(() => parseDefinitionMutation(mutation)).toThrow(
            /unsupported/u,
          );
      }
  });
  test("SQLite constrains malformed source tuples and project ownership", async () => {
    const { database } = await harness();
    database
      .query("INSERT INTO project_definition_head(project_id) VALUES ('a')")
      .run();
    const insert =
      database.query(`INSERT INTO project_definition_override(project_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
      VALUES (?,?,?,?,?,'counsel','replace',1,'{"id":"counsel"}','operator','2026-10-03T00:00:00.000Z')`);
    const digest = `sha256:${"a".repeat(64)}`;
    expect(() =>
      insert.run("missing", "org.example.legal", "1.0.0", digest, "roles"),
    ).toThrow();
    expect(() =>
      insert.run("a", "org.example.legal", "latest", digest, "roles"),
    ).toThrow();
    expect(() =>
      insert.run(
        "a",
        "org.example.legal",
        "1.0.0",
        `sha256:${"z".repeat(64)}`,
        "roles",
      ),
    ).toThrow();
    database.close();
  });
  test("project-owned definitions round-trip independently, with checked revision and audit", async () => {
    const { database, storage, service } = await harness();
    const mutation = {
      action: "put_owned",
      kind: "roles",
      id: "custom",
      enabled: true,
      payload: { id: "custom", title: "Custom" },
    };
    expect((await service().preview("a", mutation)).issues).toEqual([]);
    expect((await storage.definitions.get("a")).revision).toBe(0);
    const applied = await apply(service(), mutation, 0);
    expect(applied).toMatchObject({
      revision: 1,
      owned: [{ origin: "project_owned", id: "custom", revision: 1 }],
    });
    expect((await storage.definitions.get("b")).owned).toEqual([]);
    expect((await service().preview("a", mutation)).issues).toMatchObject([
      { code: "duplicate_project_definition" },
    ]);
    await expect(apply(service(), mutation, 1)).rejects.toMatchObject({
      code: "duplicate_project_definition",
    });
    await expect(
      apply(service(), { ...mutation, expectedEntryRevision: 1 }, 0),
    ).rejects.toThrow("stale");
    expect(
      (
        await apply(
          service(),
          {
            ...mutation,
            expectedEntryRevision: 1,
            payload: { id: "custom", title: "Changed" },
          },
          1,
        )
      ).owned[0],
    ).toMatchObject({ revision: 2, payload: { title: "Changed" } });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_event WHERE event_type='project.definition_changed'",
        )
        .get()?.count,
    ).toBe(2);
    const audit = database
      .query<
        {
          project_id: string;
          actor_id: string;
          occurred_at: string;
          payload_json: string;
        },
        []
      >(
        "SELECT project_id,actor_id,occurred_at,payload_json FROM audit_event WHERE event_type='project.definition_changed' ORDER BY occurred_at,id LIMIT 1",
      )
      .get()!;
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      action: "put_owned",
      origin: "project_owned",
      operation: "put_owned",
      previousRevision: 0,
      newRevision: 1,
      previousEntryRevision: null,
      newEntryRevision: 1,
      identity: { kind: "roles", id: "custom" },
    });
    expect(audit.project_id).toBe("a");
    expect(audit.actor_id).toBe("operator");
    expect(audit.occurred_at).toBe("2026-10-03T00:00:00.000Z");
    expect(audit.payload_json.length).toBeLessThan(500);
    expect(audit.payload_json).not.toContain("Custom");
    database.close();
  });

  test("project-owned workflow uses schema-1 typed references without changing legacy pipelines", async () => {
    const { database, service } = await harness();
    const mutation = {
      action: "put_owned",
      kind: "workflows",
      id: "review",
      enabled: true,
      payload: {
        id: "review",
        taskType: "matter",
        stages: [{ id: "intake", role: "counsel" }],
      },
    };
    expect((await apply(service(), mutation, 0)).owned[0]).toMatchObject({
      kind: "workflows",
      payload: { taskType: "matter", stages: [{ role: "counsel" }] },
    });
    expect(() =>
      parseDefinitionMutation({
        ...mutation,
        payload: {
          ...mutation.payload,
          stages: [
            { id: "same", role: "counsel" },
            { id: "same", role: "counsel" },
          ],
        },
      }),
    ).toThrow();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM pipeline_run",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("validates installed pack bytes before opening the definition transaction", async () => {
    const { database, storage, catalog, legal, service, bind } =
      await harness();
    await bind([legal]);
    let inTransaction = false;
    const run = storage.transactions.run.bind(storage.transactions);
    vi.spyOn(storage.transactions, "run").mockImplementation(async (work) => {
      inTransaction = true;
      try {
        return await run(work);
      } finally {
        inTransaction = false;
      }
    });
    const read = catalog.read.bind(catalog);
    vi.spyOn(catalog, "read").mockImplementation((id, version) => {
      expect(inTransaction).toBe(false);
      return read(id, version);
    });
    await apply(
      service(),
      putOverride(legal, "replace", { id: "counsel", title: "Lead counsel" }),
      0,
    );
    database.close();
  });

  test("exact source pinning, safe operations and explicit unresolved conflicts", async () => {
    const { database, storage, legal, promptPack, service, bind } =
      await harness();
    await bind([legal]);
    const replace = putOverride(legal, "replace", {
      id: "counsel",
      title: "Lead counsel",
    });
    expect((await service().preview("a", replace)).issues).toEqual([]);
    await apply(service(), replace, 0);
    expect((await service().inspect("a")).issues).toEqual([]);
    expect((await service().preview("a", replace)).issues).toMatchObject([
      { code: "duplicate_override_target" },
    ]);
    const extension = putOverride(legal, "extend", {
      description: "Additional guidance",
    });
    await apply(service(), { ...extension, expectedEntryRevision: 1 }, 1);
    expect((await service().read("a")).overrides[0]).toMatchObject({
      operation: "extend",
      revision: 2,
    });
    expect(
      (
        await service().preview("a", {
          ...putOverride(legal, "extend", { title: "Override" }),
          expectedEntryRevision: 2,
        })
      ).issues,
    ).toMatchObject([{ code: "protected_security_invariant" }]);
    const wrongDigest = putOverride(
      { ...legal, manifestDigest: `sha256:${"b".repeat(64)}` },
      "replace",
      { id: "counsel" },
    );
    expect((await service().preview("a", wrongDigest)).issues).toMatchObject([
      { code: "source_digest_mismatch" },
    ]);
    const wrongVersion = putOverride(
      { ...legal, version: "2.0.0" },
      "replace",
      { id: "counsel" },
    );
    expect((await service().preview("a", wrongVersion)).issues).toMatchObject([
      { code: "source_pack_not_selected" },
    ]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(legal, "replace", { id: "counsel" }, "agents", "counsel"),
        )
      ).issues,
    ).toMatchObject([{ code: "source_definition_missing" }]);
    expect((await service().read("a")).overrides).toMatchObject([
      { source: { kind: "roles", localId: "counsel" } },
    ]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(legal, "replace", { id: "missing" }, "roles", "missing"),
        )
      ).issues.length,
    ).toBeGreaterThan(0);
    await storage.packBindings.replace(
      "a",
      1,
      [{ ...legal, version: "2.0.0" as typeof legal.version }],
      new Date("2026-10-03T00:00:00.000Z"),
    );
    expect((await service().inspect("a")).issues).toMatchObject([
      { code: "source_pack_not_selected", source: source(legal) },
    ]);
    await storage.packBindings.replace(
      "a",
      2,
      [
        {
          ...legal,
          manifestDigest:
            `sha256:${"b".repeat(64)}` as typeof legal.manifestDigest,
        },
      ],
      new Date("2026-10-03T00:00:00.000Z"),
    );
    expect((await service().inspect("a")).issues).toMatchObject([
      { code: "source_digest_mismatch", source: source(legal) },
    ]);
    expect((await storage.definitions.get("a")).overrides).toHaveLength(1);
    await storage.packBindings.replace(
      "a",
      3,
      [],
      new Date("2026-10-03T00:00:00.000Z"),
    );
    expect((await service().inspect("a")).issues).toMatchObject([
      { code: "source_pack_not_selected" },
    ]);
    await bind([promptPack]);
    const disable = putOverride(
      promptPack,
      "disable",
      undefined,
      "prompts",
      "greeting",
    );
    expect((await service().preview("a", disable)).issues).toEqual([]);
    await apply(service(), disable, 2);
    expect((await service().read("a")).overrides).toHaveLength(2);
    database.close();
  });

  test("extend fills only absent descriptive fields", async () => {
    const { database, catalog, legal, promptPack, service, bind } =
      await harness();
    await bind([legal]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(legal, "extend", { title: "Changed" }),
        )
      ).issues,
    ).toMatchObject([{ code: "protected_security_invariant" }]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(legal, "extend", { description: "Added" }),
        )
      ).issues,
    ).toEqual([]);
    expect(() =>
      parseDefinitionMutation(putOverride(legal, "extend", {})),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation(
        putOverride(legal, "extend", { id: "counsel", title: "Changed" }),
      ),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation(
        putOverride(legal, "extend", { title: "Added", mandatoryEvidence: [] }),
      ),
    ).toThrow();

    await bind([promptPack]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(
            promptPack,
            "extend",
            { title: "Added" },
            "prompts",
            "greeting",
          ),
        )
      ).issues,
    ).toEqual([]);

    const original = parseDomainPackManifest(
      readFileSync(
        new URL("../fixtures/domain-pack/legal.json", import.meta.url),
      ),
    );
    const described = {
      ...original,
      id: parseDomainPackId("org.example.described"),
      contributions: {
        ...original.contributions,
        roles: [
          { id: original.contributions.roles[0]!.id, description: "Existing" },
        ],
      },
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...described,
        manifestDigest: computeManifestDigest(described),
      }),
    );
    const describedPack = catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "described" },
    });
    await bind([describedPack]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(describedPack, "extend", { description: "Changed" }),
        )
      ).issues,
    ).toMatchObject([{ code: "protected_security_invariant" }]);
    database.close();
  });

  test("source diagnostics preserve stable distinctions and redact unexpected errors", async () => {
    const { database, catalog, legal, service, bind } = await harness();
    await bind([legal]);
    const mutation = putOverride(legal, "replace", { id: "counsel" });
    const trust = vi.spyOn(catalog, "trusts").mockReturnValue(false);
    expect((await service().preview("a", mutation)).issues).toMatchObject([
      { code: "source_untrusted" },
    ]);
    trust.mockRestore();
    const coreVersion = vi
      .spyOn(catalog, "coreContractVersion", "get")
      .mockReturnValue(99);
    expect((await service().preview("a", mutation)).issues).toMatchObject([
      { code: "source_incompatible_core" },
    ]);
    coreVersion.mockRestore();

    const original = parseDomainPackManifest(
      readFileSync(
        new URL("../fixtures/domain-pack/legal.json", import.meta.url),
      ),
    );
    const dependent = {
      ...original,
      id: parseDomainPackId("org.example.dependent"),
      dependencies: [
        {
          id: parseDomainPackId("org.example.missing"),
          version: original.version,
          manifestDigest: original.manifestDigest,
        },
      ],
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...dependent,
        manifestDigest: computeManifestDigest(dependent),
      }),
    );
    const dependentPack = catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "dependent" },
    });
    await bind([dependentPack]);
    expect(
      (
        await service().preview(
          "a",
          putOverride(dependentPack, "replace", { id: "counsel" }),
        )
      ).issues,
    ).toMatchObject([{ code: "source_dependency_unavailable" }]);
    await bind([legal]);
    const read = vi.spyOn(catalog, "read").mockImplementation(() => {
      throw new Error("private installation detail");
    });
    const issues = (await service().preview("a", mutation)).issues;
    expect(issues).toMatchObject([{ code: "source_unavailable" }]);
    expect(JSON.stringify(issues)).not.toContain("private installation detail");
    read.mockRestore();
    database.close();
  });

  test("removal uses the exact project revision and preserves binding and other entries", async () => {
    const { database, storage, legal, service, bind } = await harness();
    await bind([legal]);
    const owned = {
      action: "put_owned",
      kind: "roles",
      id: "custom",
      enabled: true,
      payload: { id: "custom", title: "Custom" },
    };
    await apply(service(), owned, 0);
    await apply(service(), putOverride(legal, "replace", { id: "counsel" }), 1);
    expect(() =>
      parseDefinitionMutation({
        action: "remove_owned",
        kind: "roles",
        id: "custom",
        expectedEntryRevision: 1,
      }),
    ).toThrow();
    await expect(
      apply(
        service(),
        { action: "remove_owned", kind: "roles", id: "custom" },
        1,
      ),
    ).rejects.toBeInstanceOf(StaleProjectDefinitionError);
    const afterOwnedRemoval = await apply(
      service(),
      { action: "remove_owned", kind: "roles", id: "custom" },
      2,
    );
    expect(afterOwnedRemoval).toMatchObject({
      revision: 3,
      owned: [],
      overrides: [{ source: source(legal) }],
    });
    await expect(
      apply(service(), { action: "remove_override", source: source(legal) }, 2),
    ).rejects.toBeInstanceOf(StaleProjectDefinitionError);
    expect(
      await apply(
        service(),
        { action: "remove_override", source: source(legal) },
        3,
      ),
    ).toMatchObject({ revision: 4, owned: [], overrides: [] });
    expect((await storage.packBindings.get("a")).packs).toEqual([legal]);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_event WHERE event_type='project.definition_changed'",
        )
        .get()?.count,
    ).toBe(4);
    database.close();
  });

  test("rechecks the exact selected binding inside the mutation transaction", async () => {
    const { database, storage, legal, service, bind } = await harness();
    await bind([legal]);
    const transactions = {
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        await storage.packBindings.replace(
          "a",
          1,
          [
            {
              ...legal,
              manifestDigest:
                `sha256:${"b".repeat(64)}` as typeof legal.manifestDigest,
            },
          ],
          new Date("2026-10-03T00:00:00.000Z"),
        );
        return storage.transactions.run(work);
      },
    };
    await expect(
      apply(
        service(storage.auditEvents, transactions),
        putOverride(legal, "replace", { id: "counsel" }),
        0,
      ),
    ).rejects.toMatchObject({ code: "source_digest_mismatch" });
    expect(await storage.definitions.get("a")).toMatchObject({
      revision: 0,
      owned: [],
      overrides: [],
    });
    database.close();
  });

  test("audit append failure rolls back owned and override authority and the audit row", async () => {
    for (const mutationKind of ["owned", "override"] as const) {
      const { database, storage, legal, service, bind } = await harness();
      await bind([legal]);
      const mutation =
        mutationKind === "owned"
          ? {
              action: "put_owned",
              kind: "roles",
              id: "custom",
              enabled: true,
              payload: { id: "custom" },
            }
          : putOverride(legal, "replace", { id: "counsel" });
      await expect(
        apply(
          service({
            append: async (event) => {
              await storage.auditEvents.append(event);
              throw new Error("audit append failed after insert");
            },
          }),
          mutation,
          0,
        ),
      ).rejects.toThrow("audit append failed after insert");
      expect(await storage.definitions.get("a")).toMatchObject({
        revision: 0,
        owned: [],
        overrides: [],
      });
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM project_definition_head WHERE project_id='a'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_event WHERE event_type='project.definition_changed'",
          )
          .get()?.count,
      ).toBe(0);
      database.close();
    }
  });

  test("concurrent same-entry updates commit once with one complete audit", async () => {
    const { database, storage, service } = await harness();
    const mutation = {
      action: "put_owned",
      kind: "roles",
      id: "custom",
      enabled: true,
      payload: { id: "custom", title: "Initial" },
    };
    await apply(service(), mutation, 0);
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredAudit!: () => void;
    const atAudit = new Promise<void>((resolve) => {
      enteredAudit = resolve;
    });
    const first = apply(
      service({
        append: async (event) => {
          enteredAudit();
          await mayCommit;
          await storage.auditEvents.append(event);
        },
      }),
      {
        ...mutation,
        payload: { id: "custom", title: "First" },
        expectedEntryRevision: 1,
      },
      1,
    );
    try {
      await atAudit;
      await expect(
        apply(
          service(),
          {
            ...mutation,
            payload: { id: "custom", title: "Second" },
            expectedEntryRevision: 1,
          },
          1,
        ),
      ).rejects.toBeInstanceOf(StaleProjectDefinitionError);
    } finally {
      release();
    }
    await first;
    expect(await storage.definitions.get("a")).toMatchObject({
      revision: 2,
      owned: [{ id: "custom", revision: 2, payload: { title: "First" } }],
      overrides: [],
    });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_event WHERE event_type='project.definition_changed'",
        )
        .get()?.count,
    ).toBe(2);
    database.close();
  });

  test("protected fields, unsupported operations, and audit failure cannot mutate authority", async () => {
    const { database, storage, legal, service, bind } = await harness();
    await bind();
    expect(() =>
      parseDefinitionMutation(putOverride(legal, "disable", undefined)),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation(
        putOverride(legal, "replace", {
          id: "counsel",
          capabilities: ["write"],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation({
        action: "put_owned",
        kind: "policies",
        id: "gate",
        enabled: true,
        payload: { id: "gate" },
      }),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation({
        action: "put_owned",
        kind: "roles",
        id: "r",
        enabled: true,
        payload: { id: "r", mandatoryEvidence: [] },
      }),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation({
        action: "put_override",
        source: {
          ...source(legal),
          artifactDigest: `sha256:${"a".repeat(64)}`,
        },
        operation: "replace",
        payload: { id: "counsel" },
      }),
    ).toThrow();
    expect(() =>
      parseDefinitionMutation({
        action: "put_owned",
        kind: "roles",
        id: "core",
        origin: "core_owned",
        enabled: true,
        payload: { id: "core" },
      }),
    ).toThrow();
    await expect(
      apply(
        service({
          append: async () => {
            throw new Error("audit failed");
          },
        }),
        putOverride(legal, "replace", { id: "counsel" }),
        0,
      ),
    ).rejects.toThrow("audit failed");
    expect((await storage.definitions.get("a")).revision).toBe(0);
    database.close();
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { parseDefinitionMutation } from "@ai-office/application/domain-pack/project-definition.ts";
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
  const service = (auditEvents = storage.auditEvents) =>
    new ManageProjectDefinitions({
      projects: storage.projects,
      definitions: storage.definitions,
      bindings: storage.packBindings,
      catalog,
      auditEvents,
      transactions: storage.transactions,
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
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM audit_event WHERE event_type='project.definition_changed' LIMIT 1",
      )
      .get()!;
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      origin: "project_owned",
      previousRevision: 0,
      newRevision: 1,
      identity: { kind: "roles", id: "custom" },
    });
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

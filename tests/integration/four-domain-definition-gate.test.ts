import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ReconcileProjectPackUpgrade } from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

const now = new Date("2026-10-08T00:00:00.000Z");
const packNames = ["development", "legal", "manufacturing"] as const;
const rootPaths: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const path of rootPaths.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function nextVersion(bytes: Uint8Array): Uint8Array {
  const manifest = verifyDomainPackManifest(bytes, 1);
  const roles = manifest.contributions.roles;
  const second = roles[1]!;
  const draft = {
    ...manifest,
    version: manifest.version === "0.5.0" ? "0.5.1" : "0.1.1",
    contributions: {
      ...manifest.contributions,
      roles: roles.map((role) =>
        role.id === second.id
          ? { ...role, title: `${role.title} in the next version` }
          : role,
      ),
    },
  };
  const digest = computeManifestDigest(
    parseDomainPackManifest(new TextEncoder().encode(JSON.stringify(draft))),
  );
  return new TextEncoder().encode(
    JSON.stringify({ ...draft, manifestDigest: digest }),
  );
}

test("four projects share the definition contracts without sharing pack state or activating runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp20-"));
  rootPaths.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const catalog = new InMemoryInstalledDomainPackCatalog(1, ["gp20-fixture"]);
  let sequence = 0;
  const ports = {
    projects: storage.projects,
    definitions: storage.definitions,
    bindings: storage.packBindings,
    catalog,
    auditEvents: storage.auditEvents,
    transactions: storage.transactions,
    clock: { now: () => now },
    ids: { generate: () => `audit-${++sequence}` },
  };
  const binding = new ManageProjectPackBinding(ports);
  const definitions = new ManageProjectDefinitions(ports);
  const configuration = new ReadProjectConfiguration(ports);
  const upgrade = new ReconcileProjectPackUpgrade(ports);

  for (const id of [...packNames, "garden"])
    await storage.projects.save(Project.create({ id, name: id, now }));

  const pinned = new Map<string, string>();
  for (const name of packNames) {
    const bytes = readFileSync(
      new URL(
        `../../packages/domain-pack-${name}/manifest.json`,
        import.meta.url,
      ),
    );
    const manifest = verifyDomainPackManifest(bytes, 1);
    const versions = [bytes, nextVersion(bytes)].map((artifact, index) =>
      catalog.register({
        bytes: artifact,
        artifactDigest: computeArtifactDigest(artifact),
        provenance: {
          installerId: "gp20-fixture",
          reference: `${name}-${index}`,
        },
      }),
    );
    const [v1, v2] = versions;
    const selection = await binding.preview(name, [v1!]);
    expect(selection.issues).toEqual([]);
    await binding.apply({
      projectId: name,
      desired: [v1!],
      expectedRevision: selection.current.configurationRevision,
      actorId: "operator",
    });
    const initial = await configuration.read(name);
    expect(initial.selectedPacks).toEqual([v1]);
    expect(initial.resolvedPacks).toEqual([v1]);
    expect(initial.roles.length).toBeGreaterThan(1);
    expect(initial.workflows.length).toBeGreaterThan(0);
    expect(
      initial.roles.every((role) =>
        role.roleId.startsWith(`pack:${manifest.id}/`),
      ),
    ).toBe(true);

    const customized = manifest.contributions.roles[0]!;
    const mutation = {
      action: "put_override",
      source: { ...v1!, kind: "roles", localId: customized.id },
      operation: "replace",
      payload: { id: customized.id, title: `${name} project title` },
    };
    expect((await definitions.preview(name, mutation)).issues).toEqual([]);
    await definitions.apply({
      projectId: name,
      mutation,
      expectedRevision: 0,
      actorId: "project-owner",
    });
    const plan = await upgrade.preview({ projectId: name, desired: [v2!] });
    expect(plan.issues).toEqual([]);
    await upgrade.apply({
      projectId: name,
      desired: [v2!],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    const resolved = await configuration.read(name);
    expect(resolved.selectedPacks).toEqual([v2]);
    expect(
      resolved.roles.find((role) => role.roleId.endsWith(`/${customized.id}`)),
    ).toMatchObject({
      title: `${name} project title`,
      customization: "replace",
    });
    const upstream = manifest.contributions.roles[1]!;
    expect(
      resolved.roles.find((role) => role.roleId.endsWith(`/${upstream.id}`))
        ?.title,
    ).toBe(`${upstream.title} in the next version`);
    pinned.set(name, resolved.configurationDigest);
  }

  const custom = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/project-definitions/community-garden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { definitions: unknown[] };
  for (const mutation of custom.definitions) {
    const preview = await definitions.preview("garden", mutation);
    expect(preview.issues).toEqual([]);
    await definitions.apply({
      projectId: "garden",
      mutation,
      expectedRevision: preview.current.revision,
      actorId: "garden-owner",
    });
  }
  const garden = await configuration.read("garden");
  expect(garden.selectedPacks).toEqual([]);
  expect(garden.resolvedPacks).toEqual([]);
  expect(garden.projectOwnedDefinitions).toHaveLength(7);
  expect(garden.roles.every((role) => role.roleId.startsWith("project:"))).toBe(
    true,
  );
  for (const name of packNames)
    expect((await configuration.read(name)).configurationDigest).toBe(
      pinned.get(name),
    );
  for (const table of ["pipeline_run", "agent_run", "capability_grants"])
    expect(
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()?.count,
    ).toBe(0);
});

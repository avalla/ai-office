import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/project-definitions/community-garden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { domain: string; definitions: unknown[] };
const now = new Date("2026-10-07T00:00:00.000Z");
const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp19-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  await storage.projects.save(
    Project.create({ id: "garden", name: "Community garden", now }),
  );
  const catalog = new InMemoryInstalledDomainPackCatalog(1, []);
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
  return {
    database,
    binding: new ManageProjectPackBinding(ports),
    definitions: new ManageProjectDefinitions(ports),
    configuration: new ReadProjectConfiguration(ports),
  };
}

describe("GP-19 empty/custom domain fixture", () => {
  test("resolves a new project with zero official packs", async () => {
    const h = await harness();
    const preview = await h.binding.preview("garden", []);
    expect(preview.issues).toEqual([]);
    expect((await h.binding.read("garden")).packs).toEqual([]);
    const view = await h.configuration.read("garden");
    expect(view.selectedPacks).toEqual([]);
    expect(view.resolvedPacks).toEqual([]);
    expect(view.projectOwnedDefinitions).toEqual([]);
    expect(view.roles).toEqual([]);
    expect(view.agents).toEqual([]);
    expect(view.workflows).toEqual([]);
    expect(view.knowledge).toEqual([]);
    expect(view.artifactTypes).toEqual([]);
  });

  test("adds and customizes project-owned garden definitions without a pack", async () => {
    const h = await harness();
    expect(fixture.domain).toBe("community-garden");
    for (const mutation of fixture.definitions) {
      const preview = await h.definitions.preview("garden", mutation);
      expect(preview.issues).toEqual([]);
      await h.definitions.apply({
        projectId: "garden",
        mutation,
        expectedRevision: preview.current.revision,
        actorId: "garden-owner",
      });
    }
    const before = await h.configuration.read("garden");
    expect(before.selectedPacks).toEqual([]);
    expect(before.projectOwnedDefinitions).toHaveLength(7);
    expect(before.roles.map((role) => role.roleId)).toEqual([
      "project:roles/coordinator",
      "project:roles/gardener",
    ]);
    expect(before.agents).toMatchObject([
      {
        agentId: "project:agents/garden-helper",
        origin: "project_owned",
        roleId: "project:roles/gardener",
        knowledge: ["project:knowledge/garden-guide"],
        capabilities: [],
      },
    ]);
    expect(before.workflows).toMatchObject([
      {
        workflowId: "project:workflows/plot-care-flow",
        origin: "project_owned",
        taskTypeId: "project:taskTypes/plot-care",
        stages: [
          { id: "observe", roleId: "project:roles/gardener" },
          { id: "review", roleId: "project:roles/coordinator" },
        ],
      },
    ]);
    expect(before.knowledge).toMatchObject([
      {
        knowledgeId: "project:knowledge/garden-guide",
        origin: "project_owned",
        title: "Local growing guide",
      },
    ]);
    expect(before.effectiveDefinitions.artifactTypes).toMatchObject([
      {
        effectiveId: "project:artifactTypes/plot-note",
        payload: { title: "Plot observation note" },
      },
    ]);
    expect(before.artifactTypes).toEqual([]);
    expect(before.policies).toEqual([]);
    expect(before.capabilities).toEqual([]);
    expect(
      Object.values(before.origins).every(
        (item) => item.origin === "project_owned",
      ),
    ).toBe(true);

    const update = {
      action: "put_owned",
      kind: "roles",
      id: "gardener",
      expectedEntryRevision: 1,
      enabled: true,
      payload: { id: "gardener", title: "Lead volunteer gardener" },
    };
    const duplicate = {
      action: update.action,
      kind: update.kind,
      id: update.id,
      enabled: update.enabled,
      payload: update.payload,
    };
    for (const [invalid, code] of [
      [duplicate, "duplicate_project_definition"],
      [
        { ...update, expectedEntryRevision: 99 },
        "conflicting_ownership_metadata",
      ],
    ] as const) {
      await expect(
        h.definitions.apply({
          projectId: "garden",
          mutation: invalid,
          expectedRevision: before.definitionRevision,
          actorId: "garden-owner",
        }),
      ).rejects.toMatchObject({ code });
    }
    expect((await h.definitions.read("garden")).revision).toBe(
      before.definitionRevision,
    );
    const preview = await h.definitions.preview("garden", update);
    expect(preview.issues).toEqual([]);
    await h.definitions.apply({
      projectId: "garden",
      mutation: update,
      expectedRevision: preview.current.revision,
      actorId: "garden-owner",
    });
    const after = await h.configuration.read("garden");
    expect(after.selectedPacks).toEqual([]);
    expect(after.definitionRevision).toBe(before.definitionRevision + 1);
    expect(after.configurationDigest).not.toBe(before.configurationDigest);
    expect(
      after.roles.find((role) => role.roleId === "project:roles/gardener"),
    ).toMatchObject({
      title: "Lead volunteer gardener",
      origin: "project_owned",
    });
    expect(after.workflows[0]?.stages[0]?.roleId).toBe(
      "project:roles/gardener",
    );
    expect(after.agents[0]?.roleId).toBe("project:roles/gardener");
    expect((await h.binding.read("garden")).packs).toEqual([]);
    expect(
      h.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pipeline_run",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("rejects forbidden authority and malformed custom workflow input without changing definitions", async () => {
    const h = await harness();
    const badMutations = [
      {
        code: "protected_security_invariant",
        mutation: {
          action: "put_owned",
          kind: "agents",
          id: "garden-helper",
          enabled: true,
          payload: {
            id: "garden-helper",
            role: "gardener",
            capabilities: ["write-equipment"],
          },
        },
      },
      {
        code: "conflicting_ownership_metadata",
        mutation: {
          action: "put_owned",
          kind: "workflows",
          id: "plot-care-flow",
          enabled: true,
          payload: {
            id: "plot-care-flow",
            taskType: "plot-care",
            stages: [
              { id: "observe", role: "gardener" },
              { id: "observe", role: "coordinator" },
            ],
          },
        },
      },
    ];
    for (const { mutation, code } of badMutations) {
      await expect(
        h.definitions.apply({
          projectId: "garden",
          mutation,
          expectedRevision: 0,
          actorId: "garden-owner",
        }),
      ).rejects.toMatchObject({ code });
      expect((await h.definitions.read("garden")).revision).toBe(0);
    }
    expect(
      (await h.configuration.read("garden")).projectOwnedDefinitions,
    ).toEqual([]);
    expect(
      h.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM audit_event WHERE event_type='project.definition_changed'",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("a dangling project workflow fails resolution until its owner removes it", async () => {
    const h = await harness();
    const dangling = {
      action: "put_owned",
      kind: "workflows",
      id: "plot-care-flow",
      enabled: true,
      payload: {
        id: "plot-care-flow",
        taskType: "missing-task-type",
        stages: [{ id: "observe", role: "missing-role" }],
      },
    };
    expect((await h.definitions.preview("garden", dangling)).issues).toEqual(
      [],
    );
    await h.definitions.apply({
      projectId: "garden",
      mutation: dangling,
      expectedRevision: 0,
      actorId: "garden-owner",
    });
    expect((await h.definitions.read("garden")).revision).toBe(1);
    await expect(h.configuration.read("garden")).rejects.toMatchObject({
      code: "missing_workflow_reference",
    });
    await h.definitions.apply({
      projectId: "garden",
      mutation: {
        action: "remove_owned",
        kind: "workflows",
        id: "plot-care-flow",
      },
      expectedRevision: 1,
      actorId: "garden-owner",
    });
    const recovered = await h.configuration.read("garden");
    expect(recovered.selectedPacks).toEqual([]);
    expect(recovered.projectOwnedDefinitions).toEqual([]);
  });
});

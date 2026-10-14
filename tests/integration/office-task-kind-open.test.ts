import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { GetOfficeContext } from "@ai-office/application/queries/get-office-context.ts";
import { OfficePipelineNotFoundError } from "@ai-office/application/errors.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const now = new Date("2026-10-11T00:00:00.000Z");

/**
 * A pipeline declaring "matter" and "civil-matter" alongside the usual
 * software kinds: proof that `defaultFor` no longer has to come from the
 * closed `officeTaskKinds` list (M16.5, open-string decision).
 */
function manifestWithOpenTaskKinds(): OfficeManifest {
  return {
    schemaVersion: 1,
    provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
    project: {
      mission: "Open task kind test",
      goals: ["Ship"],
      constraints: [],
      preferences: [],
      permissionPreferences: [],
    },
    office: {
      name: "Open office",
      roles: [
        {
          id: "intake-clerk",
          title: "Intake clerk",
          purpose: "Intake",
          responsibilities: ["Intake"],
        },
        {
          id: "developer",
          title: "Developer",
          purpose: "Build",
          responsibilities: ["Build"],
        },
      ],
    },
    pipelines: [
      {
        id: "matter-intake",
        name: "Matter intake",
        description: "Routes non-software task kinds",
        defaultFor: ["matter", "civil-matter"],
        stages: [
          {
            id: "intake",
            name: "Intake",
            roleId: "intake-clerk",
            objective: "Intake",
            checks: [],
            requiresApproval: false,
          },
        ],
      },
      {
        id: "delivery",
        name: "Delivery",
        description: "Routes the usual software kinds",
        defaultFor: ["feature"],
        stages: [
          {
            id: "build",
            name: "Build",
            roleId: "developer",
            objective: "Build",
            checks: [],
            requiresApproval: false,
          },
        ],
      },
    ],
  };
}

const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-open-task-kind-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const context = new GetOfficeContext(
    storage.projects,
    storage.profiles,
    storage.officeManifests,
  );
  return { storage, context };
}

describe("officeTaskKinds opens to manifest-declared task kinds (M16.5)", () => {
  test("the manifest schema accepts a pipeline's defaultFor naming a kind outside the shipped five", () => {
    const manifest = parseOfficeManifestJson(
      JSON.stringify(manifestWithOpenTaskKinds()),
    );
    expect(
      manifest.pipelines.flatMap((pipeline) => pipeline.defaultFor),
    ).toEqual(["matter", "civil-matter", "feature"]);
  });

  test("the schema still rejects a task kind that is not a lowercase kebab-case identifier", () => {
    const raw = JSON.parse(
      JSON.stringify(manifestWithOpenTaskKinds()),
    ) as Record<string, unknown>;
    const pipelines = raw.pipelines as Array<Record<string, unknown>>;
    pipelines[0]!.defaultFor = ["Civil_Matter"];

    expect(() => parseOfficeManifestJson(JSON.stringify(raw))).toThrow();
  });

  test("resolvePipeline routes a manifest-declared non-software kind to its pipeline", async () => {
    const h = await harness();
    const projectId = "open-kind-project";
    await h.storage.projects.save(
      Project.create({ id: projectId, name: projectId, now }),
    );
    await h.storage.officeManifests.save({
      id: `${projectId}-manifest`,
      projectId,
      revision: 1,
      manifest: manifestWithOpenTaskKinds(),
      appliedAt: now,
    });

    const matter = await h.context.resolvePipeline(projectId, "matter");
    expect(matter.id).toBe("matter-intake");

    const civilMatter = await h.context.resolvePipeline(
      projectId,
      "civil-matter",
    );
    expect(civilMatter.id).toBe("matter-intake");

    // The legacy software kinds keep routing exactly as before.
    const feature = await h.context.resolvePipeline(projectId, "feature");
    expect(feature.id).toBe("delivery");

    // A kind nothing declares still fails closed, not silently.
    await expect(
      h.context.resolvePipeline(projectId, "criminal-matter"),
    ).rejects.toThrow(OfficePipelineNotFoundError);
  });
});

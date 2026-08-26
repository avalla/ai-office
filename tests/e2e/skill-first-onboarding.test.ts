import { afterEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

const roots: string[] = [];

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("skill-first onboarding through the daemon", () => {
  test("preserves profile evidence while applying immutable office revisions without provider credentials", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-skill-first-"));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Skill-first project");
    writeFileSync(join(projectRoot, "index.ts"), "export const ready = true;");
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "skill-first", scripts: { test: "vitest" } }),
    );
    const draftDirectory = join(projectRoot, ".ai-office", "drafts");
    mkdirSync(draftDirectory, { recursive: true });
    const sourceTemplate = join(
      process.cwd(),
      ".agents",
      "skills",
      "ai-office",
      "assets",
      "default-office-manifest.json",
    );
    const manifestPath = join(draftDirectory, "office-manifest.json");
    const manifest = JSON.parse(readFileSync(sourceTemplate, "utf8")) as {
      project: { goals: string[]; mission: string };
    };
    manifest.project.goals = ["Approved office goal B"];
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const socketPath = join(projectRoot, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const imported = captureIo();
      expect(
        await runDaemonCli(["project:import", ".", "--json"], {
          projectRoot,
          socketPath,
          io: imported.io,
        }),
      ).toBe(0);
      const importResult = JSON.parse(imported.stdout[0]!) as {
        projectId: string;
        created: boolean;
        scan: { languages: string[] };
      };
      expect(importResult.created).toBe(true);
      expect(importResult.scan.languages).toContain("TypeScript");

      const beforeApplyDatabase = openDatabase(
        join(projectRoot, ".ai-office", "project.sqlite"),
      );
      const profileRowsBefore = beforeApplyDatabase
        .query<
          {
            id: string;
            category: string;
            key: string;
            value_json: string;
            origin: string;
          },
          []
        >(
          `SELECT id, category, key, value_json, origin
           FROM project_profile_entry ORDER BY id`,
        )
        .all();
      beforeApplyDatabase.close();

      const before = captureIo();
      expect(
        await runDaemonCli(
          ["office:context", "--project", importResult.projectId],
          { projectRoot, socketPath, io: before.io },
        ),
      ).toBe(0);
      const initialContext = JSON.parse(before.stdout[0]!) as {
        contractVersion: number;
        profileSemantics: string;
        currentOfficeSemantics: string;
        current: unknown;
      };
      expect(initialContext).toMatchObject({
        contractVersion: 1,
        profileSemantics: "evidence",
        currentOfficeSemantics: "approved_configuration",
        current: null,
      });

      const validation = captureIo();
      expect(
        await runDaemonCli(
          [
            "office:validate",
            "--file",
            ".ai-office/drafts/office-manifest.json",
          ],
          { projectRoot, socketPath, io: validation.io },
        ),
      ).toBe(0);
      expect(JSON.parse(validation.stdout[0]!)).toEqual({
        valid: true,
        schemaVersion: 1,
      });

      const applied = captureIo();
      expect(
        await runDaemonCli(
          [
            "office:apply",
            "--project",
            importResult.projectId,
            "--file",
            ".ai-office/drafts/office-manifest.json",
          ],
          { projectRoot, socketPath, io: applied.io },
        ),
      ).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({ revision: 1 });

      const pipeline = captureIo();
      expect(
        await runDaemonCli(
          [
            "office:pipeline",
            "--project",
            importResult.projectId,
            "--task-kind",
            "bugfix",
          ],
          { projectRoot, socketPath, io: pipeline.io },
        ),
      ).toBe(0);
      expect(JSON.parse(pipeline.stdout[0]!)).toMatchObject({ id: "bugfix" });

      manifest.project.mission = "Ship a provider-neutral onboarding flow";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const secondApply = captureIo();
      expect(
        await runDaemonCli(
          [
            "office:apply",
            "--project",
            importResult.projectId,
            "--file",
            ".ai-office/drafts/office-manifest.json",
          ],
          { projectRoot, socketPath, io: secondApply.io },
        ),
      ).toBe(0);
      expect(JSON.parse(secondApply.stdout[0]!)).toMatchObject({ revision: 2 });

      const contextOutput = captureIo();
      expect(
        await runDaemonCli(
          ["office:context", "--project", importResult.projectId],
          { projectRoot, socketPath, io: contextOutput.io },
        ),
      ).toBe(0);
      const context = JSON.parse(contextOutput.stdout[0]!) as {
        profileSemantics: string;
        currentOfficeSemantics: string;
        current: {
          revision: number;
          manifest: { project: { goals: string[] } };
        };
      };
      expect(context).toMatchObject({
        profileSemantics: "evidence",
        currentOfficeSemantics: "approved_configuration",
        current: { revision: 2 },
      });
      expect(context.current.manifest.project.goals).toEqual([
        "Approved office goal B",
      ]);

      const database = openDatabase(
        join(projectRoot, ".ai-office", "project.sqlite"),
      );
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM office_manifest_revision",
          )
          .get()?.count,
      ).toBe(2);
      expect(
        database
          .query<
            {
              id: string;
              category: string;
              key: string;
              value_json: string;
              origin: string;
            },
            []
          >(
            `SELECT id, category, key, value_json, origin
             FROM project_profile_entry ORDER BY id`,
          )
          .all(),
      ).toEqual(profileRowsBefore);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM capability_grants",
          )
          .get()!.count,
      ).toBe(0);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM audit_event WHERE event_type = 'office.manifest.applied'",
          )
          .get()?.count,
      ).toBe(2);
      expect(() =>
        database
          .prepare(
            "UPDATE office_manifest_revision SET revision = 3 WHERE revision = 2",
          )
          .run(),
      ).toThrow("office manifest revisions are immutable");
      const latest = database
        .query<{ id: string; manifest_json: string; applied_at: string }, []>(
          `SELECT id, manifest_json, applied_at
           FROM office_manifest_revision ORDER BY revision DESC LIMIT 1`,
        )
        .get()!;
      expect(() =>
        database
          .prepare(
            `INSERT INTO office_manifest_revision(
               id, project_id, revision, schema_version, manifest_json,
               source_host, source_skill, source_skill_version, applied_at
             ) VALUES (?, ?, 3, 1, ?, 'claude', 'ai-office', '1', ?)`,
          )
          .run(
            "mismatched-provenance",
            importResult.projectId,
            latest.manifest_json,
            latest.applied_at,
          ),
      ).toThrow();
      database.close();
    } finally {
      controller.abort();
      await running;
    }
  });

  test("rejects invalid manifests and files outside the runtime root", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-skill-invalid-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "ai-office-skill-outside-"));
    roots.push(projectRoot, outsideRoot);
    writeFileSync(join(outsideRoot, "manifest.json"), "{}");
    const socketPath = join(projectRoot, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const output = captureIo();
      expect(
        await runDaemonCli(
          ["office:validate", "--file", join(outsideRoot, "manifest.json")],
          { projectRoot, socketPath, io: output.io },
        ),
      ).toBe(1);
      expect(output.stderr).toEqual([
        "Office manifest file must be inside the project root",
      ]);
    } finally {
      controller.abort();
      await running;
    }
  });
});

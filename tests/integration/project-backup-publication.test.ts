import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../apps/cli/src/cli.ts";
import {
  LocalProjectArchiveAdapter,
  nodeProjectArchiveFileSystem,
} from "../../apps/cli/src/local-project-archive-adapter.ts";
import type { ProjectArchiveAdapter } from "@ai-office/application/ports/project-archive-adapter.port.ts";
import { PortableProjectArchiveError } from "@ai-office/application/project-portability/project-snapshot.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

const roots: string[] = [];

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
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

class FailOnceArchiveAdapter implements ProjectArchiveAdapter {
  attempts = 0;
  contents?: string;

  async read(): Promise<string> {
    throw new Error("not used");
  }

  async write(_path: string, contents: string): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1)
      throw new PortableProjectArchiveError(
        "Injected archive failure before publication",
      );
    this.contents = contents;
  }
}

class RecordingArchiveAdapter implements ProjectArchiveAdapter {
  writes = 0;

  async read(): Promise<string> {
    throw new Error("not used");
  }

  async write(): Promise<void> {
    this.writes += 1;
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("portable backup publication", () => {
  test("rejects non-portable profile state before head advancement or archive publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-sensitive-publication-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), '{"name":"sensitive"}\n');
    const imported = capture();
    expect(
      await runCli(["project:import", root, "--json"], {
        projectRoot: root,
        io: imported.io,
      }),
    ).toBe(0);
    const projectId = (JSON.parse(imported.stdout[0]!) as { projectId: string })
      .projectId;
    const databasePath = join(root, ".ai-office", "project.sqlite");
    const database = openDatabase(databasePath);
    database
      .prepare(
        `INSERT INTO project_profile_entry(
           id, project_id, category, key, value_json, origin, confidence,
           source_reference, confirmed_at, superseded_at, created_at
         ) VALUES ('credential-profile', ?, 'constraint', 'OPENAI_API_KEY',
                   '"sk-test"', 'user', 1, NULL, NULL, NULL, ?)`,
      )
      .run(projectId, new Date().toISOString());
    database.close();

    const adapter = new RecordingArchiveAdapter();
    const archivePath = join(root, "rejected.aioffice");
    const backup = capture();
    expect(
      await runCli(
        [
          "project:backup",
          "--project",
          projectId,
          "--output",
          archivePath,
        ],
        { projectRoot: root, io: backup.io, projectArchives: adapter },
      ),
    ).toBe(1);
    expect(backup.stderr[0]).toContain(
      "profile entry credential-profile is labelled as sensitive credential data (OPENAI_API_KEY)",
    );
    expect(adapter.writes).toBe(0);
    expect(existsSync(archivePath)).toBe(false);

    const after = openDatabase(databasePath);
    expect(
      after
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM project_state_revision WHERE project_id = ?",
        )
        .get(projectId)?.count,
    ).toBe(0);
    expect(
      after
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM project_state_head WHERE project_id = ?",
        )
        .get(projectId)?.count,
    ).toBe(0);
    after.close();
  });

  test("keeps a local state observation when publication fails and reuses it on retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-publication-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), '{"name":"publication"}\n');
    const imported = capture();
    expect(
      await runCli(["project:import", root, "--json"], {
        projectRoot: root,
        io: imported.io,
      }),
    ).toBe(0);
    const projectId = (JSON.parse(imported.stdout[0]!) as { projectId: string })
      .projectId;
    const adapter = new FailOnceArchiveAdapter();
    const archivePath = join(root, "backup.aioffice");

    const failed = capture();
    expect(
      await runCli(
        [
          "project:backup",
          "--project",
          projectId,
          "--output",
          archivePath,
          "--json",
        ],
        { projectRoot: root, io: failed.io, projectArchives: adapter },
      ),
    ).toBe(1);
    expect(failed.stderr).toEqual([
      "Injected archive failure before publication",
    ]);

    const databasePath = join(root, ".ai-office", "project.sqlite");
    let database = openDatabase(databasePath);
    const observation = database
      .query<{ revision_id: string; origin: string; count: number }, [string]>(
        `SELECT head.revision_id, revision.origin,
                (SELECT COUNT(*) FROM project_state_revision
                 WHERE project_id = head.project_id) AS count
         FROM project_state_head head
         JOIN project_state_revision revision
           ON revision.id = head.revision_id
          AND revision.project_id = head.project_id
         WHERE head.project_id = ?`,
      )
      .get(projectId)!;
    expect(observation).toMatchObject({ origin: "local_snapshot", count: 1 });
    database.close();

    const retried = capture();
    expect(
      await runCli(
        [
          "project:backup",
          "--project",
          projectId,
          "--output",
          archivePath,
          "--json",
        ],
        { projectRoot: root, io: retried.io, projectArchives: adapter },
      ),
    ).toBe(0);
    expect(adapter.attempts).toBe(2);
    expect(adapter.contents).toBeDefined();
    expect(
      (JSON.parse(retried.stdout[0]!) as { revisionId: string }).revisionId,
    ).toBe(observation.revision_id);

    for (const [name, projectArchives] of [
      [
        "temporary-write",
        new LocalProjectArchiveAdapter({
          ...nodeProjectArchiveFileSystem,
          write: () => {
            throw new Error("injected temporary write failure");
          },
        }),
      ],
      [
        "publication",
        new LocalProjectArchiveAdapter({
          ...nodeProjectArchiveFileSystem,
          link: () => {
            throw new Error("injected link failure");
          },
        }),
      ],
    ] as const) {
      const output = capture();
      expect(
        await runCli(
          [
            "project:backup",
            "--project",
            projectId,
            "--output",
            join(root, `${name}.aioffice`),
          ],
          { projectRoot: root, io: output.io, projectArchives },
        ),
      ).toBe(1);
      database = openDatabase(databasePath);
      expect(
        database
          .query<{ revision_id: string; count: number }, [string]>(
            `SELECT revision_id,
                    (SELECT COUNT(*) FROM project_state_revision
                     WHERE project_id = project_state_head.project_id) AS count
             FROM project_state_head WHERE project_id = ?`,
          )
          .get(projectId),
      ).toEqual({ revision_id: observation.revision_id, count: 1 });
      database.close();
    }

    const collisionPath = join(root, "collision.aioffice");
    writeFileSync(collisionPath, "user-owned\n");
    const collision = capture();
    expect(
      await runCli(
        ["project:backup", "--project", projectId, "--output", collisionPath],
        {
          projectRoot: root,
          io: collision.io,
          projectArchives: new LocalProjectArchiveAdapter(),
        },
      ),
    ).toBe(1);
    expect(collision.stderr[0]).toContain("Refusing to overwrite");
    expect(readFileSync(collisionPath, "utf8")).toBe("user-owned\n");
    database = openDatabase(databasePath);
    expect(
      database
        .query<{ revision_id: string }, [string]>(
          "SELECT revision_id FROM project_state_head WHERE project_id = ?",
        )
        .get(projectId)?.revision_id,
    ).toBe(observation.revision_id);
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM project_state_revision WHERE project_id = ?",
        )
        .get(projectId)?.count,
    ).toBe(1);
    database.close();
  });
});

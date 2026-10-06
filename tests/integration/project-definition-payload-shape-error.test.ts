import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectDefinitionPayloadShapeError } from "@ai-office/application/domain-pack/project-definition.ts";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import {
  ProjectStorageBootstrap,
  requireCompleteProjectStorage,
} from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import { executeRuntimeCommand } from "@ai-office/runtime-host/runtime-command.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * Only the PostgreSQL definition repository raises this error, and the
 * Runtime cannot host PostgreSQL storage yet. The definition port is therefore
 * stubbed on an injected authority: this proves the Runtime's rendering of
 * the error, not a provider path.
 */
describe("Runtime rendering of a non-object project definition payload", () => {
  test("names the row by key and points at the repair procedure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-payload-shape-"));
    roots.push(root);
    const handle = await new ProjectStorageBootstrap({
      sqliteDatabasePath: join(root, "project.sqlite"),
      environment: {},
    }).open({ requireComplete: true });
    const storage = requireCompleteProjectStorage(handle);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    };

    try {
      expect(
        await executeRuntimeCommand(["project:create", "shape", "--json"], {
          projectRoot: root,
          projectStorage: storage,
          io,
        }),
      ).toBe(0);
      const { projectId } = JSON.parse(stdout[0]!) as { projectId: string };
      const rowKey = `core.project_owned_definition (project_id=${projectId}, kind=roles, local_id=counsel)`;
      const refuse = (): Promise<never> =>
        Promise.reject(new ProjectDefinitionPayloadShapeError(rowKey));
      const refusing: ProjectStorage = {
        ...storage,
        definitions: { get: refuse, replace: refuse },
      };

      expect(
        await executeRuntimeCommand(
          ["project:definition:show", "--project", projectId, "--json"],
          { projectRoot: root, projectStorage: refusing, io },
        ),
      ).toBe(1);
      expect(stderr).toEqual([
        `Project definition payload must be a JSON object: ${rowKey}. Classify and repair the row with the query in supabase/README.md.`,
      ]);
    } finally {
      await handle.close();
    }
  });
});

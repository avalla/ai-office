import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";

const roots: string[] = [];

function output(): { io: CliIo; stdout: string[]; stderr: string[] } {
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

describe("daemon global memory", () => {
  test("creates, searches, adopts, lists, and deprecates memory through the socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-memory-daemon-"));
    roots.push(root);
    const socketPath = join(root, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath,
      globalDatabasePath: join(root, ".ai-office", "global.sqlite"),
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const createdProject = output();
      expect(
        await runDaemonCli(["project:create", "Memory project"], {
          projectRoot: root,
          socketPath,
          io: createdProject.io,
        }),
      ).toBe(0);
      const projectId =
        createdProject.stdout[0]?.replace("Project created: ", "") ?? "";

      const createdPattern = output();
      expect(
        await runDaemonCli(
          [
            "memory:pattern:create",
            "--id",
            "short-transactions",
            "--name",
            "Short transactions",
            "--version",
            "1",
            "--problem",
            "External calls inside transactions",
            "--context",
            "SQLite services",
            "--solution",
            "Persist intent before external work",
            "--source-project",
            projectId,
          ],
          { projectRoot: root, socketPath, io: createdPattern.io },
        ),
      ).toBe(0);
      expect(createdPattern.stdout).toEqual([
        "Global pattern saved: short-transactions",
      ]);

      const search = output();
      expect(
        await runDaemonCli(
          ["memory:search", "--query", "transactions", "--json"],
          { projectRoot: root, socketPath, io: search.io },
        ),
      ).toBe(0);
      expect(JSON.parse(search.stdout[0] ?? "{}") as unknown).toMatchObject({
        results: [{ type: "pattern", id: "short-transactions", version: 1 }],
      });

      for (let use = 0; use < 2; use += 1) {
        const adopted = output();
        expect(
          await runDaemonCli(
            [
              "memory:pattern:adopt",
              "--project",
              projectId,
              "--pattern",
              "short-transactions",
              "--version",
              "1",
            ],
            { projectRoot: root, socketPath, io: adopted.io },
          ),
        ).toBe(0);
      }

      const references = output();
      expect(
        await runDaemonCli(
          ["memory:references", "--project", projectId, "--json"],
          { projectRoot: root, socketPath, io: references.io },
        ),
      ).toBe(0);
      expect(JSON.parse(references.stdout[0] ?? "{}") as unknown).toMatchObject(
        {
          references: [
            {
              targetType: "pattern",
              targetId: "short-transactions",
              usageCount: 2,
            },
          ],
        },
      );

      const deprecated = output();
      expect(
        await runDaemonCli(
          [
            "memory:deprecate",
            "--type",
            "pattern",
            "--id",
            "short-transactions",
            "--version",
            "1",
          ],
          { projectRoot: root, socketPath, io: deprecated.io },
        ),
      ).toBe(0);
      const hidden = output();
      expect(
        await runDaemonCli(
          ["memory:search", "--query", "transactions", "--json"],
          { projectRoot: root, socketPath, io: hidden.io },
        ),
      ).toBe(0);
      expect(JSON.parse(hidden.stdout[0] ?? "{}") as unknown).toEqual({
        results: [],
      });
    } finally {
      controller.abort();
      await running;
    }
  });
});

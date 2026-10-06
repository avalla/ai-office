import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectDefinitionPayloadShapeError } from "@ai-office/application/domain-pack/project-definition.ts";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import { ProjectStorageBootstrap } from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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

/**
 * SQLite project storage whose definition port rejects with the typed error
 * once a row key is set. Only the PostgreSQL definition repository raises this
 * error, and the Runtime cannot host PostgreSQL storage yet, so the provider
 * path is out of reach; the daemon, the Unix socket and the CLI client are
 * real.
 */
function refusingProjectStorageBootstrap(root: string) {
  const delegate = new ProjectStorageBootstrap({
    sqliteDatabasePath: join(root, ".ai-office", "project.sqlite"),
    environment: {},
  });
  let refusedRowKey: string | null = null;
  const refuseOr = async <T>(read: () => Promise<T>): Promise<T> => {
    if (refusedRowKey !== null)
      throw new ProjectDefinitionPayloadShapeError(refusedRowKey);
    return read();
  };
  return {
    projectStorageBootstrap: {
      resolve: (configuration: Parameters<typeof delegate.resolve>[0]) =>
        delegate.resolve(configuration),
      open: async (options: Parameters<typeof delegate.open>[0]) => {
        const handle = await delegate.open(options);
        const definitions = handle.repositories.definitions;
        if (definitions === undefined)
          throw new Error("SQLite storage must provide a definition port");
        const refusing: ProjectStorage["definitions"] = {
          get: (...args) => refuseOr(() => definitions.get(...args)),
          replace: (...args) => refuseOr(() => definitions.replace(...args)),
        };
        return {
          ...handle,
          repositories: { ...handle.repositories, definitions: refusing },
        };
      },
    },
    refuse: (rowKey: string) => {
      refusedRowKey = rowKey;
    },
  };
}

describe("daemon rendering of a non-object project definition payload", () => {
  test("definition-reading commands fail over the socket with the row key and the repair procedure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-payload-shape-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const storage = refusingProjectStorageBootstrap(root);
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
      projectStorageBootstrap: storage.projectStorageBootstrap,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot: root,
        workingDirectory: root,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, stdout: output.stdout, stderr: output.stderr };
    };

    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "shape", "--json"]);
      expect(created.code).toBe(0);
      const { projectId } = JSON.parse(created.stdout[0]!) as {
        projectId: string;
      };
      expect(
        (await invoke(["project:definition:show", "--project", projectId]))
          .code,
      ).toBe(0);

      const rowKey = `core.project_owned_definition (project_id=${projectId}, kind=roles, local_id=counsel)`;
      storage.refuse(rowKey);

      for (const command of [
        "project:definition:show",
        "project:configuration:show",
      ]) {
        expect(
          await invoke([command, "--project", projectId, "--json"]),
        ).toEqual({
          code: 1,
          stdout: [],
          stderr: [
            `Project definition payload must be a JSON object: ${rowKey}. Classify the row with the query in supabase/README.md and repair it as that section describes.`,
          ],
        });
      }
    } finally {
      controller.abort();
      await running;
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import { ProjectStorageBootstrap } from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import { PostgresPipelineRunConfigurationPinUnsupportedError } from "@ai-office/storage-postgres/repositories/postgres-pipeline-run.repository.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { HookedPipelineRunRepository } from "../helpers/hooked-pipeline-run-repository.ts";
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

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Pin unsupported",
    goals: ["Ship"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Pin unsupported office",
    roles: [
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
      id: "delivery",
      name: "Delivery",
      description: "Pin unsupported delivery",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "build",
          name: "Build",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    },
  ],
};

/**
 * SQLite project storage whose run insert refuses with the PostgreSQL
 * repository's typed error once armed. The Runtime cannot host PostgreSQL
 * storage yet, so the provider path is out of reach; the daemon, the Unix
 * socket and the CLI client are real.
 */
function refusingProjectStorageBootstrap(root: string) {
  const delegate = new ProjectStorageBootstrap({
    sqliteDatabasePath: join(root, ".ai-office", "project.sqlite"),
    environment: {},
  });
  let armed = false;
  return {
    projectStorageBootstrap: {
      resolve: (configuration: Parameters<typeof delegate.resolve>[0]) =>
        delegate.resolve(configuration),
      open: async (options: Parameters<typeof delegate.open>[0]) => {
        const handle = await delegate.open(options);
        const pipelines = handle.repositories.pipelines;
        if (pipelines === undefined)
          throw new Error("SQLite storage must provide a pipeline run port");
        const refusing: ProjectStorage["pipelines"] =
          new HookedPipelineRunRepository(pipelines, {
            beforeInsert: async () => {
              if (armed)
                throw new PostgresPipelineRunConfigurationPinUnsupportedError(
                  "refused-run",
                  "bound_packs",
                );
            },
          });
        return {
          ...handle,
          repositories: { ...handle.repositories, pipelines: refusing },
        };
      },
    },
    arm: () => {
      armed = true;
    },
  };
}

describe("daemon rendering of an unsupported pipeline run configuration pin", () => {
  test("pipeline:start fails over the socket with an actionable message instead of an unexpected error", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pin-unsupported-"));
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
      const created = await invoke(["project:create", "pin", "--json"]);
      expect(created.code).toBe(0);
      const { projectId } = JSON.parse(created.stdout[0]!) as {
        projectId: string;
      };
      expect(
        (
          await invoke([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(manifest),
          ])
        ).code,
      ).toBe(0);
      const task = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Feature",
      ]);
      expect(task.code).toBe(0);
      const taskId = task.stdout[0]!.slice("Task created: ".length);

      storage.arm();
      expect(
        await invoke([
          "pipeline:start",
          "--project",
          projectId,
          "--task",
          taskId,
          "--pipeline",
          "delivery",
          "--actor",
          "operator",
        ]),
      ).toEqual({
        code: 1,
        stdout: [],
        stderr: [
          "PipelineRun refused-run belongs to a project with a pack binding, whose configuration pin this project storage does not yet support persisting. PostgreSQL project storage cannot store pipeline run configuration pins yet, so a project with bound packs cannot start a pipeline run there. Use SQLite project storage for this project, or unbind its packs with project:pack:apply --packs '[]' before starting the run.",
        ],
      });
    } finally {
      controller.abort();
      await running;
    }
  });
});

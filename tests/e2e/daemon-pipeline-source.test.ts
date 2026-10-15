import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
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

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Pack source",
    goals: ["Ship"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Pack source office",
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
      description: "Pack source delivery",
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

describe("daemon pipeline:start --source (M16.5 pack workflow selection)", () => {
  test("validates --source and keeps manifest-only projects on manifest pipelines over the socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pack-source-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
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
      const created = await invoke(["project:create", "source", "--json"]);
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
      const taskId = task.stdout[0]!.slice("Task created: ".length);
      const start = (...extra: string[]) =>
        invoke([
          "pipeline:start",
          "--project",
          projectId,
          "--task",
          taskId,
          "--pipeline",
          "delivery",
          "--actor",
          "operator",
          ...extra,
        ]);

      const invalid = await start("--source", "elsewhere");
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toEqual([]);
      expect(invalid.stderr.join("\n")).toContain(
        "--source must be manifest or pack",
      );

      // A project with no selected pack has no pack workflows to select.
      const pack = await start("--source", "pack");
      expect(pack.code).toBe(1);
      expect(pack.stdout).toEqual([]);

      const manifestRun = await start("--source", "manifest");
      expect(manifestRun.code).toBe(0);
      const run = JSON.parse(manifestRun.stdout[0]!) as {
        definition: { id: string };
        configurationPin?: unknown;
      };
      expect(run.definition.id).toBe("delivery");
      expect(run.configurationPin).toBeUndefined();
    } finally {
      controller.abort();
      await running;
    }
  });
});

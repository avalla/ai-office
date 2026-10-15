import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { computeArtifactDigest } from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
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
      expect(pack.stderr.join("\n")).toContain("delivery");

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

describe("daemon pipeline:start from a selected pack (M16.5)", () => {
  test("reports an ambiguous ID and a missing Runtime role with actionable messages over the socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pack-source-pack-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const bytes = readFileSync(
      new URL(
        "../../packages/domain-pack-legal/manifest.json",
        import.meta.url,
      ),
    );
    const pack = installedPacks.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "legal" },
    });
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
      installedPacks,
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
      const created = await invoke(["project:create", "selected", "--json"]);
      const { projectId } = JSON.parse(created.stdout[0]!) as {
        projectId: string;
      };
      const withMatter: OfficeManifest = {
        ...manifest,
        pipelines: [
          ...manifest.pipelines,
          {
            ...manifest.pipelines[0]!,
            id: "matter-workflow",
            defaultFor: ["maintenance"],
          },
        ],
      };
      expect(
        (
          await invoke([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(withMatter),
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([pack]),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).code,
      ).toBe(0);
      const task = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Matter",
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
          "matter-workflow",
          "--actor",
          "operator",
          ...extra,
        ]);

      const ambiguous = await start();
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stdout).toEqual([]);
      expect(ambiguous.stderr.join("\n")).toContain(
        "pass --source manifest or --source pack",
      );

      // The legal pack's stage roles do not exist in this Runtime project.
      const missing = await start("--source", "pack");
      expect(missing.code).toBe(1);
      expect(missing.stdout).toEqual([]);
      expect(missing.stderr.join("\n")).toContain(
        "needs Runtime roles that do not exist: intake-clerk, researcher, drafter, reviewer, approver",
      );
    } finally {
      controller.abort();
      await running;
    }
  });
});

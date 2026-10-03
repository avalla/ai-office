import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import {
  portableStateChecksum,
  serializePortableProjectArchive,
  sha256Canonical,
  type PortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
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

async function start(runtimeRoot: string, socketPath: string) {
  mkdirSync(runtimeRoot);
  const runtimePaths = resolveRuntimePaths({
    mode: "user",
    runtimeHome: runtimeRoot,
  });
  const daemon = await bootstrap({ runtimePaths, socketPath });
  const controller = new AbortController();
  const running = daemon.start(controller.signal);
  await waitForDaemon(socketPath);
  return { runtimePaths, controller, running };
}

async function command(input: {
  runtimePaths: ReturnType<typeof resolveRuntimePaths>;
  socketPath: string;
  workingDirectory: string;
  args: string[];
}) {
  const output = capture();
  const exitCode = await runDaemonCli(input.args, {
    runtimePaths: input.runtimePaths,
    socketPath: input.socketPath,
    workingDirectory: input.workingDirectory,
    io: output.io,
  });
  return { ...output, exitCode };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("portable project CLI", () => {
  test("rejects a checksummed format-6 archive with invalid definition Unicode before restore", async () => {
    const workspace = temporaryRoot("ai-office-portability-unicode-");
    const projectA = join(workspace, "source");
    const projectB = join(workspace, "destination");
    mkdirSync(projectA);
    mkdirSync(projectB);
    writeFileSync(join(projectA, "package.json"), '{"name":"source"}\n');
    writeFileSync(join(projectB, "package.json"), '{"name":"destination"}\n');
    const archivePath = join(workspace, "project.aioffice");

    const sourceSocket = createTestUnixSocket();
    roots.push(sourceSocket.root);
    const source = await start(
      join(workspace, "source-runtime"),
      sourceSocket.socketPath,
    );
    try {
      const installed = await command({
        runtimePaths: source.runtimePaths,
        socketPath: sourceSocket.socketPath,
        workingDirectory: projectA,
        args: ["install", ".", "--json"],
      });
      expect([0, 2]).toContain(installed.exitCode);
      const projectId = (
        JSON.parse(installed.stdout[0]!) as {
          project: { id: string };
        }
      ).project.id;
      const applied = await command({
        runtimePaths: source.runtimePaths,
        socketPath: sourceSocket.socketPath,
        workingDirectory: projectA,
        args: [
          "project:definition:apply",
          "--project",
          projectId,
          "--mutation",
          JSON.stringify({
            action: "put_owned",
            kind: "roles",
            id: "custom",
            enabled: true,
            payload: { id: "custom", title: "Valid" },
          }),
          "--expected-revision",
          "0",
          "--json",
        ],
      });
      expect(applied.exitCode).toBe(0);
      expect(
        (
          await command({
            runtimePaths: source.runtimePaths,
            socketPath: sourceSocket.socketPath,
            workingDirectory: projectA,
            args: ["project:backup", "--output", archivePath, "--json"],
          })
        ).exitCode,
      ).toBe(0);
    } finally {
      source.controller.abort();
      await source.running;
    }

    const archive = JSON.parse(
      readFileSync(archivePath, "utf8"),
    ) as PortableProjectArchive;
    expect(archive.manifest.formatVersion).toBe(6);
    const definitions = archive.state.definitions!;
    expect(definitions.owned).toHaveLength(1);
    const state = {
      ...archive.state,
      definitions: {
        ...definitions,
        owned: definitions.owned.map((entry) => ({
          ...entry,
          payload: { ...entry.payload, title: "\ud800" },
        })),
      },
    };
    const manifest = {
      ...archive.manifest,
      revision: {
        ...archive.manifest.revision,
        stateChecksum: portableStateChecksum(state),
      },
    };
    const forged = {
      manifest,
      state,
      integrity: {
        algorithm: "sha256" as const,
        checksum: sha256Canonical({ manifest, state }),
      },
    };
    const serialized = serializePortableProjectArchive(forged);
    expect(serialized).toContain("\\ud800");
    writeFileSync(archivePath, serialized);

    const destinationSocket = createTestUnixSocket();
    roots.push(destinationSocket.root);
    const destination = await start(
      join(workspace, "destination-runtime"),
      destinationSocket.socketPath,
    );
    const counts = () => {
      const database = new Database(
        destination.runtimePaths.projectDatabasePath,
        {
          readonly: true,
        },
      );
      try {
        return [
          "project",
          "project_definition_head",
          "project_owned_definition",
          "project_definition_override",
          "project_pack_binding",
        ].map(
          (table) =>
            database
              .query<{ count: number }, []>(
                `SELECT count(*) AS count FROM ${table}`,
              )
              .get()!.count,
        );
      } finally {
        database.close();
      }
    };
    try {
      const before = counts();
      expect(before).toEqual([0, 0, 0, 0, 0]);
      const restored = await command({
        runtimePaths: destination.runtimePaths,
        socketPath: destinationSocket.socketPath,
        workingDirectory: projectB,
        args: ["project:restore", archivePath, "--json"],
      });
      expect(restored.exitCode).toBe(1);
      expect(restored.stdout).toEqual([]);
      expect(restored.stderr.join("\n")).toContain("Portable project archive");
      expect(restored.stderr.join("\n")).not.toMatch(
        /\\ud800|JCS|Zod|SQLITE|SELECT |\.ts:|\bat .+:\d+:\d+/u,
      );
      expect(counts()).toEqual(before);
      expect(existsSync(join(projectB, ".ai-office", "project.json"))).toBe(
        false,
      );
    } finally {
      destination.controller.abort();
      await destination.running;
    }
  });

  test("moves project state between separate runtimes and checkout paths", async () => {
    const workspace = temporaryRoot("ai-office-portability-e2e-");
    const projectA = join(workspace, "machine-a", "src", "project");
    const projectB = join(workspace, "machine-b", "work", "project");
    const runtimeA = join(workspace, "machine-a", "runtime");
    const runtimeB = join(workspace, "machine-b", "runtime");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectA, "package.json"), '{"name":"portable"}\n');
    writeFileSync(join(projectB, "package.json"), '{"name":"portable"}\n');
    const archivePath = join(workspace, "portable.aioffice");

    const socketA = createTestUnixSocket();
    roots.push(socketA.root);
    const a = await start(runtimeA, socketA.socketPath);
    const installed = await command({
      runtimePaths: a.runtimePaths,
      socketPath: socketA.socketPath,
      workingDirectory: projectA,
      args: ["install", ".", "--json"],
    });
    const installedProject = JSON.parse(installed.stdout[0]!) as {
      project: { id: string; repositoryId: string };
    };
    expect([0, 2]).toContain(installed.exitCode);
    expect(
      (
        await command({
          runtimePaths: a.runtimePaths,
          socketPath: socketA.socketPath,
          workingDirectory: projectA,
          args: ["task:create", "--title", "Keep this task", "--priority", "9"],
        })
      ).exitCode,
    ).toBe(0);
    const backedUp = await command({
      runtimePaths: a.runtimePaths,
      socketPath: socketA.socketPath,
      workingDirectory: projectA,
      args: ["project:backup", "--output", archivePath, "--json"],
    });
    expect(backedUp.exitCode).toBe(0);
    expect(JSON.parse(backedUp.stdout[0]!)).toMatchObject({
      projectIdentity: installedProject.project.repositoryId,
      outputPath: archivePath,
    });
    mkdirSync(join(projectB, ".ai-office"));
    copyFileSync(
      join(projectA, ".ai-office", "project.json"),
      join(projectB, ".ai-office", "project.json"),
    );
    a.controller.abort();
    await a.running;

    const socketB = createTestUnixSocket();
    roots.push(socketB.root);
    const b = await start(runtimeB, socketB.socketPath);
    const restored = await command({
      runtimePaths: b.runtimePaths,
      socketPath: socketB.socketPath,
      workingDirectory: projectB,
      args: ["project:restore", archivePath, "--json"],
    });
    expect(restored.exitCode).toBe(0);
    const restoredProject = JSON.parse(restored.stdout[0]!) as {
      projectId: string;
      projectIdentity: string;
      rootPath: string;
    };
    expect(restoredProject).toMatchObject({
      projectIdentity: installedProject.project.repositoryId,
      rootPath: realpathSync(projectB),
    });
    expect(restoredProject.projectId).not.toBe(installedProject.project.id);

    const status = await command({
      runtimePaths: b.runtimePaths,
      socketPath: socketB.socketPath,
      workingDirectory: projectB,
      args: ["status", "--json"],
    });
    expect(JSON.parse(status.stdout[0]!)).toMatchObject({
      installed: true,
      project: {
        id: restoredProject.projectId,
        root: realpathSync(projectB),
        repositoryIdentity: {
          id: installedProject.project.repositoryId,
          state: "valid",
        },
        stateRevision: {
          head: expect.any(String),
          base: expect.any(String),
        },
      },
      tasks: { open: 1 },
    });
    const tasks = await command({
      runtimePaths: b.runtimePaths,
      socketPath: socketB.socketPath,
      workingDirectory: projectB,
      args: ["task:list"],
    });
    expect(tasks.stdout.join("\n")).toContain("Keep this task");
    b.controller.abort();
    await b.running;
  });
});

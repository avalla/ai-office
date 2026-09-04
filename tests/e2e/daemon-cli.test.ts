import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli, runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import {
  DaemonClient,
  RuntimeUnavailableError,
} from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import type { RuntimeClient } from "@ai-office/application/runtime/runtime-client.port.ts";

const temporaryDirectories: string[] = [];

function captureIo(answers: string[] = []): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
  prompts: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async (message) => {
        prompts.push(message);
        return answers.shift() ?? "";
      },
    },
    stdout,
    stderr,
    prompts,
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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI to daemon end-to-end", () => {
  test("runs persisted project commands through the socket", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-daemon-cli-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Existing project");
    writeFileSync(join(projectRoot, "index.ts"), "export const value = 1;");
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({
        name: "existing",
        devDependencies: { vitest: "latest" },
      }),
    );
    const socketPath = join(projectRoot, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({
      projectRoot,
      socketPath,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const healthOutput = captureIo();
      expect(
        await runDaemonCli(["daemon:health"], {
          projectRoot,
          socketPath,
          io: healthOutput.io,
        }),
      ).toBe(0);
      expect(healthOutput.stdout[0]).toBe("Daemon status: ok");

      const runtimeHealthOutput = captureIo();
      expect(
        await runRuntimeCli(["runtime", "status"], {
          projectRoot,
          socketPath,
          io: runtimeHealthOutput.io,
        }),
      ).toBe(0);
      expect(runtimeHealthOutput.stdout[0]).toBe("Runtime status: ok");

      const importOutput = captureIo();
      expect(
        await runDaemonCli(["project:import", "."], {
          projectRoot,
          socketPath,
          io: importOutput.io,
        }),
      ).toBe(0);
      const projectId =
        importOutput.stdout[0]?.replace("Project imported: ", "") ?? "";

      const profileOutput = captureIo();
      expect(
        await runDaemonCli(["project:profile", "--project", projectId], {
          projectRoot,
          socketPath,
          io: profileOutput.io,
        }),
      ).toBe(0);
      expect(profileOutput.stdout[0]).toContain("TypeScript");
      expect(profileOutput.stderr).toEqual([]);
    } finally {
      controller.abort();
      await running;
    }
  });

  test("records a historical task completion through the socket", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-daemon-task-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Board");
    const socketPath = join(projectRoot, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    async function run(args: string[]): Promise<string[]> {
      const output = captureIo();
      const code = await runDaemonCli(args, {
        projectRoot,
        socketPath,
        io: output.io,
      });
      expect({ args, code, stderr: output.stderr }).toMatchObject({
        args,
        code: 0,
      });
      return output.stdout;
    }

    try {
      await waitForDaemon(socketPath);
      const projectId = (await run(["project:create", "Board"]))[0]!.replace(
        "Project created: ",
        "",
      );
      const taskId = (
        await run([
          "task:create",
          "--project",
          projectId,
          "--title",
          "AUC-03",
        ])
      )[0]!.replace("Task created: ", "");

      // Preflight and correction both cross the Unix socket; the plan hash the
      // operator approves is the one the daemon produced.
      const preview = (
        await run([
          "task:record-completion",
          "--project",
          projectId,
          "--task",
          taskId,
          "--reason",
          "shipped before this board existed",
        ])
      ).join("\n");
      expect(preview).toContain(
        "operation: historical correction, not a lifecycle transition",
      );
      const planHash = preview.match(/--approve ([0-9a-f]{64})/u)?.[1];
      expect(planHash).toBeDefined();

      expect(
        (
          await run([
            "task:record-completion",
            "--project",
            projectId,
            "--task",
            taskId,
            "--reason",
            "shipped before this board existed",
            "--approve",
            planHash!,
          ])
        )[0],
      ).toBe(
        `Recorded completion of task ${taskId}: pending -> completed (historical correction)`,
      );
      expect((await run(["task:list", "--project", projectId]))[1]).toContain(
        "completed",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("returns a typed actionable error when the daemon is unavailable", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-no-daemon-"));
    temporaryDirectories.push(projectRoot);
    const output = captureIo();

    expect(
      await runDaemonCli(["project:create", "Demo"], {
        projectRoot,
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr[0]).toContain('"ai-office runtime start"');

    const helpOutput = captureIo();
    expect(
      await runDaemonCli(["--help"], { projectRoot, io: helpOutput.io }),
    ).toBe(0);
    expect(helpOutput.stdout[0]).toContain("daemon:health");
    expect(helpOutput.stderr).toEqual([]);
  });

  test("never falls back to a local writer when the Runtime is unavailable", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-no-fallback-"));
    temporaryDirectories.push(projectRoot);
    const runtimeHome = join(projectRoot, "runtime");
    mkdirSync(runtimeHome);
    const runtimePaths = resolveRuntimePaths({
      mode: "user",
      runtimeHome,
    });
    let executeAttempts = 0;
    const unavailableRuntime: RuntimeClient = {
      health: async () => {
        throw new RuntimeUnavailableError(runtimePaths.socketPath);
      },
      execute: async () => {
        executeAttempts += 1;
        throw new RuntimeUnavailableError(runtimePaths.socketPath);
      },
    };
    const output = captureIo();

    expect(
      await runRuntimeCli(["project:create", "No local writer"], {
        projectRoot,
        runtimePaths,
        runtimeClient: unavailableRuntime,
        io: output.io,
      }),
    ).toBe(1);
    expect(executeAttempts).toBe(1);
    expect(existsSync(runtimePaths.projectDatabasePath)).toBe(false);
    expect(output.stderr).toEqual([
      expect.stringContaining("AI Office Runtime is not available"),
    ]);
  });

  test("supports explicit offline status without contacting the Runtime", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-offline-status-"),
    );
    temporaryDirectories.push(projectRoot);
    const runtimeHome = join(projectRoot, "runtime");
    mkdirSync(runtimeHome);
    mkdirSync(join(projectRoot, ".ai-office"));
    writeFileSync(
      join(projectRoot, ".ai-office", "project.json"),
      JSON.stringify({
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: "repo_offline-status-test",
      }),
    );
    const runtimePaths = resolveRuntimePaths({
      mode: "user",
      runtimeHome,
    });
    let contacted = false;
    const runtimeClient: RuntimeClient = {
      health: async () => {
        contacted = true;
        throw new Error("unexpected health request");
      },
      execute: async () => {
        contacted = true;
        throw new Error("unexpected command request");
      },
    };
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--offline", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient,
        io: output.io,
      }),
    ).toBe(0);
    expect(contacted).toBe(false);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      runtime: {
        daemon: "unreachable",
        authoritativeState: "unavailable",
      },
      project: {
        repositoryIdentity: { state: "valid" },
        runtimeAssociation: { state: "unverified" },
      },
    });
    expect(existsSync(runtimePaths.projectDatabasePath)).toBe(false);
  });
});

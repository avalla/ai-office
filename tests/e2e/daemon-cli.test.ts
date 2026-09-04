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

function installedRepository(prefix: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(projectRoot);
  mkdirSync(join(projectRoot, "runtime"));
  mkdirSync(join(projectRoot, ".ai-office"));
  writeFileSync(
    join(projectRoot, ".ai-office", "project.json"),
    JSON.stringify({
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: "repo_offline-status-test",
    }),
  );
  return projectRoot;
}

function offlineRuntimePaths(projectRoot: string) {
  const runtimeHome = join(projectRoot, "runtime");
  if (!existsSync(runtimeHome)) mkdirSync(runtimeHome);
  return resolveRuntimePaths({ mode: "user", runtimeHome });
}

/**
 * A Runtime client that counts every crossing of the client boundary, so a
 * test can prove an offline path made no request at all rather than only
 * checking what the request returned.
 */
function rejectingRuntimeClient(failure?: () => Error): {
  client: RuntimeClient;
  readonly healthCalls: number;
  readonly executeCalls: number;
} {
  let healthCalls = 0;
  let executeCalls = 0;
  const fail = failure ?? (() => new Error("unexpected Runtime request"));
  return {
    client: {
      health: async () => {
        healthCalls += 1;
        throw fail();
      },
      execute: async () => {
        executeCalls += 1;
        throw fail();
      },
    },
    get healthCalls() {
      return healthCalls;
    },
    get executeCalls() {
      return executeCalls;
    },
  };
}

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
        await run(["task:create", "--project", projectId, "--title", "AUC-03"])
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

  test("explicit offline status never contacts the Runtime and never claims it is unreachable", async () => {
    const projectRoot = installedRepository("ai-office-offline-status-");
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient();
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--offline", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(0);

    expect(runtime.healthCalls).toBe(0);
    expect(runtime.executeCalls).toBe(0);
    const status = JSON.parse(output.stdout[0]!) as {
      schemaVersion: number;
      health: string;
      runtime: { daemon: string; authoritativeState: string };
      project: {
        repositoryIdentity: { state: string };
        runtimeAssociation: { state: string };
      };
      issues: { code: string; severity: string; recovery?: string }[];
    };

    expect(status.schemaVersion).toBe(4);
    expect(status.runtime.daemon).toBe("not_checked");
    expect(status.runtime.authoritativeState).toBe("not_checked");
    expect(status.health).toBe("unverified");
    expect(status.project).toMatchObject({
      repositoryIdentity: { state: "valid" },
      runtimeAssociation: { state: "unverified" },
    });
    expect(status.issues.map((issue) => issue.code)).not.toContain(
      "daemon_unavailable",
    );
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        code: "runtime_not_checked",
        severity: "warning",
      }),
    );
    expect(
      status.issues.some((issue) =>
        (issue.recovery ?? "").includes("runtime start"),
      ),
    ).toBe(false);
    expect(existsSync(runtimePaths.projectDatabasePath)).toBe(false);
  });

  test("explicit offline status renders host state as not checked", async () => {
    const projectRoot = installedRepository("ai-office-offline-render-");
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient();
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", "--offline"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(0);

    expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
    expect(output.stdout).toContain("  persistent host: not_checked");
    expect(output.stdout).toContain("  state: not_checked");
    expect(output.stdout).toContain("Status: unverified");
    expect(output.stdout.join("\n")).not.toContain("ai-office runtime start");
  });

  test("a failed Runtime connection still reports the host as unreachable", async () => {
    const projectRoot = installedRepository("ai-office-offline-degraded-");
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient(
      () => new RuntimeUnavailableError(runtimePaths.socketPath),
    );
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(1);

    expect(runtime.executeCalls).toBeGreaterThan(0);
    const status = JSON.parse(output.stdout[0]!) as {
      health: string;
      runtime: { daemon: string; authoritativeState: string };
      issues: { code: string; recovery?: string }[];
    };
    expect(status.runtime.daemon).toBe("unreachable");
    expect(status.runtime.authoritativeState).toBe("unavailable");
    expect(status.health).toBe("needs_attention");
    expect(status.issues.map((issue) => issue.code)).toContain(
      "daemon_unavailable",
    );
    expect(
      status.issues.some((issue) =>
        (issue.recovery ?? "").includes("runtime start"),
      ),
    ).toBe(true);
  });

  test("rejects malformed explicit offline invocations before contacting the Runtime", async () => {
    const projectRoot = installedRepository("ai-office-offline-usage-");
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const invocations: [string[], string][] = [
      [["status", "--offline", "--unknown"], "Unknown option --unknown"],
      [
        ["status", "--offline", "--offline"],
        "Flag --offline can only be provided once",
      ],
      [
        ["status", "--offline", "--json", "--json"],
        "Flag --json can only be provided once",
      ],
      [
        ["status", ".", "..", "--offline"],
        "status accepts at most one project path",
      ],
      [["status", "--offline", "--project"], "Unknown option --project"],
    ];

    for (const [args, message] of invocations) {
      const runtime = rejectingRuntimeClient();
      const output = captureIo();

      expect(
        await runRuntimeCli(args, {
          projectRoot,
          workingDirectory: projectRoot,
          runtimePaths,
          runtimeClient: runtime.client,
          io: output.io,
        }),
      ).toBe(1);
      expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([message]);
    }
  });

  test("explicit offline status reports an uninstalled repository without blaming the Runtime", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-offline-none-"));
    temporaryDirectories.push(projectRoot);
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient();
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--offline", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(1);

    expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
    const status = JSON.parse(output.stdout[0]!) as {
      health: string;
      runtime: { daemon: string };
      issues: { code: string }[];
    };
    expect(status.health).toBe("not_installed");
    expect(status.runtime.daemon).toBe("not_checked");
    expect(status.issues.map((issue) => issue.code)).toEqual(["not_installed"]);
  });
});

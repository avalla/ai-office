import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";

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
    expect(output.stderr[0]).toContain('Start it with "bun run daemon"');

    const helpOutput = captureIo();
    expect(
      await runDaemonCli(["--help"], { projectRoot, io: helpOutput.io }),
    ).toBe(0);
    expect(helpOutput.stdout[0]).toContain("daemon:health");
    expect(helpOutput.stderr).toEqual([]);
  });
});

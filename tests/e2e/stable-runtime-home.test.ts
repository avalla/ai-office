import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("stable user runtime home", () => {
  test("preserves project authority when the distribution root changes", async () => {
    const workspace = temporaryRoot("ai-office-stable-runtime-");
    const runtimeHome = join(workspace, "runtime");
    const repository = join(workspace, "repository");
    const distributionA = join(workspace, "distribution-a");
    const distributionB = join(workspace, "distribution-b");
    const binRoot = join(workspace, "empty-bin");
    mkdirSync(runtimeHome);
    mkdirSync(repository);
    mkdirSync(distributionA);
    mkdirSync(distributionB);
    mkdirSync(binRoot);
    writeFileSync(join(repository, "package.json"), '{"name":"stable"}\n');
    const clients = new DefaultAgentClientCatalog({ pathValue: binRoot });
    const paths = resolveRuntimePaths({ mode: "user", runtimeHome });
    const socketRoot = temporaryRoot("ao-stable-socket-");
    const socketPath = join(socketRoot, "daemon.sock");

    const firstDaemon = await bootstrap({
      runtimePaths: paths,
      projectRoot: distributionA,
      socketPath,
      agentClients: clients,
    });
    const firstController = new AbortController();
    const firstRunning = firstDaemon.start(firstController.signal);
    await waitForDaemon(socketPath);
    const installOutput = captureIo();
    expect(
      await runDaemonCli(["install", ".", "--json"], {
        runtimePaths: paths,
        socketPath,
        workingDirectory: repository,
        agentClients: clients,
        io: installOutput.io,
      }),
    ).toBe(2);
    const projectId = (
      JSON.parse(installOutput.stdout[0]!) as { project: { id: string } }
    ).project.id;
    firstController.abort();
    await firstRunning;

    const secondDaemon = await bootstrap({
      runtimePaths: paths,
      projectRoot: distributionB,
      socketPath,
      agentClients: clients,
    });
    const secondController = new AbortController();
    const secondRunning = secondDaemon.start(secondController.signal);
    try {
      await waitForDaemon(socketPath);
      const statusOutput = captureIo();
      expect(
        await runDaemonCli(["status", "--json"], {
          runtimePaths: paths,
          socketPath,
          workingDirectory: repository,
          agentClients: clients,
          io: statusOutput.io,
        }),
      ).toBe(1);
      expect(JSON.parse(statusOutput.stdout[0]!)).toMatchObject({
        installed: true,
        project: { id: projectId },
        runtime: { home: paths.runtimeHome, authoritativeState: "available" },
        issues: [
          expect.objectContaining({ code: "no_supported_client_detected" }),
        ],
      });
    } finally {
      secondController.abort();
      await secondRunning;
    }
  });
});

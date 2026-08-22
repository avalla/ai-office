import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { projectInstructionContractValue } from "../helpers/project-instruction-contract.ts";

const roots: string[] = [];

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

describe("daemon-backed agent client integration", () => {
  test("plans, requires the exact approval hash, applies, and validates Claude", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-client-daemon-"));
    roots.push(root);
    writeFileSync(
      join(root, "agent-contract.json"),
      JSON.stringify(projectInstructionContractValue),
    );
    const socketPath = join(root, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot: root, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    const run = async (args: string[]) => {
      const output = captureIo();
      const exitCode = await runDaemonCli(args, {
        projectRoot: root,
        socketPath,
        io: output.io,
      });
      return { ...output, exitCode };
    };

    try {
      await waitForDaemon(socketPath);
      const inspected = await run([
        "client:inspect",
        "--client",
        "claude",
        "--root",
        root,
      ]);
      expect(inspected.exitCode).toBe(0);
      expect(JSON.parse(inspected.stdout[0]!)).toMatchObject({
        clientId: "claude",
        canonicalInstructions: { integrationStatus: "missing" },
      });
      expect(() => readFileSync(join(root, "AGENTS.md"), "utf8")).toThrow();
      const invalid = await run([
        "client:validate",
        "--client",
        "claude",
        "--root",
        root,
      ]);
      expect(invalid.exitCode).toBe(1);
      expect(JSON.parse(invalid.stdout[0]!)).toMatchObject({ valid: false });

      const planned = await run([
        "client:plan",
        "--client",
        "claude",
        "--root",
        root,
        "--contract",
        "agent-contract.json",
      ]);
      const plan = JSON.parse(planned.stdout[0]!) as {
        planHash: string;
        changes: Array<{ relativePath: string }>;
      };
      expect(plan.changes.map((change) => change.relativePath)).toEqual([
        "AGENTS.md",
        "CLAUDE.md",
      ]);

      const rejected = await run([
        "client:apply",
        "--client",
        "claude",
        "--root",
        root,
        "--contract",
        "agent-contract.json",
        "--approve",
        "0".repeat(64),
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toEqual([
        "Agent client integration approval does not match the current plan",
      ]);

      const applied = await run([
        "client:apply",
        "--client",
        "claude",
        "--root",
        root,
        "--contract",
        "agent-contract.json",
        "--approve",
        plan.planHash,
      ]);
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
        applied: true,
        validation: { valid: true },
      });
      expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain(
        "@AGENTS.md",
      );
      expect(
        (await run(["client:validate", "--client", "claude", "--root", root]))
          .exitCode,
      ).toBe(0);

      const uninstallPlanned = await run([
        "client:uninstall",
        "--client",
        "claude",
        "--root",
        root,
      ]);
      const uninstallPlan = JSON.parse(uninstallPlanned.stdout[0]!) as {
        planHash: string;
        action: string;
        changes: Array<{ kind: string; relativePath: string }>;
      };
      expect(uninstallPlan).toMatchObject({
        action: "uninstall",
        changes: [{ kind: "delete", relativePath: "CLAUDE.md" }],
      });
      const uninstalled = await run([
        "client:uninstall",
        "--client",
        "claude",
        "--root",
        root,
        "--approve",
        uninstallPlan.planHash,
      ]);
      expect(uninstalled.exitCode).toBe(0);
      expect(JSON.parse(uninstalled.stdout[0]!)).toMatchObject({
        uninstalled: true,
        inspection: {
          clientInstructions: { integrationStatus: "missing" },
          canonicalInstructions: { integrationStatus: "integrated" },
        },
      });
      expect(() => readFileSync(join(root, "CLAUDE.md"), "utf8")).toThrow();
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
        "ai-office:managed",
      );
    } finally {
      controller.abort();
      await running;
    }
  });
});

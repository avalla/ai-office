import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { LocalProjectBindingAdapter } from "../../apps/cli/src/local-project-binding-adapter.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";

interface RunningHarness {
  workspace: string;
  runtimeRoot: string;
  projectRoot: string;
  binRoot: string;
  socketRoot: string;
  socketPath: string;
  clients: DefaultAgentClientCatalog;
  controller: AbortController;
  running: Promise<void>;
}

const harnesses: RunningHarness[] = [];

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

function addExecutable(binRoot: string, name: "codex" | "claude"): void {
  const path = join(binRoot, name);
  writeFileSync(path, "#!/bin/sh\nexit 99\n");
  chmodSync(path, 0o755);
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

async function startHarness(
  detected: readonly ("codex" | "claude")[] = [],
): Promise<RunningHarness> {
  const workspace = mkdtempSync(join(tmpdir(), "ai-office-lifecycle-"));
  const runtimeRoot = join(workspace, "runtime");
  const projectRoot = join(workspace, "project");
  const binRoot = join(workspace, "bin");
  mkdirSync(runtimeRoot);
  mkdirSync(projectRoot);
  mkdirSync(binRoot);
  writeFileSync(
    join(projectRoot, "package.json"),
    JSON.stringify({ name: "fixture", devDependencies: { vitest: "1.0.0" } }),
  );
  writeFileSync(join(projectRoot, "index.ts"), "export const value = 1;\n");
  for (const client of detected) addExecutable(binRoot, client);

  const clients = new DefaultAgentClientCatalog({ pathValue: binRoot });
  const socketRoot = mkdtempSync("/tmp/ao-life-sock-");
  const socketPath = join(socketRoot, "daemon.sock");
  const daemon = await bootstrap({
    projectRoot: runtimeRoot,
    socketPath,
    agentClients: clients,
  });
  const controller = new AbortController();
  const running = daemon.start(controller.signal);
  const harness = {
    workspace,
    runtimeRoot,
    projectRoot,
    binRoot,
    socketRoot,
    socketPath,
    clients,
    controller,
    running,
  };
  harnesses.push(harness);
  await waitForDaemon(socketPath);
  return harness;
}

async function run(
  harness: RunningHarness,
  args: string[],
  workingDirectory = harness.projectRoot,
) {
  const output = captureIo();
  const exitCode = await runDaemonCli(args, {
    projectRoot: harness.runtimeRoot,
    workingDirectory,
    socketPath: harness.socketPath,
    agentClients: harness.clients,
    io: output.io,
  });
  return { ...output, exitCode };
}

afterEach(async () => {
  const current = harnesses.splice(0);
  for (const harness of current) harness.controller.abort();
  await Promise.allSettled(current.map((harness) => harness.running));
  for (const harness of current)
    rmSync(harness.workspace, { recursive: true, force: true });
  for (const harness of current)
    rmSync(harness.socketRoot, { recursive: true, force: true });
});

describe("project lifecycle UX", () => {
  test("installs a fresh repository, configures multiple clients, and is idempotent", async () => {
    const harness = await startHarness(["codex", "claude"]);
    const first = await run(harness, ["install", ".", "--json"]);
    expect(first.exitCode).toBe(0);
    const installed = JSON.parse(first.stdout[0]!) as {
      project: { id: string; root: string; created: boolean };
      office: { revision: number; created: boolean };
      binding: { action: string };
      clients: Array<{ clientId: string; configuration: string }>;
      changes: Array<{ relativePath: string }>;
    };
    expect(installed).toMatchObject({
      project: { root: realpathSync(harness.projectRoot), created: true },
      office: { revision: 1, created: true },
      binding: { action: "create" },
    });
    expect(installed.clients).toEqual([
      expect.objectContaining({
        clientId: "codex",
        configuration: "configured",
      }),
      expect.objectContaining({
        clientId: "claude",
        configuration: "configured",
      }),
    ]);
    expect(installed.changes.map((change) => change.relativePath)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(
      existsSync(join(harness.projectRoot, ".ai-office", "project.json")),
    ).toBe(true);
    expect(
      existsSync(join(harness.projectRoot, ".ai-office", "project.sqlite")),
    ).toBe(false);

    const second = await run(harness, ["install", ".", "--json"]);
    const reconciled = JSON.parse(second.stdout[0]!) as {
      project: { id: string; created: boolean };
      office: { revision: number; created: boolean };
      binding: { action: string };
      changes: unknown[];
    };
    expect(reconciled).toMatchObject({
      project: { id: installed.project.id, created: false },
      office: { revision: 1, created: false },
      binding: { action: "none" },
      changes: [],
    });
    const humanInstall = await run(harness, ["install", "."]);
    expect(humanInstall.stdout).toEqual(
      expect.arrayContaining([
        "AI Office installed successfully.",
        `  id: ${installed.project.id}`,
        `  root: ${realpathSync(harness.projectRoot)}`,
        "  Codex CLI: configured",
        "  Claude Code: configured",
        "  ai-office status",
      ]),
    );

    const firstStatus = await run(harness, ["status", "--json"]);
    const secondStatus = await run(harness, ["status", "--json"]);
    expect(firstStatus.exitCode).toBe(0);
    expect(firstStatus.stdout).toEqual(secondStatus.stdout);
    expect(JSON.parse(firstStatus.stdout[0]!)).toMatchObject({
      schemaVersion: 1,
      installed: true,
      health: "healthy",
      project: {
        id: installed.project.id,
        root: realpathSync(harness.projectRoot),
        binding: { state: "valid" },
      },
      runtime: { daemon: "reachable", authoritativeState: "available" },
      office: { state: "configured", revision: 1 },
    });

    const taskList = await run(harness, ["task:list"]);
    expect(taskList.exitCode).toBe(0);
    expect(taskList.stdout[0]).toContain(installed.project.id);

    writeFileSync(
      join(harness.projectRoot, "AGENTS.md"),
      `${readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8")}\n# local drift\n`,
    );
    const drifted = await run(harness, ["status", "--json"]);
    expect(drifted.exitCode).toBe(1);
    expect(JSON.parse(drifted.stdout[0]!)).toMatchObject({
      health: "needs_attention",
      clients: [
        { clientId: "codex", configuration: "drifted" },
        { clientId: "claude", configuration: "drifted" },
      ],
    });
  });

  test("reuses an already imported project and canonicalizes the repository path", async () => {
    const harness = await startHarness();
    const child = join(harness.projectRoot, "temporary-child");
    mkdirSync(child);
    const imported = await run(harness, [
      "project:import",
      join(child, ".."),
      "--json",
    ]);
    const importedId = (
      JSON.parse(imported.stdout[0]!) as { projectId: string }
    ).projectId;
    const installed = await run(harness, [
      "install",
      join(child, ".."),
      "--json",
    ]);
    expect(JSON.parse(installed.stdout[0]!)).toMatchObject({
      project: {
        id: importedId,
        root: realpathSync(harness.projectRoot),
        created: false,
      },
    });
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(false);
  });

  test("installs an explicit nested project and discovers its nearest binding", async () => {
    const harness = await startHarness();
    const outer = await run(harness, ["install", ".", "--json"]);
    const outerId = (
      JSON.parse(outer.stdout[0]!) as { project: { id: string } }
    ).project.id;
    const nested = join(harness.projectRoot, "packages", "nested");
    const descendant = join(nested, "src");
    mkdirSync(descendant, { recursive: true });
    writeFileSync(
      join(nested, "package.json"),
      JSON.stringify({ name: "nested" }),
    );

    const nestedInstall = await run(
      harness,
      ["install", ".", "--json"],
      nested,
    );
    const nestedId = (
      JSON.parse(nestedInstall.stdout[0]!) as { project: { id: string } }
    ).project.id;
    expect(nestedId).not.toBe(outerId);
    expect(existsSync(join(nested, ".ai-office", "project.json"))).toBe(true);

    const nestedStatus = await run(harness, ["status", "--json"], descendant);
    expect(JSON.parse(nestedStatus.stdout[0]!)).toMatchObject({
      project: { id: nestedId, root: realpathSync(nested) },
    });
    const outerStatus = await run(harness, ["status", "--json"]);
    expect(JSON.parse(outerStatus.stdout[0]!)).toMatchObject({
      project: { id: outerId, root: realpathSync(harness.projectRoot) },
    });
  });

  test("reconciles a partial client integration when another supported client appears", async () => {
    const harness = await startHarness(["codex"]);
    await run(harness, ["install", ".", "--json"]);
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(false);

    addExecutable(harness.binRoot, "claude");
    const reconciled = await run(harness, ["install", ".", "--json"]);
    expect(
      (
        JSON.parse(reconciled.stdout[0]!) as {
          changes: Array<{ relativePath: string }>;
        }
      ).changes,
    ).toEqual([expect.objectContaining({ relativePath: "CLAUDE.md" })]);
    expect(
      readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8"),
    ).toContain("@AGENTS.md");
  });

  test("preflights client conflicts before binding or office configuration", async () => {
    const harness = await startHarness(["claude"]);
    writeFileSync(join(harness.projectRoot, "AGENTS.md"), "# User agents\n");
    writeFileSync(
      join(harness.projectRoot, "CLAUDE.md"),
      "<!-- >>> ai-office managed: canonical-project-instructions -->\n@OTHER.md\n",
    );

    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(1);
    expect(installed.stderr[0]).toContain("integration has a conflict");
    expect(
      existsSync(join(harness.projectRoot, ".ai-office", "project.json")),
    ).toBe(false);

    const imported = await run(harness, [
      "project:import",
      harness.projectRoot,
      "--json",
    ]);
    const projectId = (JSON.parse(imported.stdout[0]!) as { projectId: string })
      .projectId;
    const context = await run(harness, [
      "office:context",
      "--project",
      projectId,
    ]);
    expect(JSON.parse(context.stdout[0]!)).toMatchObject({ current: null });
  });

  test("preserves user-owned Codex and Claude instructions and reports unmanaged status", async () => {
    const harness = await startHarness(["codex", "claude"]);
    writeFileSync(join(harness.projectRoot, "AGENTS.md"), "# User agents\n");
    writeFileSync(
      join(harness.projectRoot, "CLAUDE.md"),
      "# User Claude notes\n\n@AGENTS.md\n",
    );
    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(0);
    expect(readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8")).toBe(
      "# User agents\n",
    );
    expect(readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8")).toBe(
      "# User Claude notes\n\n@AGENTS.md\n",
    );
    const status = await run(harness, ["status", "--json"]);
    expect(status.exitCode).toBe(1);
    expect(JSON.parse(status.stdout[0]!)).toMatchObject({
      health: "needs_attention",
      clients: [
        { clientId: "codex", configuration: "unmanaged" },
        { clientId: "claude", configuration: "unmanaged" },
      ],
    });
  });

  test("distinguishes no binding, stale binding, conflicts, and daemon unavailability", async () => {
    const harness = await startHarness(["codex"]);
    const notInstalled = await run(harness, ["status", "--json"]);
    expect(notInstalled.exitCode).toBe(1);
    expect(JSON.parse(notInstalled.stdout[0]!)).toMatchObject({
      installed: false,
      health: "not_installed",
      project: { binding: { state: "missing" } },
    });

    const adapter = new LocalProjectBindingAdapter();
    await adapter.applyWrite(
      await adapter.planWrite(harness.projectRoot, {
        schemaVersion: 1,
        managedBy: "ai-office",
        projectId: "missing-project",
      }),
    );
    const staleStatus = await run(harness, ["status", "--json"]);
    expect(JSON.parse(staleStatus.stdout[0]!)).toMatchObject({
      health: "needs_attention",
      project: { binding: { state: "stale" } },
      runtime: { authoritativeState: "project_missing" },
    });
    const staleInstall = await run(harness, ["install", ".", "--json"]);
    expect(staleInstall.exitCode).toBe(1);
    expect(staleInstall.stderr[0]).toContain(
      "missing from the current runtime",
    );

    const staleTaskList = await run(harness, ["task:list"]);
    expect(staleTaskList.exitCode).toBe(1);
    expect(staleTaskList.stderr[0]).toContain(
      "discovered project binding is not valid",
    );

    const rebound = await run(harness, ["install", ".", "--rebind", "--json"]);
    expect(rebound.exitCode).toBe(0);
    const reboundId = (
      JSON.parse(rebound.stdout[0]!) as { project: { id: string } }
    ).project.id;
    expect(reboundId).not.toBe("missing-project");

    const other = await run(harness, ["project:create", "Other", "--json"]);
    const otherId = (JSON.parse(other.stdout[0]!) as { projectId: string })
      .projectId;
    const overwrite = await adapter.planWrite(harness.projectRoot, {
      schemaVersion: 1,
      managedBy: "ai-office",
      projectId: otherId,
    });
    await adapter.applyWrite(overwrite);
    const conflicting = await run(harness, ["install", ".", "--json"]);
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr[0]).toContain("binding points to");

    const restore = await adapter.planWrite(harness.projectRoot, {
      schemaVersion: 1,
      managedBy: "ai-office",
      projectId: reboundId,
    });
    await adapter.applyWrite(restore);
    harness.controller.abort();
    await harness.running;
    const offline = await run(harness, ["status", "--json"]);
    expect(offline.exitCode).toBe(1);
    expect(JSON.parse(offline.stdout[0]!)).toMatchObject({
      installed: true,
      project: { id: reboundId, binding: { state: "unverified" } },
      runtime: { daemon: "unreachable", authoritativeState: "unavailable" },
    });
  });

  test("fails closed when the repository .ai-office directory is symlinked", async () => {
    const harness = await startHarness();
    const external = join(harness.workspace, "external-state");
    mkdirSync(external);
    symlinkSync(external, join(harness.projectRoot, ".ai-office"));
    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(1);
    expect(installed.stderr[0]).toContain(
      ".ai-office must be a real directory",
    );
    expect(existsSync(join(external, "project.json"))).toBe(false);
  });

  test("uninstalls only AI Office-owned local artifacts with an exact lifecycle plan", async () => {
    const harness = await startHarness(["codex", "claude"]);
    const globalMemory = join(harness.workspace, "global.sqlite");
    writeFileSync(globalMemory, "global memory remains\n");
    await run(harness, ["install", ".", "--json"]);
    writeFileSync(
      join(harness.projectRoot, ".ai-office", "notes.txt"),
      "preserve\n",
    );
    const planned = await run(harness, ["uninstall", ".", "--json"]);
    const plan = JSON.parse(planned.stdout[0]!) as {
      planHash: string;
      changes: Array<{ relativePath: string }>;
    };
    expect(plan.changes.map((change) => change.relativePath)).toEqual([
      ".ai-office/project.json",
      "AGENTS.md",
      "CLAUDE.md",
    ]);

    const bindingPath = join(harness.projectRoot, ".ai-office", "project.json");
    writeFileSync(bindingPath, `${readFileSync(bindingPath, "utf8")}\n`);
    const stale = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      plan.planHash,
      "--json",
    ]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr[0]).toContain("does not match the current plan");
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(true);

    const fresh = await run(harness, ["uninstall", ".", "--json"]);
    const freshHash = (JSON.parse(fresh.stdout[0]!) as { planHash: string })
      .planHash;
    const applied = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      freshHash,
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
      uninstalled: true,
      runtimeStatePreserved: true,
      globalMemoryPreserved: true,
    });
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(bindingPath)).toBe(false);
    expect(
      readFileSync(
        join(harness.projectRoot, ".ai-office", "notes.txt"),
        "utf8",
      ),
    ).toBe("preserve\n");
    expect(
      existsSync(join(harness.runtimeRoot, ".ai-office", "project.sqlite")),
    ).toBe(true);
    expect(readFileSync(globalMemory, "utf8")).toBe("global memory remains\n");

    writeFileSync(
      join(harness.projectRoot, "AGENTS.md"),
      "<!-- ai-office:managed project-instructions v1 -->\n# orphan\n",
    );
    const absentPlanOutput = await run(harness, ["uninstall", ".", "--json"]);
    const absentPlan = JSON.parse(absentPlanOutput.stdout[0]!) as {
      installed: boolean;
      planHash: string;
    };
    expect(absentPlan.installed).toBe(false);
    await run(harness, [
      "uninstall",
      ".",
      "--approve",
      absentPlan.planHash,
      "--json",
    ]);
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(true);
  });

  test("uninstall preserves user content while removing only a managed Claude block", async () => {
    const harness = await startHarness(["codex", "claude"]);
    writeFileSync(join(harness.projectRoot, "AGENTS.md"), "# User agents\n");
    writeFileSync(join(harness.projectRoot, "CLAUDE.md"), "# User Claude\n");
    await run(harness, ["install", ".", "--json"]);
    expect(
      readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8"),
    ).toContain("ai-office managed");
    const planOutput = await run(harness, ["uninstall", ".", "--json"]);
    const hash = (JSON.parse(planOutput.stdout[0]!) as { planHash: string })
      .planHash;
    await run(harness, ["uninstall", ".", "--approve", hash, "--json"]);

    expect(readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8")).toBe(
      "# User agents\n",
    );
    expect(readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8")).toBe(
      "# User Claude\n",
    );
  });
});

import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import type { LocalAgentClientFilesHooks } from "@ai-office/agent-client-integrations/local-agent-client-files.ts";
import { LocalProjectBindingAdapter } from "../../apps/cli/src/local-project-binding-adapter.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type {
  ProjectBinding,
  ProjectBindingInspection,
  ProjectBindingRemovePlan,
  ProjectBindingWritePlan,
} from "@ai-office/application/project-lifecycle/project-binding.ts";

interface RunningHarness {
  workspace: string;
  runtimeRoot: string;
  projectRoot: string;
  binRoot: string;
  socketRoot: string;
  socketPath: string;
  clients: DefaultAgentClientCatalog;
  projectBindings: ProjectBindingAdapter;
  controller: AbortController;
  running: Promise<void>;
}

class MutatingBindingAdapter implements ProjectBindingAdapter {
  private remainingInspections: number | null = null;

  constructor(
    private readonly delegate = new LocalProjectBindingAdapter(),
    private mutation: (() => void) | null = null,
  ) {}

  arm(inspections: number, mutation: () => void): void {
    this.remainingInspections = inspections;
    this.mutation = mutation;
  }

  resolveProjectRoot(inputPath: string): Promise<string> {
    return this.delegate.resolveProjectRoot(inputPath);
  }

  async inspect(
    inputPath: string,
    options?: { ancestors?: boolean; stopAt?: string },
  ): Promise<ProjectBindingInspection> {
    if (this.remainingInspections !== null) {
      this.remainingInspections -= 1;
      if (this.remainingInspections === 0) {
        this.remainingInspections = null;
        this.mutation?.();
      }
    }
    return this.delegate.inspect(inputPath, options);
  }

  planWrite(
    rootPath: string,
    binding: ProjectBinding,
  ): Promise<ProjectBindingWritePlan> {
    return this.delegate.planWrite(rootPath, binding);
  }

  applyWrite(plan: ProjectBindingWritePlan): Promise<void> {
    return this.delegate.applyWrite(plan);
  }

  planRemove(rootPath: string): Promise<ProjectBindingRemovePlan> {
    return this.delegate.planRemove(rootPath);
  }

  applyRemove(plan: ProjectBindingRemovePlan): Promise<void> {
    return this.delegate.applyRemove(plan);
  }
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

function configureGitIdentity(rootPath: string, remoteUrl: string): void {
  mkdirSync(join(rootPath, ".git"), { recursive: true });
  writeFileSync(
    join(rootPath, ".git", "config"),
    `[remote "origin"]\n\turl = ${remoteUrl}\n`,
  );
  writeFileSync(join(rootPath, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function createProjectFixture(rootPath: string, name: string): void {
  mkdirSync(rootPath, { recursive: true });
  writeFileSync(
    join(rootPath, "package.json"),
    `${JSON.stringify({ name })}\n`,
  );
  writeFileSync(join(rootPath, "index.ts"), "export const value = 1;\n");
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
  projectBindings: ProjectBindingAdapter = new LocalProjectBindingAdapter(),
  fileHooks?: LocalAgentClientFilesHooks,
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

  const clients = new DefaultAgentClientCatalog({
    pathValue: binRoot,
    ...(fileHooks === undefined ? {} : { fileHooks }),
  });
  const runtimePaths = resolveRuntimePaths({
    mode: "user",
    runtimeHome: runtimeRoot,
  });
  const socketRoot = mkdtempSync("/tmp/ao-life-sock-");
  const socketPath = join(socketRoot, "daemon.sock");
  const daemon = await bootstrap({
    runtimePaths,
    socketPath,
    agentClients: clients,
    projectBindings,
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
    projectBindings,
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
  const runtimePaths = resolveRuntimePaths({
    mode: "user",
    runtimeHome: harness.runtimeRoot,
  });
  const exitCode = await runDaemonCli(args, {
    runtimePaths,
    workingDirectory,
    socketPath: harness.socketPath,
    agentClients: harness.clients,
    projectBindings: harness.projectBindings,
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
      repositoryIdentity: { action: string };
      clients: Array<{ clientId: string; configuration: string }>;
      changes: Array<{ relativePath: string }>;
    };
    expect(installed).toMatchObject({
      project: { root: realpathSync(harness.projectRoot), created: true },
      office: { revision: 1, created: true },
      repositoryIdentity: { action: "create" },
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
      "AI-OFFICE.md",
      ".agents/skills/ai-office/SKILL.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/skills/ai-office/SKILL.md",
    ]);
    expect(
      readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8"),
    ).toContain("AI-OFFICE.md");
    expect(
      readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8"),
    ).toContain("@AI-OFFICE.md");
    expect(
      readFileSync(
        join(harness.projectRoot, ".agents/skills/ai-office/SKILL.md"),
        "utf8",
      ),
    ).toContain("name: ai-office");
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
      repositoryIdentity: { action: string };
      changes: unknown[];
    };
    expect(reconciled).toMatchObject({
      project: { id: installed.project.id, created: false },
      office: { revision: 1, created: false },
      repositoryIdentity: { action: "none" },
      changes: [],
    });
    const humanInstall = await run(harness, ["install", "."]);
    expect(humanInstall.stdout).toEqual(
      expect.arrayContaining([
        "AI Office installed.",
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
      schemaVersion: 3,
      installed: true,
      health: "healthy",
      project: {
        id: installed.project.id,
        root: realpathSync(harness.projectRoot),
        repositoryIdentity: { state: "valid" },
        runtimeAssociation: { state: "valid" },
      },
      runtime: { daemon: "reachable", authoritativeState: "available" },
      office: {
        state: "default_baseline",
        onboarding: "not_completed",
        revision: 1,
      },
    });

    const taskList = await run(harness, ["task:list"]);
    expect(taskList.exitCode).toBe(0);
    expect(taskList.stdout[0]).toContain(installed.project.id);

    writeFileSync(
      join(harness.projectRoot, "AI-OFFICE.md"),
      `${readFileSync(join(harness.projectRoot, "AI-OFFICE.md"), "utf8")}\n# local drift\n`,
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

  test("migrates the original managed client layout during normal install", async () => {
    const harness = await startHarness(["codex", "claude"]);
    writeFileSync(
      join(harness.projectRoot, "AGENTS.md"),
      "<!-- ai-office:managed project-instructions v1 -->\n# Legacy generated guide\n",
    );
    writeFileSync(
      join(harness.projectRoot, "CLAUDE.md"),
      "# Claude Code compatibility\n\n<!-- >>> ai-office managed: canonical-project-instructions -->\n@AGENTS.md\n<!-- <<< ai-office managed: canonical-project-instructions -->\n",
    );

    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(0);
    expect(
      (
        JSON.parse(installed.stdout[0]!) as {
          changes: Array<{ kind: string; relativePath: string }>;
        }
      ).changes,
    ).toEqual(
      expect.arrayContaining([
        { kind: "create", relativePath: "AI-OFFICE.md" },
        { kind: "update", relativePath: "AGENTS.md" },
        { kind: "update", relativePath: "CLAUDE.md" },
        {
          kind: "create",
          relativePath: ".agents/skills/ai-office/SKILL.md",
        },
        {
          kind: "create",
          relativePath: ".claude/skills/ai-office/SKILL.md",
        },
      ]),
    );
    expect(
      readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8"),
    ).toContain("AI-OFFICE.md");
    expect(
      readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8"),
    ).not.toContain("Legacy generated guide");
    expect(
      readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8"),
    ).toContain("@AI-OFFICE.md");

    const reconciled = await run(harness, ["install", ".", "--json"]);
    expect(JSON.parse(reconciled.stdout[0]!)).toMatchObject({ changes: [] });
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
    expect(existsSync(join(harness.projectRoot, "AI-OFFICE.md"))).toBe(false);
  });

  test("resolves lifecycle commands from descendants to the managed repository root", async () => {
    const harness = await startHarness();
    configureGitIdentity(
      harness.projectRoot,
      "https://example.test/team/descendant.git",
    );
    const descendant = join(harness.projectRoot, "packages", "foo", "src");
    mkdirSync(descendant, { recursive: true });

    const firstInstall = await run(
      harness,
      ["install", ".", "--json"],
      descendant,
    );
    const installed = JSON.parse(firstInstall.stdout[0]!) as {
      project: { id: string; root: string };
    };
    expect(installed.project.root).toBe(realpathSync(harness.projectRoot));
    expect(existsSync(join(descendant, ".ai-office", "project.json"))).toBe(
      false,
    );

    const repeated = JSON.parse(
      (await run(harness, ["install", ".", "--json"], descendant)).stdout[0]!,
    ) as { project: { id: string; root: string }; changes: unknown[] };
    expect(repeated).toMatchObject({
      project: {
        id: installed.project.id,
        root: realpathSync(harness.projectRoot),
      },
      changes: [],
    });

    const status = JSON.parse(
      (await run(harness, ["status", ".", "--json"], descendant)).stdout[0]!,
    ) as { project: { id: string; root: string } };
    expect(status.project).toMatchObject({
      id: installed.project.id,
      root: realpathSync(harness.projectRoot),
    });

    const uninstallPlan = JSON.parse(
      (await run(harness, ["uninstall", ".", "--json"], descendant)).stdout[0]!,
    ) as { planHash: string; rootPath: string };
    expect(uninstallPlan.rootPath).toBe(realpathSync(harness.projectRoot));
    const uninstalled = await run(
      harness,
      ["uninstall", ".", "--approve", uninstallPlan.planHash, "--json"],
      descendant,
    );
    expect(uninstalled.exitCode).toBe(0);
    expect(JSON.parse(uninstalled.stdout[0]!)).toMatchObject({
      rootPath: realpathSync(harness.projectRoot),
      uninstalled: true,
    });
  });

  test("keeps an explicit nested Git worktree as a distinct project", async () => {
    const harness = await startHarness();
    const outer = await run(harness, ["install", ".", "--json"]);
    const outerId = (
      JSON.parse(outer.stdout[0]!) as { project: { id: string } }
    ).project.id;
    const nested = join(harness.projectRoot, "packages", "nested");
    const descendant = join(nested, "src");
    mkdirSync(descendant, { recursive: true });
    writeFileSync(join(nested, "package.json"), '{"name":"nested"}\n');
    configureGitIdentity(nested, "https://example.test/team/nested.git");

    const nestedInstall = await run(
      harness,
      ["install", ".", "--json"],
      descendant,
    );
    const nestedResult = JSON.parse(nestedInstall.stdout[0]!) as {
      project: { id: string; root: string };
    };
    const nestedId = nestedResult.project.id;
    expect(nestedResult.project.root).toBe(realpathSync(nested));
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

  test("uses the explicit directory for a standalone non-Git project", async () => {
    const harness = await startHarness();
    const standalone = join(harness.workspace, "standalone", "project");
    createProjectFixture(standalone, "standalone");

    const installed = JSON.parse(
      (await run(harness, ["install", ".", "--json"], standalone)).stdout[0]!,
    ) as { project: { root: string } };
    expect(installed.project.root).toBe(realpathSync(standalone));
    expect(existsSync(join(standalone, ".ai-office", "project.json"))).toBe(
      true,
    );
  });

  test("associates two verified checkouts of one portable repository identity with one runtime project", async () => {
    const harness = await startHarness();
    const remote = "https://example.test/team/shared.git";
    configureGitIdentity(harness.projectRoot, remote);
    const first = await run(harness, ["install", ".", "--json"]);
    const firstResult = JSON.parse(first.stdout[0]!) as {
      project: { id: string; repositoryId: string };
    };

    const cloneRoot = join(harness.workspace, "clone");
    createProjectFixture(cloneRoot, "fixture-clone");
    configureGitIdentity(cloneRoot, remote);
    mkdirSync(join(cloneRoot, ".ai-office"));
    copyFileSync(
      join(harness.projectRoot, ".ai-office", "project.json"),
      join(cloneRoot, ".ai-office", "project.json"),
    );

    const cloneInstall = await run(
      harness,
      ["install", ".", "--json"],
      cloneRoot,
    );
    expect(cloneInstall.exitCode).toBe(2);
    expect(JSON.parse(cloneInstall.stdout[0]!)).toMatchObject({
      outcome: "installed_with_warnings",
      project: {
        id: firstResult.project.id,
        repositoryId: firstResult.project.repositoryId,
        created: false,
        association: "created",
      },
    });
    expect(
      JSON.parse(
        (await run(harness, ["status", "--json"], cloneRoot)).stdout[0]!,
      ),
    ).toMatchObject({
      installed: true,
      project: {
        id: firstResult.project.id,
        runtimeAssociation: { state: "valid" },
      },
    });
  });

  test("one stable runtime manages independent repository A and repository B", async () => {
    const harness = await startHarness(["codex"]);
    const repositoryB = join(harness.workspace, "repository-b");
    createProjectFixture(repositoryB, "repository-b");
    const projectA = JSON.parse(
      (await run(harness, ["install", ".", "--json"])).stdout[0]!,
    ) as { project: { id: string }; schemaVersion: number };
    const projectB = JSON.parse(
      (await run(harness, ["install", ".", "--json"], repositoryB)).stdout[0]!,
    ) as { project: { id: string }; schemaVersion: number };

    expect(projectA.project.id).not.toBe(projectB.project.id);
    const statusA = JSON.parse(
      (await run(harness, ["status", "--json"])).stdout[0]!,
    ) as { project: { id: string }; runtime: { home: string } };
    const statusB = JSON.parse(
      (await run(harness, ["status", "--json"], repositoryB)).stdout[0]!,
    ) as { project: { id: string }; runtime: { home: string } };
    expect(statusA).toMatchObject({
      project: { id: projectA.project.id },
      runtime: { home: realpathSync(harness.runtimeRoot) },
    });
    expect(statusB).toMatchObject({
      project: { id: projectB.project.id },
      runtime: { home: realpathSync(harness.runtimeRoot) },
    });
  });

  test("uses the same portable identity with independent project IDs in different runtimes", async () => {
    const machineA = await startHarness();
    const machineB = await startHarness();
    const remote = "ssh://git@example.test/team/shared.git";
    configureGitIdentity(machineA.projectRoot, remote);
    configureGitIdentity(machineB.projectRoot, remote);
    const first = JSON.parse(
      (await run(machineA, ["install", ".", "--json"])).stdout[0]!,
    ) as { project: { id: string; repositoryId: string } };
    mkdirSync(join(machineB.projectRoot, ".ai-office"));
    copyFileSync(
      join(machineA.projectRoot, ".ai-office", "project.json"),
      join(machineB.projectRoot, ".ai-office", "project.json"),
    );

    const second = JSON.parse(
      (await run(machineB, ["install", ".", "--json"])).stdout[0]!,
    ) as { project: { id: string; repositoryId: string } };
    expect(second.project.repositoryId).toBe(first.project.repositoryId);
    expect(second.project.id).not.toBe(first.project.id);
    expect(existsSync(join(machineA.runtimeRoot, "project.sqlite"))).toBe(true);
    expect(existsSync(join(machineB.runtimeRoot, "project.sqlite"))).toBe(true);
  });

  test("fails closed when a portable identity is copied to a different Git repository", async () => {
    const harness = await startHarness();
    configureGitIdentity(
      harness.projectRoot,
      "https://example.test/team/original.git",
    );
    await run(harness, ["install", ".", "--json"]);
    const copiedRoot = join(harness.workspace, "copied-identity");
    createProjectFixture(copiedRoot, "different");
    configureGitIdentity(copiedRoot, "https://example.test/team/different.git");
    mkdirSync(join(copiedRoot, ".ai-office"));
    copyFileSync(
      join(harness.projectRoot, ".ai-office", "project.json"),
      join(copiedRoot, ".ai-office", "project.json"),
    );

    const rejected = await run(harness, ["install", ".", "--json"], copiedRoot);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout[0]!)).toMatchObject({
      outcome: "failed",
      operation: "install",
      error: {
        message: expect.stringContaining(
          "cannot be verified as the same Git remote",
        ),
      },
    });
    expect(existsSync(join(copiedRoot, "AGENTS.md"))).toBe(false);
  });

  test("reattaches a moved checkout and migrates a schema-v1 binding", async () => {
    const harness = await startHarness();
    configureGitIdentity(
      harness.projectRoot,
      "https://example.test/team/moved.git",
    );
    const imported = JSON.parse(
      (await run(harness, ["project:import", harness.projectRoot, "--json"]))
        .stdout[0]!,
    ) as { projectId: string };
    const adapter = new LocalProjectBindingAdapter();
    const bindingPath = join(harness.projectRoot, ".ai-office", "project.json");
    mkdirSync(join(harness.projectRoot, ".ai-office"));
    writeFileSync(
      bindingPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: "ai-office",
          projectId: imported.projectId,
        },
        null,
        2,
      )}\n`,
    );
    const movedRoot = join(harness.workspace, "moved-project");
    renameSync(harness.projectRoot, movedRoot);

    const migrated = await run(harness, ["install", ".", "--json"], movedRoot);
    expect(migrated.exitCode).toBe(2);
    expect(JSON.parse(migrated.stdout[0]!)).toMatchObject({
      project: { id: imported.projectId, created: false },
      repositoryIdentity: {
        action: "update",
        migratedFromSchemaVersion: 1,
      },
    });
    expect((await adapter.inspect(movedRoot)).binding).toMatchObject({
      schemaVersion: 2,
      managedBy: "ai-office",
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
    ).toEqual([
      expect.objectContaining({ relativePath: "CLAUDE.md" }),
      expect.objectContaining({
        relativePath: ".claude/skills/ai-office/SKILL.md",
      }),
    ]);
    expect(
      readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8"),
    ).toContain("@AI-OFFICE.md");
  });

  test("reports no detected client as an installed warning, not configured", async () => {
    const harness = await startHarness();
    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(2);
    expect(JSON.parse(installed.stdout[0]!)).toMatchObject({
      outcome: "installed_with_warnings",
      clients: [
        {
          clientId: "codex",
          detection: "not_detected",
          configuration: "not_configured",
        },
        {
          clientId: "claude",
          detection: "not_detected",
          configuration: "not_configured",
        },
      ],
      issues: [
        expect.objectContaining({ code: "no_supported_client_detected" }),
      ],
    });
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
    expect(JSON.parse(installed.stdout[0]!)).toMatchObject({
      outcome: "partial",
      completed: {
        projectCreated: true,
        officeApplied: false,
        repositoryIdentityWritten: false,
        clientPaths: [],
      },
      error: { message: expect.stringContaining("integration has a conflict") },
    });
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

  test("preserves user-owned client instructions and manages only safe references", async () => {
    const harness = await startHarness(["codex", "claude"]);
    writeFileSync(join(harness.projectRoot, "AGENTS.md"), "# User agents\n");
    writeFileSync(
      join(harness.projectRoot, "CLAUDE.md"),
      "# User Claude notes\n\n@AGENTS.md\n",
    );
    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(2);
    expect(JSON.parse(installed.stdout[0]!)).toMatchObject({
      outcome: "installed_with_warnings",
      issues: [expect.objectContaining({ code: "client_codex_unmanaged" })],
    });
    expect(readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8")).toBe(
      "# User agents\n",
    );
    const claude = readFileSync(join(harness.projectRoot, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# User Claude notes\n\n@AGENTS.md");
    expect(claude).toContain("@AI-OFFICE.md");
    const status = await run(harness, ["status", "--json"]);
    expect(status.exitCode).toBe(1);
    expect(JSON.parse(status.stdout[0]!)).toMatchObject({
      health: "needs_attention",
      clients: [
        { clientId: "codex", configuration: "unmanaged" },
        { clientId: "claude", configuration: "configured" },
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
      project: { repositoryIdentity: { state: "missing" } },
    });

    const adapter = new LocalProjectBindingAdapter();
    mkdirSync(join(harness.projectRoot, ".ai-office"));
    writeFileSync(
      join(harness.projectRoot, ".ai-office", "project.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: "ai-office",
          projectId: "missing-legacy-project",
        },
        null,
        2,
      )}\n`,
    );
    const legacyStale = await run(harness, ["status", "--json"]);
    expect(JSON.parse(legacyStale.stdout[0]!)).toMatchObject({
      installed: false,
      project: {
        id: "missing-legacy-project",
        repositoryIdentity: { state: "legacy" },
        runtimeAssociation: { state: "project_missing" },
      },
      runtime: { authoritativeState: "project_missing" },
    });

    await adapter.applyWrite(
      await adapter.planWrite(harness.projectRoot, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: "missing-repository",
      }),
    );
    const cloneStatus = await run(harness, ["status", "--json"]);
    expect(JSON.parse(cloneStatus.stdout[0]!)).toMatchObject({
      health: "needs_attention",
      project: {
        repositoryIdentity: { state: "valid", id: "missing-repository" },
        runtimeAssociation: { state: "missing" },
      },
      runtime: { authoritativeState: "repository_unassociated" },
    });
    const rebound = await run(harness, ["install", ".", "--json"]);
    expect(rebound.exitCode).toBe(0);
    const reboundId = (
      JSON.parse(rebound.stdout[0]!) as { project: { id: string } }
    ).project.id;
    expect(reboundId).not.toBe("missing-repository");

    const otherRoot = join(harness.workspace, "other-project");
    mkdirSync(otherRoot);
    writeFileSync(join(otherRoot, "package.json"), '{"name":"other"}\n');
    const other = await run(harness, ["install", ".", "--json"], otherRoot);
    const otherRepositoryId = (
      JSON.parse(other.stdout[0]!) as { project: { repositoryId: string } }
    ).project.repositoryId;
    const overwrite = await adapter.planWrite(harness.projectRoot, {
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: otherRepositoryId,
    });
    await adapter.applyWrite(overwrite);
    const conflicting = await run(harness, ["install", ".", "--json"]);
    expect(conflicting.exitCode).toBe(1);
    expect(JSON.parse(conflicting.stdout[0]!)).toMatchObject({
      outcome: "failed",
      operation: "install",
      error: { message: expect.stringContaining("canonical path belongs to") },
    });

    const restore = await adapter.planWrite(harness.projectRoot, {
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: "missing-repository",
    });
    await adapter.applyWrite(restore);
    harness.controller.abort();
    await harness.running;
    const offline = await run(harness, ["status", "--json"]);
    expect(offline.exitCode).toBe(1);
    expect(JSON.parse(offline.stdout[0]!)).toMatchObject({
      schemaVersion: 3,
      installed: null,
      project: {
        id: null,
        repositoryIdentity: {
          id: "missing-repository",
          state: "valid",
        },
        runtimeAssociation: { state: "unverified" },
      },
      runtime: { daemon: "unreachable", authoritativeState: "unavailable" },
      clients: [
        expect.objectContaining({
          clientId: "codex",
          configuration: "unverified",
        }),
        expect.objectContaining({
          clientId: "claude",
          configuration: "not_configured",
        }),
      ],
    });
  });

  test("reports deterministic skill drift while authoritative status is offline", async () => {
    const harness = await startHarness(["codex", "claude"]);
    await run(harness, ["install", ".", "--json"]);
    const skillPath = join(
      harness.projectRoot,
      ".agents/skills/ai-office/SKILL.md",
    );
    const skill = readFileSync(skillPath, "utf8");
    const codexPointerPath = join(harness.projectRoot, "AGENTS.md");
    const codexPointer = readFileSync(codexPointerPath, "utf8");
    const claudeWrapperPath = join(
      harness.projectRoot,
      ".claude/skills/ai-office/SKILL.md",
    );
    const claudeWrapper = readFileSync(claudeWrapperPath, "utf8");
    writeFileSync(skillPath, `${skill}\nUser-modified managed body.\n`);

    harness.controller.abort();
    await harness.running;
    const offline = await run(harness, ["status", ".", "--json"]);
    expect(offline.exitCode).toBe(1);
    expect(JSON.parse(offline.stdout[0]!)).toMatchObject({
      installed: null,
      runtime: { daemon: "unreachable" },
      clients: [
        { clientId: "codex", configuration: "drifted" },
        { clientId: "claude", configuration: "drifted" },
      ],
    });

    writeFileSync(skillPath, skill);
    writeFileSync(
      codexPointerPath,
      `${codexPointer}\nUser-modified managed pointer.\n`,
    );
    expect(
      JSON.parse((await run(harness, ["status", ".", "--json"])).stdout[0]!),
    ).toMatchObject({
      clients: [
        { clientId: "codex", configuration: "drifted" },
        { clientId: "claude", configuration: "unverified" },
      ],
    });

    writeFileSync(codexPointerPath, codexPointer);
    writeFileSync(
      claudeWrapperPath,
      `${claudeWrapper}\nUser-modified managed wrapper.\n`,
    );
    expect(
      JSON.parse((await run(harness, ["status", ".", "--json"])).stdout[0]!),
    ).toMatchObject({
      clients: [
        { clientId: "codex", configuration: "unverified" },
        { clientId: "claude", configuration: "drifted" },
      ],
    });
  });

  test("fails closed when the repository .ai-office directory is symlinked", async () => {
    const harness = await startHarness();
    const external = join(harness.workspace, "external-state");
    mkdirSync(external);
    symlinkSync(external, join(harness.projectRoot, ".ai-office"));
    const installed = await run(harness, ["install", ".", "--json"]);
    expect(installed.exitCode).toBe(1);
    expect(JSON.parse(installed.stdout[0]!)).toMatchObject({
      outcome: "failed",
      error: {
        message: expect.stringContaining(".ai-office must be a real directory"),
      },
    });
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
    mkdirSync(join(harness.projectRoot, ".agents", "skills", "other"), {
      recursive: true,
    });
    mkdirSync(join(harness.projectRoot, ".claude", "skills", "other"), {
      recursive: true,
    });
    writeFileSync(
      join(harness.projectRoot, ".agents", "skills", "other", "SKILL.md"),
      "# User Codex skill\n",
    );
    writeFileSync(
      join(harness.projectRoot, ".claude", "skills", "other", "SKILL.md"),
      "# User Claude skill\n",
    );
    const planned = await run(harness, ["uninstall", ".", "--json"]);
    const plan = JSON.parse(planned.stdout[0]!) as {
      planHash: string;
      changes: Array<{ relativePath: string }>;
    };
    expect(plan.changes.map((change) => change.relativePath)).toEqual([
      ".agents/skills/ai-office/SKILL.md",
      ".claude/skills/ai-office/SKILL.md",
      "AGENTS.md",
      "AI-OFFICE.md",
      "CLAUDE.md",
      "runtime checkout association",
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
    expect(JSON.parse(stale.stdout[0]!)).toMatchObject({
      outcome: "failed",
      operation: "uninstall",
      error: {
        message: expect.stringContaining("does not match the current plan"),
      },
    });
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
    const appliedResult = JSON.parse(applied.stdout[0]!) as {
      projectId: string;
      uninstalled: boolean;
      runtimeStatePreserved: boolean;
      globalMemoryPreserved: boolean;
    };
    expect(appliedResult).toMatchObject({
      uninstalled: true,
      runtimeStatePreserved: true,
      globalMemoryPreserved: true,
    });
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(harness.projectRoot, "AI-OFFICE.md"))).toBe(false);
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(false);
    expect(
      existsSync(
        join(harness.projectRoot, ".agents/skills/ai-office/SKILL.md"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(harness.projectRoot, ".claude/skills/ai-office/SKILL.md"),
      ),
    ).toBe(false);
    expect(
      readFileSync(
        join(harness.projectRoot, ".agents", "skills", "other", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# User Codex skill\n");
    expect(
      readFileSync(
        join(harness.projectRoot, ".claude", "skills", "other", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# User Claude skill\n");
    expect(existsSync(bindingPath)).toBe(true);
    expect(
      readFileSync(
        join(harness.projectRoot, ".ai-office", "notes.txt"),
        "utf8",
      ),
    ).toBe("preserve\n");
    expect(existsSync(join(harness.runtimeRoot, "project.sqlite"))).toBe(true);
    expect(readFileSync(globalMemory, "utf8")).toBe("global memory remains\n");

    const detachedStatus = await run(harness, ["status", "--json"]);
    expect(JSON.parse(detachedStatus.stdout[0]!)).toMatchObject({
      installed: false,
      project: {
        repositoryIdentity: { state: "valid" },
        runtimeAssociation: { state: "missing" },
      },
    });
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

    const reinstalled = await run(harness, ["install", ".", "--json"]);
    expect(JSON.parse(reinstalled.stdout[0]!)).toMatchObject({
      project: { id: appliedResult.projectId, created: false },
    });
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

  test("full uninstall preserves shared artifacts required by user-owned AGENTS.md", async () => {
    const harness = await startHarness(["codex", "claude"]);
    const userAgents =
      "# Team instructions\n\nRead AI-OFFICE.md and use the repository ai-office skill.\n";
    writeFileSync(join(harness.projectRoot, "AGENTS.md"), userAgents);
    await run(harness, ["install", ".", "--json"]);
    expect(existsSync(join(harness.projectRoot, "AI-OFFICE.md"))).toBe(true);
    expect(
      existsSync(
        join(harness.projectRoot, ".agents/skills/ai-office/SKILL.md"),
      ),
    ).toBe(true);
    expect(readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8")).toBe(
      userAgents,
    );

    const plan = JSON.parse(
      (await run(harness, ["uninstall", ".", "--json"])).stdout[0]!,
    ) as { planHash: string };
    const removed = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      plan.planHash,
      "--json",
    ]);
    expect(removed.exitCode).toBe(0);
    expect(readFileSync(join(harness.projectRoot, "AGENTS.md"), "utf8")).toBe(
      userAgents,
    );
    expect(existsSync(join(harness.projectRoot, "AI-OFFICE.md"))).toBe(true);
    expect(
      existsSync(
        join(harness.projectRoot, ".agents/skills/ai-office/SKILL.md"),
      ),
    ).toBe(true);
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(false);
    expect(
      existsSync(
        join(harness.projectRoot, ".claude/skills/ai-office/SKILL.md"),
      ),
    ).toBe(false);
  });

  test("full uninstall stops if AGENTS.md becomes user-owned after preflight", async () => {
    let raceRoot = "";
    let armed = false;
    const concurrentAgents =
      "# Concurrent team instructions\n\nRead AI-OFFICE.md before working.\n";
    const harness = await startHarness(
      ["codex", "claude"],
      new LocalProjectBindingAdapter(),
      {
        beforeCommit: (relativePath) => {
          if (armed && relativePath === ".claude/skills/ai-office/SKILL.md") {
            armed = false;
            writeFileSync(join(raceRoot, "AGENTS.md"), concurrentAgents);
          }
        },
      },
    );
    raceRoot = harness.projectRoot;
    await run(harness, ["install", ".", "--json"]);
    const plan = JSON.parse(
      (await run(harness, ["uninstall", ".", "--json"])).stdout[0]!,
    ) as { planHash: string };

    armed = true;
    const partial = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      plan.planHash,
      "--json",
    ]);
    expect(partial.exitCode).toBe(1);
    expect(JSON.parse(partial.stdout[0]!)).toMatchObject({
      outcome: "partial",
      removedPaths: [".claude/skills/ai-office/SKILL.md", "CLAUDE.md"],
      associationRemoved: false,
      error: {
        message: expect.stringContaining(
          "Client integration changed after lifecycle approval",
        ),
      },
    });
    expect(readFileSync(join(raceRoot, "AGENTS.md"), "utf8")).toBe(
      concurrentAgents,
    );
    expect(existsSync(join(raceRoot, "AI-OFFICE.md"))).toBe(true);
    expect(
      existsSync(join(raceRoot, ".agents/skills/ai-office/SKILL.md")),
    ).toBe(true);
  });

  test("rejects a lifecycle uninstall plan when client integration changed", async () => {
    const harness = await startHarness(["codex", "claude"]);
    await run(harness, ["install", ".", "--json"]);
    const planned = JSON.parse(
      (await run(harness, ["uninstall", ".", "--json"])).stdout[0]!,
    ) as { planHash: string };
    const agentsPath = join(harness.projectRoot, "AGENTS.md");
    writeFileSync(
      agentsPath,
      `${readFileSync(agentsPath, "utf8")}\n# concurrent edit\n`,
    );

    const rejected = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      planned.planHash,
      "--json",
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout[0]!)).toMatchObject({
      outcome: "failed",
      operation: "uninstall",
      error: {
        message: expect.stringContaining("does not match the current plan"),
      },
    });
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(agentsPath, "utf8")).toContain("# concurrent edit");
  });

  test("reports removed artifacts when the repository identity changes after client removal", async () => {
    const bindings = new MutatingBindingAdapter();
    const harness = await startHarness(["codex", "claude"], bindings);
    await run(harness, ["install", ".", "--json"]);
    const planned = JSON.parse(
      (await run(harness, ["uninstall", ".", "--json"])).stdout[0]!,
    ) as { planHash: string };
    const identityPath = join(
      harness.projectRoot,
      ".ai-office",
      "project.json",
    );
    bindings.arm(3, () =>
      writeFileSync(identityPath, `${readFileSync(identityPath, "utf8")}\n`),
    );

    const partial = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      planned.planHash,
      "--json",
    ]);
    expect(partial.exitCode).toBe(1);
    expect(JSON.parse(partial.stdout[0]!)).toMatchObject({
      outcome: "partial",
      removedPaths: [
        ".claude/skills/ai-office/SKILL.md",
        "CLAUDE.md",
        "AGENTS.md",
        ".agents/skills/ai-office/SKILL.md",
        "AI-OFFICE.md",
      ],
      possiblyModifiedPaths: [],
      associationRemoved: false,
      repositoryIdentityPreserved: true,
      error: {
        message: expect.stringContaining(
          "Repository identity changed during uninstall",
        ),
      },
    });
    expect(existsSync(identityPath)).toBe(true);
    expect(existsSync(join(harness.projectRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(harness.projectRoot, "CLAUDE.md"))).toBe(false);

    const recoveryPlan = JSON.parse(
      (await run(harness, ["uninstall", ".", "--json"])).stdout[0]!,
    ) as { planHash: string };
    const recovered = await run(harness, [
      "uninstall",
      ".",
      "--approve",
      recoveryPlan.planHash,
      "--json",
    ]);
    expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(recovered.stdout[0]!)).toMatchObject({
      uninstalled: true,
      removedPaths: [],
      repositoryIdentityPreserved: true,
    });
  });
});

import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { LocalProjectBindingAdapter } from "../../apps/cli/src/local-project-binding-adapter.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { compileProjectHandoverSection } from "@ai-office/application/agent-client/project-handover-workflow.ts";
import type { ProjectHandoverReport } from "@ai-office/application/project-lifecycle/assess-project-handover.ts";

interface RunningHarness {
  workspace: string;
  runtimeRoot: string;
  projectRoot: string;
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

function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
}

/**
 * A repository with real commit evidence and a substantial amount of source
 * code, which is what the maturity heuristic actually measures.
 */
function existingProjectFiles(
  moduleCount = 30,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "fixture",
      devDependencies: { vitest: "1.0.0" },
    }),
    "README.md": "# Fixture\n",
    "CONTRIBUTING.md": "# Contributing\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    ".git/config":
      '[remote "origin"]\n\turl = git@example.com:acme/fixture.git\n',
    ".git/refs/heads/main": "0123456789abcdef0123456789abcdef01234567\n",
  };
  for (let index = 0; index < moduleCount; index += 1)
    files[`src/module-${index}.ts`] =
      `export const value${index} = ${index};\n`;
  return files;
}

const newProjectFiles: Readonly<Record<string, string>> = {
  "README.md": "# Idea\n",
};

async function startHarness(
  detected: readonly ("codex" | "claude")[] = ["codex", "claude"],
  files: Readonly<Record<string, string>> = {},
): Promise<RunningHarness> {
  const workspace = mkdtempSync(join(tmpdir(), "ai-office-handover-"));
  const runtimeRoot = join(workspace, "runtime");
  const projectRoot = join(workspace, "project");
  const binRoot = join(workspace, "bin");
  mkdirSync(runtimeRoot);
  mkdirSync(projectRoot);
  mkdirSync(binRoot);
  writeFiles(projectRoot, files);
  for (const client of detected) {
    const path = join(binRoot, client);
    writeFileSync(path, "#!/bin/sh\nexit 99\n");
    chmodSync(path, 0o755);
  }

  const clients = new DefaultAgentClientCatalog({ pathValue: binRoot });
  const runtimePaths = resolveRuntimePaths({
    mode: "user",
    runtimeHome: runtimeRoot,
  });
  const socketRoot = mkdtempSync("/tmp/ao-handover-sock-");
  const socketPath = join(socketRoot, "daemon.sock");
  const daemon = await bootstrap({
    runtimePaths,
    socketPath,
    agentClients: clients,
    projectBindings: new LocalProjectBindingAdapter(),
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

async function run(harness: RunningHarness, args: string[]) {
  const output = captureIo();
  const exitCode = await runDaemonCli(args, {
    runtimePaths: resolveRuntimePaths({
      mode: "user",
      runtimeHome: harness.runtimeRoot,
    }),
    workingDirectory: harness.projectRoot,
    socketPath: harness.socketPath,
    agentClients: harness.clients,
    projectBindings: new LocalProjectBindingAdapter(),
    io: output.io,
  });
  return { ...output, exitCode };
}

async function handoverReport(
  harness: RunningHarness,
): Promise<ProjectHandoverReport> {
  const result = await run(harness, ["next", "--json"]);
  return JSON.parse(result.stdout[0]!) as ProjectHandoverReport;
}

function dimensionState(report: ProjectHandoverReport, id: string): string {
  return report.handover.dimensions.find((dimension) => dimension.id === id)!
    .state;
}

function customizedManifest(): string {
  const manifest = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        ".agents",
        "skills",
        "ai-office",
        "assets",
        "default-office-manifest.json",
      ),
      "utf8",
    ),
  ) as {
    project: { mission: string; goals: string[]; constraints: string[] };
  };
  manifest.project.mission = "Deliver the fixture product";
  manifest.project.goals = ["Ship the first release"];
  manifest.project.constraints = ["Preserve the public API"];
  return JSON.stringify(manifest);
}

/**
 * Reproduces the shape of a project configured before the handover feature
 * existed: office approved, milestone active, clients reconciled, and no
 * confirmed repository review.
 */
async function configuredProject(harness: RunningHarness): Promise<string> {
  await run(harness, ["install", "."]);
  const projectId = (await handoverReport(harness)).project.id!;
  await run(harness, [
    "office:apply",
    "--project",
    projectId,
    "--manifest",
    customizedManifest(),
  ]);
  const created = await run(harness, [
    "milestone:create",
    "--project",
    projectId,
    "--title",
    "First milestone",
  ]);
  await run(harness, [
    "milestone:set-status",
    "--project",
    projectId,
    "--milestone",
    created.stdout[0]!.replace("Milestone created: ", ""),
    "--status",
    "active",
  ]);
  // The approved manifest changed the derived guidance, so managed client
  // files are drifted until install reconciles them.
  await run(harness, ["install", "."]);
  return projectId;
}

async function confirmReview(
  harness: RunningHarness,
  projectId: string,
  summary = "Bun and TypeScript monorepo with a daemon-backed CLI",
) {
  return run(harness, [
    "handover:confirm",
    "--project",
    projectId,
    "--summary",
    summary,
  ]);
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

describe("welcome and machine output", () => {
  test("welcomes the first connection once and keeps machine output clean", async () => {
    const harness = await startHarness(
      ["codex", "claude"],
      existingProjectFiles(),
    );

    const first = await run(harness, ["install", "."]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout[0]?.startsWith("╭")).toBe(true);
    expect(first.stdout.join("\n")).toContain("AI OFFICE");
    expect(first.stdout).toContain("AI Office installed.");
    expect(first.stdout).toContain("Next");
    expect(first.stdout.join("\n")).toContain(
      "Hand this project over to your virtual office",
    );
    expect(first.stdout.join("\n")).toContain("Try asking your AI client");

    const second = await run(harness, ["install", "."]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout[0]).toBe("AI Office installed.");
    expect(second.stdout.join("\n")).not.toContain("AI OFFICE");

    const machine = await run(harness, ["install", ".", "--json"]);
    expect(machine.stdout).toHaveLength(1);
    const payload = JSON.parse(machine.stdout[0]!) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload).not.toHaveProperty("handover");
    expect(machine.stdout[0]).not.toContain("AI OFFICE");
  });

  test("does not change the status envelope while adding human guidance", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    await run(harness, ["install", "."]);

    const machine = await run(harness, ["status", "--json"]);
    expect(machine.stdout).toHaveLength(1);
    const status = JSON.parse(machine.stdout[0]!) as Record<string, unknown>;
    expect(status.schemaVersion).toBe(3);
    expect(status).not.toHaveProperty("handover");

    const human = await run(harness, ["status"]);
    expect(human.stdout.join("\n")).toContain("handover: handover incomplete");
    expect(human.stdout).toContain("  ai-office next");
  });

  test("reports an unknown handover state when the runtime is unreachable", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    await run(harness, ["install", "."]);
    harness.controller.abort();
    await Promise.allSettled([harness.running]);

    const machine = await run(harness, ["next", "--json"]);
    expect(machine.exitCode).toBe(1);
    const report = JSON.parse(machine.stdout[0]!) as ProjectHandoverReport;
    expect(report.schemaVersion).toBe(1);
    expect(report.runtime.daemon).toBe("unreachable");
    expect(report.handover.state).toBe("unknown");
    expect(
      report.handover.dimensions.every(
        (dimension) => dimension.state === "unknown",
      ),
    ).toBe(true);
    expect(report.handover.recommendedActions[0]?.id).toBe("start_runtime");
  });
});

describe("repository classification", () => {
  test("classifies a substantial repository with commit evidence as existing", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    await run(harness, ["install", "."]);

    const report = await handoverReport(harness);
    expect(report.handover.repository).toBe("existing");
    expect(report.handover.state).toBe("needs_handover");
    expect(report.handover.dimensions.map((entry) => entry.id)).toEqual([
      "project_connection",
      "repository_understanding",
      "agent_clients",
      "product_direction",
      "delivery_plan",
      "working_agreement",
    ]);
  });

  test("classifies an almost empty repository as a new project", async () => {
    const harness = await startHarness(["codex"], newProjectFiles);
    await run(harness, ["install", "."]);

    const report = await handoverReport(harness);
    expect(report.handover.repository).toBe("new");
    expect(report.handover.recommendedActions[0]?.reason).not.toContain(
      "existing codebase",
    );
  });

  test("classifies a fully tooled scaffold without real code as new", async () => {
    const harness = await startHarness(["codex"], {
      ...existingProjectFiles(4),
      "package.json": JSON.stringify({
        name: "scaffold",
        dependencies: { react: "18.0.0", vite: "5.0.0" },
        devDependencies: { vitest: "1.0.0" },
      }),
      "bun.lock": "",
    });
    await run(harness, ["install", "."]);

    expect((await handoverReport(harness)).handover.repository).toBe("new");
  });
});

describe("repository understanding confirmation", () => {
  test("an approved office and active milestone do not make a project ready", async () => {
    // Upgrade shape: everything a pre-handover project already owns.
    const harness = await startHarness(["codex"], existingProjectFiles());
    await configuredProject(harness);

    const report = await handoverReport(harness);
    expect(report.handover.state).toBe("in_progress");
    expect(dimensionState(report, "product_direction")).toBe("ready");
    expect(dimensionState(report, "delivery_plan")).toBe("ready");
    expect(dimensionState(report, "repository_understanding")).toBe(
      "discovered",
    );
    expect(report.handover.recommendedActions[0]?.id).toBe(
      "confirm_repository_review",
    );
  });

  test("a confirmed review completes the handover", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    const projectId = await configuredProject(harness);

    const confirmation = await confirmReview(harness, projectId);
    expect(confirmation.exitCode).toBe(0);
    expect(confirmation.stdout[0]).toBe(
      "Handover repository review confirmed.",
    );
    expect(confirmation.stdout.join("\n")).toContain("grants no capability");

    const report = await handoverReport(harness);
    expect(dimensionState(report, "repository_understanding")).toBe("ready");
    expect(report.handover.state).toBe("ready");
    expect(report.handover.recommendedActions[0]?.id).toBe("start_next_work");
  });

  test("refuses to confirm a review without a summary", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    const projectId = await configuredProject(harness);

    const result = await confirmReview(harness, projectId, "   ");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "repository review summary is required",
    );
  });

  test("a materially changed repository stales the confirmation until it is reviewed again", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    const projectId = await configuredProject(harness);
    await confirmReview(harness, projectId);
    expect((await handoverReport(harness)).handover.state).toBe("ready");

    // A single new module keeps the same structural fingerprint.
    writeFiles(harness.projectRoot, {
      "src/module-extra.ts": "export const extra = 1;\n",
    });
    await run(harness, ["project:import", harness.projectRoot]);
    expect((await handoverReport(harness)).handover.state).toBe("ready");

    // Growing the repository by an order of magnitude and adding a language
    // does not.
    const grown: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1)
      grown[`service/handler-${index}.py`] = `VALUE = ${index}\n`;
    writeFiles(harness.projectRoot, grown);
    await run(harness, ["project:import", harness.projectRoot]);

    const stale = await handoverReport(harness);
    expect(dimensionState(stale, "repository_understanding")).toBe(
      "needs_input",
    );
    expect(stale.handover.state).toBe("in_progress");
    expect(stale.handover.recommendedActions[0]?.id).toBe(
      "review_repository_changes",
    );

    await confirmReview(harness, projectId, "Now also a Python service");
    expect((await handoverReport(harness)).handover.state).toBe("ready");
  });

  test("the confirmation survives reinstall and uninstall/reinstall", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    const projectId = await configuredProject(harness);
    await confirmReview(harness, projectId);

    await run(harness, ["install", "."]);
    expect((await handoverReport(harness)).handover.state).toBe("ready");

    const plan = await run(harness, ["uninstall", ".", "--json"]);
    const planHash = (JSON.parse(plan.stdout[0]!) as { planHash: string })
      .planHash;
    await run(harness, ["uninstall", ".", "--approve", planHash]);
    const reinstall = await run(harness, ["install", "."]);
    expect(reinstall.stdout.join("\n")).toContain("AI OFFICE");

    const report = await handoverReport(harness);
    expect(report.project.id).toBe(projectId);
    expect(dimensionState(report, "repository_understanding")).toBe("ready");
    expect(report.handover.state).toBe("ready");
  });
});

describe("recommended actions from real state", () => {
  test("surfaces work the office already tracks", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    const projectId = await configuredProject(harness);
    await confirmReview(harness, projectId);
    const before = await handoverReport(harness);
    expect(
      before.handover.recommendedActions.map((action) => action.id),
    ).not.toContain("review_active_work");

    await run(harness, [
      "task:create",
      "--project",
      projectId,
      "--title",
      "Existing work",
    ]);

    const report = await handoverReport(harness);
    const review = report.handover.recommendedActions.find(
      (action) => action.id === "review_active_work",
    );
    expect(review?.command).toBe("ai-office task:list");
    expect(review?.title).toBe("Review 1 open task(s)");
  });

  test("renders the readiness dimensions for a human", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles());
    await run(harness, ["install", "."]);

    const human = await run(harness, ["next"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout[0]).toBe("AI Office · Next steps");
    expect(human.stdout.join("\n")).toContain("state: needs_handover");
    expect(human.stdout.join("\n")).toContain("Repository understanding");
  });
});

describe("client integration", () => {
  test("installs the shared handover workflow into every supported client", async () => {
    const harness = await startHarness(
      ["codex", "claude"],
      existingProjectFiles(),
    );
    await run(harness, ["install", "."]);

    const sharedSkill = readFileSync(
      join(harness.projectRoot, ".agents", "skills", "ai-office", "SKILL.md"),
      "utf8",
    );
    expect(sharedSkill).toContain(compileProjectHandoverSection());
    expect(sharedSkill).toContain("ai-office next --json");
    expect(sharedSkill).toContain("ai-office handover:confirm");

    const claudeSkill = readFileSync(
      join(harness.projectRoot, ".claude", "skills", "ai-office", "SKILL.md"),
      "utf8",
    );
    expect(claudeSkill).toContain(".agents/skills/ai-office/SKILL.md");
    expect(claudeSkill).not.toContain("## Hand the project over");

    const guide = readFileSync(
      join(harness.projectRoot, "AI-OFFICE.md"),
      "utf8",
    );
    expect(guide).toContain("ai-office next");
    expect(guide).toContain(
      "Handover transfers organizational context ownership; it grants no capability and bypasses no approval",
    );
  });
});

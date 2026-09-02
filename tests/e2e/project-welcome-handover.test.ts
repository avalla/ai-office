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
import { join } from "node:path";
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
  for (const [relativePath, content] of Object.entries(files))
    writeFileSync(join(projectRoot, relativePath), content);
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

const existingProjectFiles = {
  "package.json": JSON.stringify({
    name: "fixture",
    devDependencies: { vitest: "1.0.0" },
  }),
  "index.ts": "export const value = 1;\n",
  "README.md": "# Fixture\n",
  "CONTRIBUTING.md": "# Contributing\n",
};

async function handoverReport(
  harness: RunningHarness,
): Promise<ProjectHandoverReport> {
  const result = await run(harness, ["next", "--json"]);
  return JSON.parse(result.stdout[0]!) as ProjectHandoverReport;
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
    project: {
      mission: string;
      goals: string[];
      constraints: string[];
    };
  };
  manifest.project.mission = "Deliver the fixture product";
  manifest.project.goals = ["Ship the first release"];
  manifest.project.constraints = ["Preserve the public API"];
  return JSON.stringify(manifest);
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

describe("welcome and project handover", () => {
  test("welcomes the first connection once and keeps machine output clean", async () => {
    const harness = await startHarness(
      ["codex", "claude"],
      existingProjectFiles,
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
    expect(second.stdout.join("\n")).toContain(
      "Hand this project over to your virtual office",
    );

    const machine = await run(harness, ["install", ".", "--json"]);
    expect(machine.stdout).toHaveLength(1);
    const payload = JSON.parse(machine.stdout[0]!) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload).not.toHaveProperty("handover");
    expect(machine.stdout[0]).not.toContain("AI OFFICE");
  });

  test("does not change the status envelope while adding human guidance", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles);
    await run(harness, ["install", "."]);

    const machine = await run(harness, ["status", "--json"]);
    expect(machine.stdout).toHaveLength(1);
    const status = JSON.parse(machine.stdout[0]!) as Record<string, unknown>;
    expect(status.schemaVersion).toBe(3);
    expect(status).not.toHaveProperty("handover");

    const human = await run(harness, ["status"]);
    const rendered = human.stdout.join("\n");
    expect(rendered).toContain("handover: handover incomplete");
    expect(human.stdout).toContain("  ai-office next");
  });

  test("assesses an existing repository as needing handover", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles);
    await run(harness, ["install", "."]);

    const report = await handoverReport(harness);
    expect(report.schemaVersion).toBe(1);
    expect(report.handover.state).toBe("needs_handover");
    expect(report.handover.repository).toBe("existing");
    expect(report.runtime.authoritativeState).toBe("available");
    expect(report.handover.dimensions.map((dimension) => dimension.id)).toEqual(
      [
        "project_connection",
        "repository_understanding",
        "agent_clients",
        "product_direction",
        "delivery_plan",
        "working_agreement",
      ],
    );
    const action = report.handover.recommendedActions[0]!;
    expect(action.id).toBe("complete_project_handover");
    expect(action.kind).toBe("conversational");
    expect(action.priority).toBe("high");

    const human = await run(harness, ["next"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout[0]).toBe("AI Office · Next steps");
    expect(human.stdout.join("\n")).toContain("state: needs_handover");
  });

  test("assesses an almost empty repository as a new project", async () => {
    const harness = await startHarness(["codex"], { "README.md": "# Idea\n" });
    await run(harness, ["install", "."]);

    const report = await handoverReport(harness);
    expect(report.handover.repository).toBe("new");
    expect(report.handover.state).toBe("needs_handover");
    expect(report.handover.recommendedActions[0]?.reason).not.toContain(
      "existing codebase",
    );
  });

  test("reaches readiness through office, milestone, and client reconciliation", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles);
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
    const milestoneId = created.stdout[0]!.replace("Milestone created: ", "");

    const partial = await handoverReport(harness);
    expect(partial.handover.state).toBe("in_progress");
    expect(
      partial.handover.dimensions.find(
        (dimension) => dimension.id === "delivery_plan",
      )?.state,
    ).toBe("discovered");

    await run(harness, [
      "milestone:set-status",
      "--project",
      projectId,
      "--milestone",
      milestoneId,
      "--status",
      "active",
    ]);
    // The approved manifest changed the derived guidance, so managed client
    // files are drifted until install reconciles them.
    await run(harness, ["install", "."]);

    const ready = await handoverReport(harness);
    expect(ready.handover.state).toBe("ready");
    expect(
      ready.handover.dimensions.every(
        (dimension) => dimension.state === "ready",
      ),
    ).toBe(true);
    expect(ready.handover.recommendedActions[0]?.id).toBe("start_next_work");
  });

  test("surfaces work the office already tracks", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles);
    await run(harness, ["install", "."]);
    const projectId = (await handoverReport(harness)).project.id!;
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

  test("preserves handover state across uninstall and reinstall", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles);
    await run(harness, ["install", "."]);
    const projectId = (await handoverReport(harness)).project.id!;
    await run(harness, [
      "office:apply",
      "--project",
      projectId,
      "--manifest",
      customizedManifest(),
    ]);

    const plan = await run(harness, ["uninstall", ".", "--json"]);
    const planHash = (JSON.parse(plan.stdout[0]!) as { planHash: string })
      .planHash;
    await run(harness, ["uninstall", ".", "--approve", planHash]);

    const reinstall = await run(harness, ["install", "."]);
    expect(reinstall.stdout.join("\n")).toContain("AI OFFICE");

    const report = await handoverReport(harness);
    expect(report.project.id).toBe(projectId);
    expect(
      report.handover.dimensions.find(
        (dimension) => dimension.id === "product_direction",
      )?.state,
    ).toBe("ready");
  });

  test("reports an unknown handover state when the runtime is unreachable", async () => {
    const harness = await startHarness(["codex"], existingProjectFiles);
    await run(harness, ["install", "."]);
    harness.controller.abort();
    await Promise.allSettled([harness.running]);

    const machine = await run(harness, ["next", "--json"]);
    expect(machine.exitCode).toBe(1);
    const report = JSON.parse(machine.stdout[0]!) as ProjectHandoverReport;
    expect(report.runtime.daemon).toBe("unreachable");
    expect(report.handover.state).toBe("unknown");
    expect(
      report.handover.dimensions.every(
        (dimension) => dimension.state === "unknown",
      ),
    ).toBe(true);
    expect(report.handover.recommendedActions[0]?.id).toBe("start_runtime");

    const human = await run(harness, ["next"]);
    expect(human.exitCode).toBe(1);
    expect(human.stdout.join("\n")).toContain("state: unknown");
  });

  test("installs the shared handover workflow into every supported client", async () => {
    const harness = await startHarness(
      ["codex", "claude"],
      existingProjectFiles,
    );
    await run(harness, ["install", "."]);

    const sharedSkill = readFileSync(
      join(harness.projectRoot, ".agents", "skills", "ai-office", "SKILL.md"),
      "utf8",
    );
    expect(sharedSkill).toContain(compileProjectHandoverSection());
    expect(sharedSkill).toContain("ai-office next --json");

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

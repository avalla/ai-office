import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { assertExists, initGitRepo, makeTempProject, runCli, runGit, runScript } from "./helpers";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempProject());
  runScript("install.sh", [dir]);
});

afterEach(() => {
  cleanup();
});

describe("ai-office cli", () => {
  it("doctor passes after install", () => {
    const { exitCode, stdout } = runCli(dir, ["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Adapter: codex");
    expect(stdout).toContain("PASS AI-OFFICE.md present");
    expect(stdout).toContain("PASS AGENTS.md present");
    expect(stdout).toContain("PASS .codex/skills present");
    expect(stdout).toContain("PASS .ai-office/install.json present");
  });

  it("doctor adapts to a base install", () => {
    const { dir: baseDir, cleanup: cleanupBase } = makeTempProject();
    try {
      runScript("install.sh", [baseDir, "--adapter=base"]);
      const result = runCli(baseDir, ["doctor"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Adapter: base");
      expect(result.stdout).toContain("PASS AI-OFFICE.md present");
      expect(result.stdout).toContain("PASS .ai-office/install.json present");
      expect(result.stdout).not.toContain("AGENTS.md present");
      expect(result.stdout).not.toContain(".codex/skills present");
    } finally {
      cleanupBase();
    }
  });

  it("doctor adapts to a claude-code install", () => {
    const { dir: claudeDir, cleanup: cleanupClaude } = makeTempProject();
    try {
      runScript("install.sh", [claudeDir, "--adapter=claude-code"]);
      const result = runCli(claudeDir, ["doctor"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Adapter: claude-code");
      expect(result.stdout).toContain("PASS CLAUDE.md present");
      expect(result.stdout).toContain("PASS .claude/skills present");
      expect(result.stdout).toContain("PASS .ai-office/install.json present");
    } finally {
      cleanupClaude();
    }
  });

  it("doctor adapts to a windsurf install", () => {
    const { dir: windsurfDir, cleanup: cleanupWindsurf } = makeTempProject();
    try {
      runScript("install.sh", [windsurfDir, "--adapter=windsurf"]);
      const result = runCli(windsurfDir, ["doctor"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Adapter: windsurf");
      expect(result.stdout).toContain("PASS AGENTS.md present");
      expect(result.stdout).toContain("PASS .windsurf/rules present");
      expect(result.stdout).toContain("PASS .windsurf/workflows present");
      expect(result.stdout).toContain("PASS .ai-office/install.json present");
    } finally {
      cleanupWindsurf();
    }
  });

  it("doctor adapts to an opencode install", () => {
    const { dir: opencodeDir, cleanup: cleanupOpencode } = makeTempProject();
    try {
      runScript("install.sh", [opencodeDir, "--adapter=opencode"]);
      const result = runCli(opencodeDir, ["doctor"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Adapter: opencode");
      expect(result.stdout).toContain("PASS opencode.json present");
      expect(result.stdout).toContain("PASS .opencode/commands present");
      expect(result.stdout).toContain("PASS .ai-office/install.json present");
    } finally {
      cleanupOpencode();
    }
  });

  it("creates a task deterministically and updates board counts", () => {
    const { exitCode, stdout } = runCli(dir, [
      "task",
      "create",
      "Implement",
      "billing",
      "sync",
      "priority:HIGH",
      "column:TODO",
      "assignee:Developer",
      "labels:billing,backend",
      "slug:billing-sync",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created M0_T001");

    const todoDir = join(dir, ".ai-office/tasks/TODO");
    const files = readdirSync(todoDir);
    expect(files.length).toBe(1);

    const task = readFileSync(join(todoDir, files[0]), "utf8");
    expect(task).toContain("**ID:** M0_T001");
    expect(task).toContain("**Status:** TODO");
    expect(task).toContain("**Priority:** HIGH");
    expect(task).toContain("**Labels:** billing,backend");

    const board = readFileSync(join(dir, ".ai-office/tasks/README.md"), "utf8");
    expect(board).toContain("TODO: 1");
    expect(board).toContain("BACKLOG: 0");
  });

  it("moves a task and updates history plus board counts", () => {
    runCli(dir, ["task", "create", "Fix", "upload", "timeout", "assignee:Developer"]);
    const { exitCode, stdout } = runCli(dir, ["task", "move", "M0_T001", "WIP", "started work"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Moved M0_T001: BACKLOG -> WIP");

    const wipDir = join(dir, ".ai-office/tasks/WIP");
    const files = readdirSync(wipDir);
    expect(files.length).toBe(1);

    const task = readFileSync(join(wipDir, files[0]), "utf8");
    expect(task).toContain("**Status:** WIP");
    expect(task).toContain("**Started:** ");
    expect(task).toContain("**Branch:** task/M0/T001-fix-upload-timeout");
    expect(task).toContain("BACKLOG → WIP — started work");

    const board = readFileSync(join(dir, ".ai-office/tasks/README.md"), "utf8");
    expect(board).toContain("BACKLOG: 0");
    expect(board).toContain("WIP: 1");
  });

  it("moves a task to REJECTED and tracks the board count", () => {
    runCli(dir, ["task", "create", "Drop", "legacy", "feature", "assignee:Planner"]);
    const moved = runCli(dir, ["task", "move", "M0_T001", "REJECTED", "out of scope"]);

    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toContain("Moved M0_T001: BACKLOG -> REJECTED");

    const rejectedDir = join(dir, ".ai-office/tasks/REJECTED");
    const files = readdirSync(rejectedDir);
    expect(files.length).toBe(1);

    const task = readFileSync(join(rejectedDir, files[0]), "utf8");
    expect(task).toContain("**Status:** REJECTED");
    expect(task).toContain("BACKLOG → REJECTED — out of scope");
    expect(task).toContain("moved to REJECTED — out of scope");

    const board = readFileSync(join(dir, ".ai-office/tasks/README.md"), "utf8");
    expect(board).toContain("BACKLOG: 0");
    expect(board).toContain("REJECTED: 1");
  });

  it("creates and updates a status file", () => {
    const created = runCli(dir, ["status", "set", "billing-sync", "router", "Planner", "Initial intake"]);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Status updated: billing-sync -> router");

    const statusPath = join(dir, ".ai-office/docs/runbooks/billing-sync-status.md");
    assertExists(statusPath);
    const initial = readFileSync(statusPath, "utf8");
    expect(initial).toContain("**State:** router");
    expect(initial).toContain("**Owner:** Planner");
    expect(initial).toContain("Initial status set");

    const updated = runCli(dir, ["status", "set", "billing-sync", "dev", "Developer", "Implementation started"]);
    expect(updated.exitCode).toBe(0);

    const current = readFileSync(statusPath, "utf8");
    expect(current).toContain("**State:** dev");
    expect(current).toContain("**Owner:** Developer");
    expect(current).toContain("| Developer | dev | Implementation started |");

    const fetched = runCli(dir, ["status", "get", "billing-sync"]);
    expect(fetched.exitCode).toBe(0);
    expect(fetched.stdout).toContain("State: dev");
    expect(fetched.stdout).toContain("Owner: Developer");
  });

  it("updates task metadata without moving the file", () => {
    runCli(dir, ["task", "create", "Review", "billing", "logic"]);

    const updated = runCli(dir, [
      "task",
      "update",
      "M0_T001",
      "priority:HIGH",
      "labels:billing,backend",
      "estimate:3h",
      "slug:billing-logic",
    ]);

    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("Updated M0_T001");

    const backlogDir = join(dir, ".ai-office/tasks/BACKLOG");
    const files = readdirSync(backlogDir);
    expect(files.length).toBe(1);

    const task = readFileSync(join(backlogDir, files[0]), "utf8");
    expect(task).toContain("**Priority:** HIGH");
    expect(task).toContain("**Labels:** billing,backend");
    expect(task).toContain("**Estimate:** 3h");
    expect(task).toContain("**Slug:** billing-logic");
    expect(task).toContain("Updated — priority: MEDIUM → HIGH");
  });

  it("creates milestone files and can auto-create milestone tasks", () => {
    const created = runCli(dir, [
      "milestone",
      "create",
      "M1",
      "Billing",
      "Sync",
      "target:2026-05-01",
      "tasks:yes",
    ]);

    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("✅ Milestone M1 created: Billing Sync");
    expect(created.stdout).toContain("Tasks created: 3");

    const milestonePath = join(dir, ".ai-office/milestones/M1.md");
    assertExists(milestonePath);
    const milestone = readFileSync(milestonePath, "utf8");
    expect(milestone).toContain('name: "Billing Sync"');
    expect(milestone).toContain("status: active");

    const backlogFiles = readdirSync(join(dir, ".ai-office/tasks/BACKLOG"));
    expect(backlogFiles.length).toBe(3);

    const status = runCli(dir, ["milestone", "status", "M1"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Milestone M1: Billing Sync");
    expect(status.stdout).toContain("BACKLOG (3)");

    const listed = runCli(dir, ["milestone", "list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("| M1 | Billing Sync | 2026-05-01 | active | 3 (0 done) |");
  });

  it("validates a PRD artifact deterministically", () => {
    const prdPath = join(dir, ".ai-office/docs/prd/billing-sync.md");
    const prd = `# Billing Sync

## Problem Statement

Billing records do not stay in sync across services.

## Goals

- Keep billing data synchronized

## Acceptance Criteria

- Sync jobs reconcile changes within 5 minutes

## Non-Goals

- Replacing the billing provider
`;
    writeFileSync(prdPath, prd);

    const result = runCli(dir, ["validate", "billing-sync", "prd"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Validation: billing-sync @ prd");
    expect(result.stdout).toContain("PASS Problem statement defined");
    expect(result.stdout).toContain("Result: PASS");
  });

  it("validates the dev stage using configured commands", () => {
    const configPath = join(dir, ".ai-office/project.config.md");
    const config = `---
agency: software-studio
project_name: test-project
typecheck_cmd: "true"
lint_cmd: "true"
test_cmd: "echo 'coverage 91%'"
test_runner: vitest
ui_framework: ""
design_system: ""
coverage_min: 80
lighthouse_min: 90
advance_mode: manual
---`;
    writeFileSync(configPath, config);
    writeFileSync(join(dir, "src.ts"), "export const ok = true;\n");

    const result = runCli(dir, ["validate", "billing-sync", "dev"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS Run typecheck — true");
    expect(result.stdout).toContain("PASS Run lint — true");
    expect(result.stdout).toContain("PASS Run tests — echo 'coverage 91%'");
    expect(result.stdout).toContain("Result: PASS");
  });

  it("validates the qa stage using configured completion check commands", () => {
    const configPath = join(dir, ".ai-office/project.config.md");
    const prdPath = join(dir, ".ai-office/docs/prd/billing-sync.md");
    const config = `---
agency: software-studio
project_name: test-project
typecheck_cmd: "true"
lint_cmd: "true"
test_cmd: "false"
test_runner: vitest
ui_framework: ""
design_system: ""
coverage_min: 80
lighthouse_min: 90
advance_mode: manual
pre_implementation_mode: minimal
completion_check_cmd_1: "echo reset done"
completion_check_cmd_2: "echo coverage 91%"
completion_check_cmd_3: "true"
---`;
    writeFileSync(configPath, config);
    writeFileSync(prdPath, `# Billing Sync

## Acceptance Criteria

- Works end to end
`);

    const result = runCli(dir, ["validate", "billing-sync", "qa"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS Run completion check 1 — echo reset done");
    expect(result.stdout).toContain("PASS Run completion check 2 — echo coverage 91%");
    expect(result.stdout).toContain("PASS Run completion check 3 — true");
    expect(result.stdout).toContain("PASS Coverage ≥ 80%");
    expect(result.stdout).toContain("Result: PASS");
  });

  it("creates a dedicated task worktree when task isolation is enabled", () => {
    const setup = runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--task-isolation-mode=worktree",
      "--task-base-branch=development",
      "--task-merge-target=development",
      "--task-worktree-root=.ai-office/worktrees",
    ]);
    expect(setup.exitCode).toBe(0);

    initGitRepo(dir, "development");

    runCli(dir, ["task", "create", "Implement", "billing", "sync", "assignee:Developer"]);
    const moved = runCli(dir, ["task", "move", "M0_T001", "WIP", "started work"]);

    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toContain("Worktree: .ai-office/worktrees/M0_T001-implement-billing-sync");

    const taskPath = join(dir, ".ai-office/tasks/WIP", readdirSync(join(dir, ".ai-office/tasks/WIP"))[0]);
    const task = readFileSync(taskPath, "utf8");
    expect(task).toContain("**Branch:** task/M0/T001-implement-billing-sync");
    expect(task).toContain("**Worktree:** .ai-office/worktrees/M0_T001-implement-billing-sync");

    const worktreePath = join(dir, ".ai-office/worktrees/M0_T001-implement-billing-sync");
    expect(existsSync(worktreePath)).toBe(true);

    const worktreeList = runGit(dir, ["worktree", "list", "--porcelain"]);
    expect(worktreeList.exitCode).toBe(0);
    expect(worktreeList.stdout).toContain(worktreePath);
  });

  it("squash-merges a task branch into the configured integration branch", () => {
    const setup = runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--task-isolation-mode=worktree",
      "--task-base-branch=development",
      "--task-merge-target=development",
      "--task-worktree-root=.ai-office/worktrees",
    ]);
    expect(setup.exitCode).toBe(0);

    initGitRepo(dir, "development");

    runCli(dir, ["task", "create", "Implement", "billing", "sync", "assignee:Developer"]);
    expect(runCli(dir, ["task", "move", "M0_T001", "WIP", "started work"]).exitCode).toBe(0);

    const worktreePath = join(dir, ".ai-office/worktrees/M0_T001-implement-billing-sync");
    writeFileSync(join(worktreePath, "feature.txt"), "billing sync ready\n");
    expect(runGit(worktreePath, ["add", "feature.txt"]).exitCode).toBe(0);
    expect(runGit(worktreePath, ["commit", "-m", "feat: add billing sync"]).exitCode).toBe(0);

    const reviewMove = runCli(dir, ["task", "move", "M0_T001", "REVIEW", "ready for integration"]);
    expect(reviewMove.exitCode).toBe(0);

    const integrate = runCli(dir, ["task", "integrate", "M0_T001", "ready for UAT"]);
    expect(integrate.exitCode).toBe(0);
    expect(integrate.stdout).toContain("Integrated M0_T001 into development");
    expect(integrate.stdout).toContain("Commit: squash(M0): Implement billing sync (M0_T001)");

    expect(readFileSync(join(dir, "feature.txt"), "utf8")).toContain("billing sync ready");

    const log = runGit(dir, ["log", "-1", "--pretty=%s"]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout.trim()).toBe("squash(M0): Implement billing sync (M0_T001)");

    const taskPath = join(dir, ".ai-office/tasks/REVIEW", readdirSync(join(dir, ".ai-office/tasks/REVIEW"))[0]);
    const task = readFileSync(taskPath, "utf8");
    expect(task).toContain("integrated into development from task/M0/T001-implement-billing-sync");
    expect(task).toContain("integrated into development — ready for UAT");
  });
});

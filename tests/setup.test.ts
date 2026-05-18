import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTempProject, runScript, assertExists } from "./helpers";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempProject());
  runScript("install.sh", [dir]);
});

afterEach(() => {
  cleanup();
});

describe("setup.sh", () => {
  it("exits 0 in non-interactive mode", () => {
    const { exitCode } = runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    expect(exitCode).toBe(0);
  });

  it("creates project.config.md with all required frontmatter fields", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    const config = join(dir, ".ai-office/project.config.md");
    assertExists(config);
    const content = readFileSync(config, "utf8");
    expect(content).toContain("office: software-studio");
    expect(content).toContain("agency: software-studio");
    expect(content).toContain("office_mode: legacy-preset");
    expect(content).toContain("legacy_agency_preset: software-studio");
    expect(content).toContain("project_name: test-project");
    expect(content).toContain("typecheck_cmd:");
    expect(content).toContain("lint_cmd:");
    expect(content).toContain("test_cmd:");
    expect(content).toContain("coverage_min:");
    expect(content).toContain("lighthouse_min:");
    expect(content).toContain("advance_mode:");
    expect(content).toContain("pre_implementation_mode:");
    expect(content).toContain("interactive_choices_mode:");
    expect(content).toContain("completion_check_cmd_1:");
    expect(content).toContain("completion_check_cmd_2:");
    expect(content).toContain("completion_check_cmd_3:");
    expect(content).toContain("task_isolation_mode:");
    expect(content).toContain("task_base_branch:");
    expect(content).toContain("task_merge_target:");
    expect(content).toContain("task_worktree_root:");
    expect(content).toContain("enable_github_sync:");
    expect(content).toContain("token_budget_mode: conservative");
    expect(content).toContain("token_budget_max_context_files: 8");
    expect(content).toContain("agent_operating_mode: review-first");
    expect(content).toContain("require_intent_check: true");
    expect(content).toContain("require_plan_before_code: true");
    expect(content).toContain("allow_tiny_fix_fast_path: true");
    expect(content).toContain("background_work_mode: simulated");
    expect(content).toContain("background_requires_status_file: true");
    expect(content).toContain("task_commit_traceability: yes");
    expect(content).toContain("task_commit_policy: required-for-implementation");
    expect(content).toContain("task_commit_link_mode: detect-current-branch");
    expect(content).toContain("task_commit_require_verification: yes");
    expect(content).toContain("github_issue_linking: optional");
    expect(content).toContain("github_commit_linking: optional");
    expect(content).toContain("commit_reference_style: task-and-issue");
    expect(content).toContain("github_issue_intake: enabled");
    expect(content).toContain("github_issue_auto_triage: suggested");
    expect(content).toContain("agent_instruction_discovery: enabled");
    expect(content).toContain("instruction_merge_mode: section");
    expect(content).toContain("instruction_backup: yes");
    expect(content).toContain("instruction_conflict_policy: keep-existing");
    expect(content).toContain("instruction_sidecar_dir: \".ai-office/instructions\"");
    assertExists(join(dir, ".ai-office/instruction-discovery.md"));
    assertExists(join(dir, ".ai-office/instruction-merge-policy.md"));
  });

  it("generates a custom project office in auto mode", () => {
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "custom-office-app",
          private: true,
          scripts: {
            lint: "eslint .",
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
          dependencies: {
            "@supabase/supabase-js": "^2.0.0",
            react: "^18.0.0",
            stripe: "^16.0.0",
          },
          devDependencies: {
            "@playwright/test": "^1.0.0",
            typescript: "^5.0.0",
            vitest: "^4.0.0",
          },
        },
        null,
        2
      )
    );
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(dir, "vercel.json"), "{}\n");

    const { exitCode } = runScript("setup.sh", [dir, "--auto", "--non-interactive"]);

    expect(exitCode).toBe(0);
    const config = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(config).toContain("office: custom-office");
    expect(config).toContain("agency: custom-office");
    expect(config).toContain("office_mode: custom");
    expect(config).toContain('legacy_agency_preset: ""');
    expect(config).not.toContain("Legacy agency preset: custom-office");
    expect(config).toContain('typecheck_cmd: "bun run typecheck"');
    expect(config).toContain('lint_cmd: "bun run lint"');
    expect(config).toContain('test_cmd: "bun run test"');

    const profile = readFileSync(join(dir, ".ai-office/office-profile.md"), "utf8");
    expect(profile).toContain("# Office Profile");
    expect(profile).toContain("Supabase/Postgres application");
    expect(profile).toContain("database-security");
    expect(profile).toContain("security");
    expect(profile).toContain("never load all roles");

    const pipeline = readFileSync(join(dir, ".ai-office/pipeline.md"), "utf8");
    expect(pipeline).toContain("RLS/security design");
    expect(pipeline).toContain("pgTAP tests");

    const gates = readFileSync(join(dir, ".ai-office/quality-gates.md"), "utf8");
    expect(gates).toContain("RLS review");
    expect(gates).toContain("security review");

    const operatingModel = readFileSync(join(dir, ".ai-office/agent-operating-model.md"), "utf8");
    expect(operatingModel).toContain("# Agent Operating Model");
    expect(operatingModel).toContain("review-first");
    expect(operatingModel).toContain("background-capable");

    const collaborationGates = readFileSync(join(dir, ".ai-office/collaboration-gates.md"), "utf8");
    expect(collaborationGates).toContain("# Collaboration Gates");
    expect(collaborationGates).toContain("Gate 1: Intent Check");
    expect(collaborationGates).toContain("Tiny Fix Fast Path");

    expect(readFileSync(join(dir, ".ai-office/templates/intent-check.md"), "utf8")).toContain("# Intent Check: [Request]");
    expect(readFileSync(join(dir, ".ai-office/templates/implementation-plan.md"), "utf8")).toContain("# Implementation Plan: [Task]");
    expect(readFileSync(join(dir, ".ai-office/templates/background-task.md"), "utf8")).toContain("# Background-Capable Task: [Task]");
    expect(readFileSync(join(dir, ".ai-office/background/README.md"), "utf8")).toContain("does not assume every host can run agents in the background");
    expect(readFileSync(join(dir, ".ai-office/task-commit-policy.md"), "utf8")).toContain("# Task Commit Policy");
    expect(readFileSync(join(dir, ".ai-office/issue-intake.md"), "utf8")).toContain("# Issue Intake");
    expect(readFileSync(join(dir, ".ai-office/templates/github-issue-intake.md"), "utf8")).toContain("# GitHub Issue Intake");
    expect(readFileSync(join(dir, ".ai-office/templates/user-report-triage.md"), "utf8")).toContain("# User Report Triage");
    expect(readFileSync(join(dir, ".ai-office/templates/issue-response.md"), "utf8")).toContain("# Issue Response");
    expect(readFileSync(join(dir, ".ai-office/intake/README.md"), "utf8")).toContain("structured intake records");

    const roles = readdirSync(join(dir, ".ai-office/roles")).sort();
    expect(roles).toContain("developer.md");
    expect(roles).toContain("database-security.md");
    expect(roles).toContain("ux.md");
    expect(roles).toContain("ops.md");
    expect(roles).toContain("security.md");

    const agencyJson = JSON.parse(readFileSync(join(dir, ".ai-office/agency.json"), "utf8"));
    expect(agencyJson.name).toBe("custom-office");
    expect(agencyJson.custom).toBe(true);
  });

  it("generates a legacy preset summary without pretending it is a repo-analyzed custom office", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);

    const profile = readFileSync(join(dir, ".ai-office/office-profile.md"), "utf8");
    const config = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(config).toContain("office_mode: legacy-preset");
    expect(config).toContain("legacy_agency_preset: software-studio");
    expect(profile).toContain("## Office Mode\nlegacy-preset");
    expect(profile).toContain("not a repository-analyzed custom office");
  });

  it("detects env file presence as a secrets risk without reading values", () => {
    writeFileSync(join(dir, ".env.example"), "SECRET_KEY=do-not-read\n");
    runScript("setup.sh", [dir, "--auto", "--non-interactive"]);

    const profile = readFileSync(join(dir, ".ai-office/office-profile.md"), "utf8");
    expect(profile).toContain("- secrets");
    expect(profile).not.toContain("do-not-read");
  });

  it("does not default Python projects to npm", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"py-office\"\n");
    runScript("setup.sh", [dir, "--auto", "--non-interactive"]);

    const profile = readFileSync(join(dir, ".ai-office/office-profile.md"), "utf8");
    expect(profile).toContain("- Language: Python");
    expect(profile).toContain("- JavaScript package manager: none detected");
    expect(profile).not.toContain("Package manager: npm");
  });

  it("does not default Go projects to npm", () => {
    writeFileSync(join(dir, "go.mod"), "module github.com/acme/roadrunner\n");
    runScript("setup.sh", [dir, "--auto", "--non-interactive"]);

    const profile = readFileSync(join(dir, ".ai-office/office-profile.md"), "utf8");
    expect(profile).toContain("- Language: Go");
    expect(profile).toContain("- JavaScript package manager: none detected");
    expect(profile).not.toContain("Package manager: npm");
  });

  it("does not default Deno projects to npm", () => {
    writeFileSync(join(dir, "deno.json"), "{}\n");
    runScript("setup.sh", [dir, "--auto", "--non-interactive"]);

    const profile = readFileSync(join(dir, ".ai-office/office-profile.md"), "utf8");
    expect(profile).toContain("- Toolchain: deno");
    expect(profile).toContain("- JavaScript package manager: none detected");
    expect(profile).not.toContain("Package manager: npm");
  });

  it("defaults advance_mode to manual", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("advance_mode: manual");
  });

  it("respects --advance-mode=auto", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--advance-mode=auto",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("advance_mode: auto");
  });

  it("defaults pre_implementation_mode to minimal", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("pre_implementation_mode: minimal");
  });

  it("respects --pre-implementation-mode=collaborative", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--pre-implementation-mode=collaborative",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("pre_implementation_mode: collaborative");
  });

  it("defaults interactive_choices_mode to text", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("interactive_choices_mode: text");
  });

  it("respects --interactive-choices-mode=buttons-when-available", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--interactive-choices-mode=buttons-when-available",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("interactive_choices_mode: buttons-when-available");
  });

  it("records completion check commands from setup flags", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--completion-check-cmd-1=npm run db:reset",
      "--completion-check-cmd-2=npm run test",
      "--completion-check-cmd-3=npx playwright test",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain('completion_check_cmd_1: "npm run db:reset"');
    expect(content).toContain('completion_check_cmd_2: "npm run test"');
    expect(content).toContain('completion_check_cmd_3: "npx playwright test"');
  });

  it("supports configuring the git task workflow", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--task-isolation-mode=worktree",
      "--task-base-branch=development",
      "--task-merge-target=development",
      "--task-worktree-root=.ai-office/worktrees",
    ]);

    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("task_isolation_mode: worktree");
    expect(content).toContain('task_base_branch: "development"');
    expect(content).toContain('task_merge_target: "development"');
    expect(content).toContain('task_worktree_root: ".ai-office/worktrees"');
  });

  it("defaults github sync workflows to disabled", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);

    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("enable_github_sync: no");
    expect(existsSync(join(dir, ".github/workflows/ai-office-sync.yml"))).toBe(false);
    expect(existsSync(join(dir, ".github/workflows/ai-office-github-inbound.yml"))).toBe(false);
  });

  it("installs github sync workflows when enabled", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--enable-github-sync=yes",
    ]);

    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("enable_github_sync: yes");
    expect(content).toContain("github_issue_linking: enabled");
    expect(content).toContain("github_commit_linking: enabled");

    const outbound = join(dir, ".github/workflows/ai-office-sync.yml");
    const inbound = join(dir, ".github/workflows/ai-office-github-inbound.yml");
    expect(existsSync(outbound)).toBe(true);
    expect(existsSync(inbound)).toBe(true);

    const outboundContent = readFileSync(outbound, "utf8");
    expect(outboundContent).toContain("issues: write");
    expect(outboundContent).toContain("task sync github");

    const inboundContent = readFileSync(inbound, "utf8");
    expect(inboundContent).toContain("contents: write");
    expect(inboundContent).toContain("task sync github --inbound");
  });

  it("creates agency.json with the selected agency name", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=lean-startup",
      "--name=my-mvp",
    ]);
    const agencyJson = join(dir, ".ai-office/agency.json");
    assertExists(agencyJson);
    const data = JSON.parse(readFileSync(agencyJson, "utf8"));
    expect(data.name).toBe("lean-startup");
    expect(typeof data.selectedAt).toBe("string");
  });

  it("copies only the requested legacy preset by default", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    assertExists(join(dir, ".ai-office/agencies/software-studio/config.md"));
    expect(existsSync(join(dir, ".ai-office/agencies/lean-startup/config.md"))).toBe(false);
  });

  it("copies all bundled legacy presets when explicitly requested", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--auto",
      "--include-legacy-presets",
      "--name=test-project",
    ]);
    assertExists(join(dir, ".ai-office/agencies/software-studio/config.md"));
    assertExists(join(dir, ".ai-office/agencies/lean-startup/config.md"));
  });

  it("preserves project-local custom agencies during setup", () => {
    mkdirSync(join(dir, ".ai-office", "agencies", "autoepoque"), { recursive: true });
    writeFileSync(
      join(dir, ".ai-office", "agencies", "autoepoque", "config.md"),
      `---
agency: autoepoque
name: Autoepoque
description: Custom project agency
custom: true
---
`
    );

    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=autoepoque",
      "--name=autoepoque",
    ]);

    const config = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    const agencyJson = JSON.parse(readFileSync(join(dir, ".ai-office/agency.json"), "utf8"));
    expect(config).toContain("agency: autoepoque");
    expect(agencyJson.name).toBe("autoepoque");
    expect(agencyJson.custom).toBe(true);
  });

  it("applies --stack=node-react preset commands", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
      "--stack=node-react",
    ]);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("vitest");
    expect(content).toContain("npm run lint");
  });

  it("detects Bun monorepo defaults from the project tech stack", () => {
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "autoepoque",
          private: true,
          scripts: {
            lint: "eslint .",
            test: "vitest run",
            "typecheck:all": "tsc --noEmit",
          },
          devDependencies: {
            eslint: "^9.0.0",
            typescript: "^5.0.0",
            vitest: "^4.0.0",
          },
        },
        null,
        2
      )
    );
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify(
        {
          name: "@autoepoque/web",
          dependencies: {
            react: "^18.0.0",
          },
          devDependencies: {
            "@shadcn/ui": "^0.0.4",
            tailwindcss: "^4.0.0",
          },
        },
        null,
        2
      )
    );
    writeFileSync(join(dir, "apps", "web", "components.json"), "{}\n");

    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
    ]);

    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("project_name: autoepoque");
    expect(content).toContain('typecheck_cmd: "bun run typecheck:all"');
    expect(content).toContain('lint_cmd: "bun run lint"');
    expect(content).toContain('test_cmd: "bun run test"');
    expect(content).toContain("test_runner: vitest");
    expect(content).toContain('ui_framework: "react"');
    expect(content).toContain('design_system: "shadcn/ui"');
  });

  it("detects Go project defaults from go.mod", () => {
    writeFileSync(join(dir, "go.mod"), "module github.com/acme/roadrunner\n");

    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
    ]);

    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("project_name: roadrunner");
    expect(content).toContain('typecheck_cmd: "go vet ./..."');
    expect(content).toContain('lint_cmd: "golangci-lint run"');
    expect(content).toContain('test_cmd: "go test ./..."');
    expect(content).toContain("test_runner: go test");
    expect(content).toContain('ui_framework: ""');
    expect(content).toContain('design_system: ""');
  });

  it("does not overwrite an existing project.config.md", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    const configPath = join(dir, ".ai-office/project.config.md");
    const original = readFileSync(configPath, "utf8");
    const { stdout } = runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=lean-startup",
      "--name=other",
    ]);
    expect(stdout).toContain("already exists");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("reconfigures an existing project.config.md when --reconfigure is passed", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);

    const { exitCode, stdout } = runScript("setup.sh", [
      dir,
      "--reconfigure",
      "--non-interactive",
      "--agency=lean-startup",
      "--name=reconfigured-project",
      "--stack=go",
      "--advance-mode=auto",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Reconfiguring existing project settings");
    expect(stdout).toContain("Updated .ai-office/project.config.md");

    const configPath = join(dir, ".ai-office/project.config.md");
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("agency: lean-startup");
    expect(content).toContain("project_name: reconfigured-project");
    expect(content).toContain('typecheck_cmd: "go vet ./..."');
    expect(content).toContain("advance_mode: auto");

    const agencyJson = JSON.parse(readFileSync(join(dir, ".ai-office/agency.json"), "utf8"));
    expect(agencyJson.name).toBe("lean-startup");

    const backups = readdirSync(join(dir, ".ai-office")).filter((name) => name.startsWith("project.config.md.bak."));
    expect(backups.length).toBeGreaterThan(0);
  });

  it("preserves custom frontmatter and notes during reconfigure", () => {
    const configPath = join(dir, ".ai-office/project.config.md");
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "autoepoque",
          private: true,
          scripts: {
            lint: "eslint .",
            test: "vitest run",
            "typecheck:all": "tsc --noEmit",
          },
          devDependencies: {
            eslint: "^9.0.0",
            typescript: "^5.0.0",
            vitest: "^4.0.0",
          },
        },
        null,
        2
      )
    );
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify(
        {
          name: "@autoepoque/web",
          dependencies: {
            react: "^18.0.0",
          },
          devDependencies: {
            "@shadcn/ui": "^0.0.4",
          },
        },
        null,
        2
      )
    );
    writeFileSync(join(dir, "apps", "web", "components.json"), "{}\n");
    const customConfig = `---
agency: software-studio
project_name: autoepoque
typecheck_cmd: "bun run typecheck:all"
lint_cmd: "bun run lint"
test_cmd: "bun run test:vitest"
test_runner: vitest
dev_web_cmd: "bun run dev:web"
dev_queues_cmd: "bun run dev:queues"
ui_framework: "React"
design_system: "Tailwind"
coverage_min: 80
lighthouse_min: 90
advance_mode: manual
pre_implementation_mode: confirm
completion_check_cmd_1: "npm run db:reset"
completion_check_cmd_2: "npm run test"
completion_check_cmd_3: "npx playwright test"
---

# Project Configuration

**Project:** autoepoque
**Agency:** software-studio
**Created:** 2026-03-18

## Notes

> Preserved project note
> Second line
`;
    writeFileSync(configPath, customConfig);
    writeFileSync(join(dir, ".ai-office/agency.json"), JSON.stringify({
      name: "software-studio",
      selectedAt: "2026-03-18T00:00:00.000Z",
      custom: false,
    }, null, 2));

    const { exitCode } = runScript("setup.sh", [
      dir,
      "--reconfigure",
      "--non-interactive",
      "--name=autoepoque",
    ]);

    expect(exitCode).toBe(0);
    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain('typecheck_cmd: "bun run typecheck:all"');
    expect(updated).toContain('lint_cmd: "bun run lint"');
    expect(updated).toContain('test_cmd: "bun run test"');
    expect(updated).toContain('ui_framework: "react"');
    expect(updated).toContain('design_system: "shadcn/ui"');
    expect(updated).toContain('dev_web_cmd: "bun run dev:web"');
    expect(updated).toContain('dev_queues_cmd: "bun run dev:queues"');
    expect(updated).toContain("> Preserved project note");
    expect(updated).toContain("> Second line");
    expect(updated).toContain("# Tech stack — used by $office-validate (dev stage)");
    expect(updated).toContain("# Design system — used by $office-review (UX sector)");
    expect(updated).toContain("pre_implementation_mode: confirm");
    expect(updated).toContain('completion_check_cmd_1: "npm run db:reset"');
    expect(updated).toContain('completion_check_cmd_2: "npm run test"');
    expect(updated).toContain('completion_check_cmd_3: "npx playwright test"');
  });

  it("supports --force as an alias for --reconfigure", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);

    const { exitCode } = runScript("setup.sh", [
      dir,
      "--force",
      "--non-interactive",
      "--agency=software-studio",
      "--name=forced-project",
    ]);

    expect(exitCode).toBe(0);
    const content = readFileSync(join(dir, ".ai-office/project.config.md"), "utf8");
    expect(content).toContain("project_name: forced-project");
  });

  it("exits with error if .ai-office/ does not exist", () => {
    const { dir: emptyDir, cleanup: c } = makeTempProject();
    const { exitCode, stdout } = runScript("setup.sh", [
      emptyDir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=x",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("install.sh");
    c();
  });
});

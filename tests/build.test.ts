import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, cpSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FRAMEWORK_DIR, assertExists, runBuild } from "./helpers";
import { ALL_SUPPORTED_COMMAND_IDS, COMMAND_SPECS, GENERATED_COMMAND_IDS } from "../src/adapter-manifest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-office-build-"));
  cpSync(FRAMEWORK_DIR, dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("build:adapters", () => {
  it("keeps the default README visual overview repo-workflow oriented", () => {
    const readme = readFileSync(join(FRAMEWORK_DIR, "README.md"), "utf8");
    const overview = readme.match(/### Visual Overview[\s\S]*?---/)?.[0] || "";
    expect(overview).toContain("Project Profile");
    expect(overview).toContain("Release Notes / Memory");
    expect(overview).not.toContain("CEO");
    expect(overview).not.toContain("Dev+UX+Security");
    expect(readme).toContain("## Agent Operating Model");
    expect(readme).toContain("## Background-Capable Workflows");
    expect(readme).toContain("## Task-to-Commit and GitHub Issue Traceability");
    expect(readme).toContain("## GitHub Issue Intake");
    expect(readme).toContain("## Existing Agent Instructions");
    expect(readme).toContain("$office-instruction-scan");
    expect(readme).toContain("without assuming every host can run agents in the background");
    expect(readme).not.toContain("all agents run in true background");
  });

  it("defines agent operating model commands in the adapter manifest", () => {
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-intent-check");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-plan");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-background");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-task-commit");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-task-trace");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-issue-intake");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-issue-triage");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-issue-link");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-issue-response");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-instruction-scan");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-instruction-merge");
    expect([...ALL_SUPPORTED_COMMAND_IDS]).toContain("office-instruction-status");
    const routeSpec = COMMAND_SPECS.find((spec) => spec.id === "office-route");
    expect(routeSpec?.steps.join("\n")).toContain("intent check");
    expect(routeSpec?.steps.join("\n")).toContain("tiny-fix-fast-path");
  });

  it("generates host-specific wrappers from the neutral manifest", () => {
    const result = runBuild(["--root-dir", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Generated adapter outputs");

    const codexSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-task-create/SKILL.md");
    const codexProfileSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-profile/SKILL.md");
    const codexIntentSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-intent-check/SKILL.md");
    const codexPlanSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-plan/SKILL.md");
    const codexBackgroundSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-background/SKILL.md");
    const codexTaskCommitSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-task-commit/SKILL.md");
    const codexIssueIntakeSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-issue-intake/SKILL.md");
    const claudeSkill = join(dir, "skeleton/adapters/claude-code/.claude/skills/office-task-create/SKILL.md");
    const codexMetaSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-meta/SKILL.md");
    const claudeMetaSkill = join(dir, "skeleton/adapters/claude-code/.claude/skills/office-meta/SKILL.md");
    const opencodeCommand = join(dir, "skeleton/adapters/opencode/.opencode/commands/office-task-create.md");
    const opencodeMetaCommand = join(dir, "skeleton/adapters/opencode/.opencode/commands/office-meta.md");
    const opencodeInstructions = join(dir, "skeleton/adapters/opencode/opencode.json");
    const windsurfWorkflow = join(dir, "skeleton/adapters/windsurf/.windsurf/workflows/office-task-create.md");
    const codexInstructions = join(dir, "skeleton/adapters/codex/AGENTS.md");
    const windsurfInstructions = join(dir, "skeleton/adapters/windsurf/AGENTS.md");
    const shellMetadata = join(dir, "generated/adapter-metadata.sh");

    assertExists(codexSkill);
    assertExists(codexProfileSkill);
    assertExists(codexIntentSkill);
    assertExists(codexPlanSkill);
    assertExists(codexBackgroundSkill);
    assertExists(codexTaskCommitSkill);
    assertExists(codexIssueIntakeSkill);
    assertExists(claudeSkill);
    assertExists(opencodeCommand);
    assertExists(opencodeInstructions);
    assertExists(windsurfWorkflow);
    assertExists(codexInstructions);
    assertExists(windsurfInstructions);
    assertExists(shellMetadata);

    expect(readFileSync(codexSkill, "utf8")).toContain("$office-task-create");
    expect(readFileSync(codexProfileSkill, "utf8")).toContain("custom project office profile");
    expect(readFileSync(codexIntentSkill, "utf8")).toContain("Review request intent before implementation");
    expect(readFileSync(codexPlanSkill, "utf8")).toContain("Do not implement code in this command");
    expect(readFileSync(codexBackgroundSkill, "utf8")).toContain("Never claim work is running in the background");
    expect(readFileSync(codexTaskCommitSkill, "utf8")).toContain("Link one or more Git commits");
    expect(readFileSync(codexIssueIntakeSkill, "utf8")).toContain("GitHub Issue as an AI Office intake record");
    expect(readFileSync(claudeSkill, "utf8")).toContain("/office-task-create");
    expect(readFileSync(opencodeCommand, "utf8")).toContain("# /office-task-create");
    expect(readFileSync(opencodeCommand, "utf8")).toContain("Follow these steps:");
    expect(readFileSync(codexMetaSkill, "utf8")).toContain(".codex/skills/.version");
    expect(readFileSync(codexMetaSkill, "utf8")).toContain("all 37 expected wrapper files");
    expect(readFileSync(claudeMetaSkill, "utf8")).toContain(".claude/skills/.version");
    expect(readFileSync(claudeMetaSkill, "utf8")).toContain("all 37 expected wrapper files");
    expect(readFileSync(opencodeMetaCommand, "utf8")).toContain(".opencode/.version");
    expect(readFileSync(opencodeMetaCommand, "utf8")).toContain(".opencode/commands/");
    expect(readFileSync(opencodeInstructions, "utf8")).toContain("\"$schema\": \"https://opencode.ai/config.json\"");
    expect(readFileSync(shellMetadata, "utf8")).toContain("AI_OFFICE_ADAPTERS=(\"base\" \"codex\" \"claude-code\" \"opencode\" \"windsurf\")");
    expect(readFileSync(shellMetadata, "utf8")).toContain("adapter_skill_dest_rel");
    expect(readFileSync(shellMetadata, "utf8")).toContain("adapter_commands_dest_rel");
    expect(readFileSync(windsurfWorkflow, "utf8")).toContain("# /office-task-create");
    expect(readFileSync(codexInstructions, "utf8")).toContain("Codex adapter");
    expect(readFileSync(codexInstructions, "utf8")).toContain("interactive_choices_mode");
    expect(readFileSync(codexInstructions, "utf8")).toContain("request_user_input");
    expect(readFileSync(windsurfInstructions, "utf8")).toContain("Windsurf adapter");
    expect(readFileSync(windsurfInstructions, "utf8")).toContain("interactive_choices_mode");
    expect(readdirSync(join(dir, "skeleton/adapters/codex/.codex/skills")).sort()).toEqual([...ALL_SUPPORTED_COMMAND_IDS].sort());
    expect(readdirSync(join(dir, "skeleton/adapters/claude-code/.claude/skills")).sort()).toEqual([...ALL_SUPPORTED_COMMAND_IDS].sort());
    expect(readdirSync(join(dir, "skeleton/adapters/opencode/.opencode/commands")).sort()).toEqual(
      [...ALL_SUPPORTED_COMMAND_IDS].map((id) => `${id}.md`).sort()
    );
    expect(readdirSync(join(dir, "skeleton/adapters/windsurf/.windsurf/workflows")).sort()).toEqual(
      [...GENERATED_COMMAND_IDS].map((id) => `${id}.md`).sort()
    );
    expect(existsSync(join(dir, "skeleton/.codex"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/.claude"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/.ai-office"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/.mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/core/.ai-office/agencies/autoepoque"))).toBe(false);
  });
});

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, cpSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FRAMEWORK_DIR, assertExists, runBuild } from "./helpers";
import { ALL_SUPPORTED_COMMAND_IDS, GENERATED_COMMAND_IDS } from "../src/adapter-manifest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-office-build-"));
  cpSync(FRAMEWORK_DIR, dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("build:adapters", () => {
  it("generates host-specific wrappers from the neutral manifest", () => {
    const result = runBuild(["--root-dir", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Generated adapter outputs");

    const codexSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-task-create/SKILL.md");
    const claudeSkill = join(dir, "skeleton/adapters/claude-code/.claude/skills/office-task-create/SKILL.md");
    const codexMetaSkill = join(dir, "skeleton/adapters/codex/.codex/skills/office-meta/SKILL.md");
    const claudeMetaSkill = join(dir, "skeleton/adapters/claude-code/.claude/skills/office-meta/SKILL.md");
    const windsurfWorkflow = join(dir, "skeleton/adapters/windsurf/.windsurf/workflows/office-task-create.md");
    const codexInstructions = join(dir, "skeleton/adapters/codex/AGENTS.md");
    const windsurfInstructions = join(dir, "skeleton/adapters/windsurf/AGENTS.md");
    const shellMetadata = join(dir, "generated/adapter-metadata.sh");

    assertExists(codexSkill);
    assertExists(claudeSkill);
    assertExists(windsurfWorkflow);
    assertExists(codexInstructions);
    assertExists(windsurfInstructions);
    assertExists(shellMetadata);

    expect(readFileSync(codexSkill, "utf8")).toContain("$office-task-create");
    expect(readFileSync(claudeSkill, "utf8")).toContain("/office-task-create");
    expect(readFileSync(codexMetaSkill, "utf8")).toContain(".codex/skills/.version");
    expect(readFileSync(codexMetaSkill, "utf8")).toContain("all 24 expected skills");
    expect(readFileSync(claudeMetaSkill, "utf8")).toContain(".claude/skills/.version");
    expect(readFileSync(claudeMetaSkill, "utf8")).toContain("all 24 expected skills");
    expect(readFileSync(shellMetadata, "utf8")).toContain("AI_OFFICE_ADAPTERS=(\"base\" \"codex\" \"claude-code\" \"windsurf\")");
    expect(readFileSync(shellMetadata, "utf8")).toContain("adapter_skill_dest_rel");
    expect(readFileSync(windsurfWorkflow, "utf8")).toContain("# /office-task-create");
    expect(readFileSync(codexInstructions, "utf8")).toContain("Codex adapter");
    expect(readFileSync(windsurfInstructions, "utf8")).toContain("Windsurf adapter");
    expect(readdirSync(join(dir, "skeleton/adapters/codex/.codex/skills")).sort()).toEqual([...ALL_SUPPORTED_COMMAND_IDS].sort());
    expect(readdirSync(join(dir, "skeleton/adapters/claude-code/.claude/skills")).sort()).toEqual([...ALL_SUPPORTED_COMMAND_IDS].sort());
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

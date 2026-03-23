import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, cpSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FRAMEWORK_DIR, assertExists, runBuild } from "./helpers";

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
    const windsurfWorkflow = join(dir, "skeleton/adapters/windsurf/.windsurf/workflows/office-task-create.md");
    const codexInstructions = join(dir, "skeleton/adapters/codex/AGENTS.md");
    const windsurfInstructions = join(dir, "skeleton/adapters/windsurf/AGENTS.md");

    assertExists(codexSkill);
    assertExists(claudeSkill);
    assertExists(windsurfWorkflow);
    assertExists(codexInstructions);
    assertExists(windsurfInstructions);

    expect(readFileSync(codexSkill, "utf8")).toContain("$office-task-create");
    expect(readFileSync(claudeSkill, "utf8")).toContain("/office-task-create");
    expect(readFileSync(windsurfWorkflow, "utf8")).toContain("# /office-task-create");
    expect(readFileSync(codexInstructions, "utf8")).toContain("Codex adapter");
    expect(readFileSync(windsurfInstructions, "utf8")).toContain("Windsurf adapter");
    expect(existsSync(join(dir, "skeleton/.codex"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/.claude"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/.ai-office"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/.mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "skeleton/AGENTS.md"))).toBe(false);
  });
});

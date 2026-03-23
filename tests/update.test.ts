import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTempProject, runScript, assertExists, FRAMEWORK_DIR } from "./helpers";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempProject());
  runScript("install.sh", [dir]);
});

afterEach(() => {
  cleanup();
});

describe("update.sh", () => {
  it("reports up-to-date when versions match", () => {
    const { exitCode, stdout } = runScript("update.sh", [dir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("up to date");
  });

  it("detects an outdated installation and updates skills", () => {
    const metadataPath = join(dir, ".ai-office/install.json");
    const versionFile = join(dir, ".codex/skills/.version");
    writeFileSync(versionFile, "0.0.1");
    writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 1,
      version: "0.0.1",
      adapter: "codex",
      installedAt: "2026-03-23T00:00:00Z",
    }, null, 2));

    const proc = Bun.spawnSync(["bash", "update.sh", dir], {
      cwd: FRAMEWORK_DIR,
      stdin: new TextEncoder().encode("Y\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(stdout).toContain("Updated to");

    const installed = readFileSync(versionFile, "utf8").trim();
    const source = readFileSync(join(FRAMEWORK_DIR, "VERSION"), "utf8").trim();
    expect(installed).toBe(source);

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata.adapter).toBe("codex");
    expect(metadata.version).toBe(source);
  });

  it("migrates a legacy Claude install version stamp to neutral metadata without forcing Codex", () => {
    rmSync(join(dir, ".codex"), { recursive: true, force: true });
    rmSync(join(dir, ".ai-office/install.json"), { force: true });
    assertExists(join(dir, ".ai-office"));
    const legacyVersionDir = join(dir, ".claude/skills");
    mkdirSync(legacyVersionDir, { recursive: true });
    writeFileSync(join(legacyVersionDir, ".version"), "0.0.1");

    const proc = Bun.spawnSync(["bash", "update.sh", dir], {
      cwd: FRAMEWORK_DIR,
      stdin: new TextEncoder().encode("Y\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(dir, ".claude/skills/.version"))).toBe(true);
    expect(existsSync(join(dir, ".ai-office/install.json"))).toBe(true);

    const metadata = JSON.parse(readFileSync(join(dir, ".ai-office/install.json"), "utf8"));
    expect(metadata.adapter).toBe("claude-code");
  });

  it("preserves existing .ai-office/ structure after update", () => {
    writeFileSync(join(dir, ".codex/skills/.version"), "0.0.1");
    writeFileSync(join(dir, ".ai-office/install.json"), JSON.stringify({
      schemaVersion: 1,
      version: "0.0.1",
      adapter: "codex",
      installedAt: "2026-03-23T00:00:00Z",
    }, null, 2));

    Bun.spawnSync(["bash", "update.sh", dir], {
      cwd: FRAMEWORK_DIR,
      stdin: new TextEncoder().encode("Y\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    assertExists(join(dir, ".ai-office/tasks/BACKLOG"), "BACKLOG");
    assertExists(join(dir, ".ai-office/tasks/BLOCKED"), "BLOCKED");
    assertExists(join(dir, ".ai-office/tasks/DONE"), "DONE");
    assertExists(join(dir, ".ai-office/agents"), "agents");
    assertExists(join(dir, ".ai-office/agencies"), "agencies");
  });

  it("updates a windsurf install and preserves the windsurf adapter", () => {
    runScript("install.sh", [dir, "--adapter=windsurf"]);
    const metadataPath = join(dir, ".ai-office/install.json");
    const versionFile = join(dir, ".windsurf/.version");
    writeFileSync(versionFile, "0.0.1");
    writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 1,
      version: "0.0.1",
      adapter: "windsurf",
      installedAt: "2026-03-23T00:00:00Z",
    }, null, 2));

    const proc = Bun.spawnSync(["bash", "update.sh", dir], {
      cwd: FRAMEWORK_DIR,
      stdin: new TextEncoder().encode("Y\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(readFileSync(versionFile, "utf8").trim()).toBe(readFileSync(join(FRAMEWORK_DIR, "VERSION"), "utf8").trim());

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata.adapter).toBe("windsurf");
    assertExists(join(dir, ".windsurf/rules/ai-office-workspace.md"));
    assertExists(join(dir, ".windsurf/workflows/office.md"));
  });

  it("updates an opencode install and preserves the opencode adapter", () => {
    runScript("install.sh", [dir, "--adapter=opencode"]);
    const metadataPath = join(dir, ".ai-office/install.json");
    const versionFile = join(dir, ".opencode/.version");
    writeFileSync(versionFile, "0.0.1");
    writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 1,
      version: "0.0.1",
      adapter: "opencode",
      installedAt: "2026-03-23T00:00:00Z",
    }, null, 2));

    const proc = Bun.spawnSync(["bash", "update.sh", dir], {
      cwd: FRAMEWORK_DIR,
      stdin: new TextEncoder().encode("Y\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(readFileSync(versionFile, "utf8").trim()).toBe(readFileSync(join(FRAMEWORK_DIR, "VERSION"), "utf8").trim());

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata.adapter).toBe("opencode");
    assertExists(join(dir, "opencode.json"));
    assertExists(join(dir, ".opencode/commands/office.md"));
  });

  it("can prune legacy adapter artifacts while keeping the active adapter healthy", () => {
    runScript("install.sh", [dir, "--adapter=windsurf"]);

    mkdirSync(join(dir, ".codex/skills/office-review"), { recursive: true });
    writeFileSync(join(dir, ".codex/skills/.version"), "0.0.1");
    writeFileSync(join(dir, ".codex/skills/office-review/SKILL.md"), "legacy codex skill");

    mkdirSync(join(dir, ".claude/skills/office-review"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/.version"), "0.0.1");
    writeFileSync(join(dir, ".claude/skills/office-review/SKILL.md"), "legacy claude skill");
    mkdirSync(join(dir, ".claude/commands"), { recursive: true });
    writeFileSync(join(dir, ".claude/commands/office-review.md"), "legacy claude command");
    writeFileSync(join(dir, ".claude/CLAUDE.md"), "legacy hidden claude instructions");
    writeFileSync(join(dir, "CLAUDE.md"), "legacy root claude instructions");
    writeFileSync(join(dir, ".claude/settings.json"), "{\"keep\":true}");

    writeFileSync(join(dir, ".windsurf/workflows/custom.md"), "# custom workflow");

    const proc = Bun.spawnSync(["bash", "update.sh", dir, "--adapter=windsurf", "--prune-legacy"], {
      cwd: FRAMEWORK_DIR,
      stdin: new TextEncoder().encode("Y\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(stdout).toContain("Legacy AI Office artifacts to prune");
    expect(stdout).toContain("Legacy adapter artifacts pruned");

    expect(existsSync(join(dir, ".codex/skills/office-review"))).toBe(false);
    expect(existsSync(join(dir, ".codex/skills/.version"))).toBe(false);
    expect(existsSync(join(dir, ".claude/skills/office-review"))).toBe(false);
    expect(existsSync(join(dir, ".claude/skills/.version"))).toBe(false);
    expect(existsSync(join(dir, ".claude/commands/office-review.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude/CLAUDE.md"))).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);

    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".windsurf/workflows/custom.md"))).toBe(true);
    expect(existsSync(join(dir, ".windsurf/workflows/office.md"))).toBe(true);

    const metadata = JSON.parse(readFileSync(join(dir, ".ai-office/install.json"), "utf8"));
    expect(metadata.adapter).toBe("windsurf");
  });
});

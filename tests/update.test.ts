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
    const versionFile = join(dir, ".codex/skills/.version");
    writeFileSync(versionFile, "0.0.1");

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
  });

  it("migrates a legacy Claude install version stamp to Codex", () => {
    rmSync(join(dir, ".codex"), { recursive: true, force: true });
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
    expect(existsSync(join(dir, ".codex/skills/.version"))).toBe(true);
  });

  it("preserves existing .ai-office/ structure after update", () => {
    writeFileSync(join(dir, ".codex/skills/.version"), "0.0.1");

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
});

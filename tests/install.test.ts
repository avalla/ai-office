import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { makeTempProject, runScript, assertExists, FRAMEWORK_DIR } from "./helpers";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = makeTempProject());
});

afterEach(() => {
  cleanup();
});

describe("install.sh", () => {
  it("exits 0 and prints success message", () => {
    const { exitCode, stdout } = runScript("install.sh", [dir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("installed successfully");
  });

  it("creates .claude/commands/office/ with all 18 commands", () => {
    runScript("install.sh", [dir]);
    const commandDir = join(dir, ".claude/commands/office");
    assertExists(commandDir);

    const files = readdirSync(commandDir).filter((f) => f.endsWith(".md"));
    const skeleton = readdirSync(join(FRAMEWORK_DIR, "skeleton/.claude/commands/office")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(skeleton.length);

    const expected = [
      "_meta.md", "advance.md", "agency.md", "ai-office.md", "doctor.md",
      "graph.md", "milestone.md", "report.md", "review.md", "route.md",
      "scaffold.md", "script.md", "setup.md", "status.md", "task-create.md",
      "task-list.md", "task-move.md", "validate.md",
    ];
    for (const name of expected) {
      expect(files).toContain(name);
    }
  });

  it("stamps the version file", () => {
    runScript("install.sh", [dir]);
    const versionFile = join(dir, ".claude/commands/office/.version");
    assertExists(versionFile);
    const installed = readFileSync(versionFile, "utf8").trim();
    const source = readFileSync(join(FRAMEWORK_DIR, "VERSION"), "utf8").trim();
    expect(installed).toBe(source);
  });

  it("creates the full .ai-office/ directory structure", () => {
    runScript("install.sh", [dir]);
    const required = [
      ".ai-office/tasks/BACKLOG",
      ".ai-office/tasks/TODO",
      ".ai-office/tasks/WIP",
      ".ai-office/tasks/REVIEW",
      ".ai-office/tasks/DONE",
      ".ai-office/tasks/ARCHIVED",
      ".ai-office/docs/prd",
      ".ai-office/docs/adr",
      ".ai-office/docs/runbooks",
      ".ai-office/agents",
      ".ai-office/agencies",
      ".ai-office/milestones",
      ".ai-office/scripts",
      ".ai-office/memory",
    ];
    for (const rel of required) {
      assertExists(join(dir, rel), rel);
    }
  });

  it("creates .ai-office/tasks/README.md with column counts", () => {
    runScript("install.sh", [dir]);
    const readme = join(dir, ".ai-office/tasks/README.md");
    assertExists(readme);
    const content = readFileSync(readme, "utf8");
    expect(content).toMatch(/BACKLOG:\s*0/);
    expect(content).toMatch(/TODO:\s*0/);
    expect(content).toMatch(/WIP:\s*0/);
  });

  it("creates .ai-office/office-config.md with Agency Identity section", () => {
    runScript("install.sh", [dir]);
    const config = join(dir, ".ai-office/office-config.md");
    assertExists(config);
    const content = readFileSync(config, "utf8");
    expect(content).toContain("Agency Identity");
  });

  it("does not overwrite existing office-config.md", () => {
    runScript("install.sh", [dir]);
    const config = join(dir, ".ai-office/office-config.md");
    const original = readFileSync(config, "utf8");
    Bun.write(config, original + "\n# Custom addition\n");
    runScript("install.sh", [dir]);
    const after = readFileSync(config, "utf8");
    expect(after).toContain("# Custom addition");
  });

  it("--stamp-only only writes the version file, skips everything else", () => {
    runScript("install.sh", [dir, "--stamp-only"]);
    assertExists(join(dir, ".claude/commands/office/.version"));
    const commandDir = join(dir, ".claude/commands/office");
    const mdFiles = readdirSync(commandDir).filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(0);
    expect(existsSync(join(dir, ".ai-office"))).toBe(false);
  });
});

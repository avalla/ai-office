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

  it("creates .codex/skills with all bundled office skills for the default codex adapter", () => {
    runScript("install.sh", [dir]);
    const skillsDir = join(dir, ".codex/skills");
    assertExists(skillsDir);

    const installed = readdirSync(skillsDir).filter((entry) => entry.startsWith("office"));
    const expected = [
      "office",
      "office-advance",
      "office-agency",
      "office-doctor",
      "office-graph",
      "office-meta",
      "office-milestone",
      "office-report",
      "office-review",
      "office-role",
      "office-route",
      "office-run-tests",
      "office-scaffold",
      "office-script",
      "office-setup",
      "office-status",
      "office-task-create",
      "office-task-integrate",
      "office-task-list",
      "office-task-move",
      "office-task-update",
      "office-validate",
      "office-validate-secrets",
      "office-verify",
    ];

    expect(installed.length).toBe(expected.length);

    for (const name of expected) {
      expect(installed).toContain(name);
      assertExists(join(skillsDir, name, "SKILL.md"));
    }
  });

  it("stamps the version file", () => {
    runScript("install.sh", [dir]);
    const versionFile = join(dir, ".codex/skills/.version");
    assertExists(versionFile);
    const installed = readFileSync(versionFile, "utf8").trim();
    const source = readFileSync(join(FRAMEWORK_DIR, "VERSION"), "utf8").trim();
    expect(installed).toBe(source);
  });

  it("installs AGENTS.md", () => {
    runScript("install.sh", [dir]);
    const agents = join(dir, "AGENTS.md");
    assertExists(agents);
    const content = readFileSync(agents, "utf8");
    expect(content).toContain("AI Office");
    expect(content).toContain("Codex");
  });

  it("installs the core AI-OFFICE.md guide", () => {
    runScript("install.sh", [dir]);
    const guide = join(dir, "AI-OFFICE.md");
    assertExists(guide);
    const content = readFileSync(guide, "utf8");
    expect(content).toContain("host-neutral contract");
    expect(content).toContain("adapter");
  });

  it("writes neutral install metadata", () => {
    runScript("install.sh", [dir]);
    const metadataPath = join(dir, ".ai-office/install.json");
    assertExists(metadataPath);
    const data = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(data.adapter).toBe("codex");
    expect(data.version).toBe(readFileSync(join(FRAMEWORK_DIR, "VERSION"), "utf8").trim());
    expect(data.schemaVersion).toBe(1);
  });

  it("creates the full .ai-office/ directory structure", () => {
    runScript("install.sh", [dir]);
    const required = [
      ".ai-office/tasks/BACKLOG",
      ".ai-office/tasks/TODO",
      ".ai-office/tasks/WIP",
      ".ai-office/tasks/REVIEW",
      ".ai-office/tasks/BLOCKED",
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

  it("creates .mcp.json at project root", () => {
    runScript("install.sh", [dir]);
    const mcp = join(dir, ".mcp.json");
    assertExists(mcp);
    const data = JSON.parse(readFileSync(mcp, "utf8"));
    expect(data.mcpServers).toBeDefined();
    expect(Object.keys(data.mcpServers)).toContain("fetch");
    expect(Object.keys(data.mcpServers)).toContain("supabase");
    expect(Object.keys(data.mcpServers)).toContain("playwright");
    expect(Object.keys(data.mcpServers)).toContain("snyk");
  });

  it("does not overwrite existing .mcp.json", () => {
    runScript("install.sh", [dir]);
    const mcp = join(dir, ".mcp.json");
    Bun.write(mcp, JSON.stringify({ mcpServers: { custom: {} } }));
    runScript("install.sh", [dir]);
    const after = JSON.parse(readFileSync(mcp, "utf8"));
    expect(after.mcpServers.custom).toBeDefined();
    expect(after.mcpServers.fetch).toBeUndefined();
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
    assertExists(join(dir, ".codex/skills/.version"));
    assertExists(join(dir, ".ai-office/install.json"));
    const skillsDir = join(dir, ".codex/skills");
    const skillDirs = readdirSync(skillsDir).filter((entry) => entry !== ".version");
    expect(skillDirs.length).toBe(0);
    expect(existsSync(join(dir, "AI-OFFICE.md"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("supports installing the base adapter without host-specific wrapper files", () => {
    runScript("install.sh", [dir, "--adapter=base"]);
    assertExists(join(dir, "AI-OFFICE.md"));
    assertExists(join(dir, ".ai-office/install.json"));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".codex"))).toBe(false);

    const metadata = JSON.parse(readFileSync(join(dir, ".ai-office/install.json"), "utf8"));
    expect(metadata.adapter).toBe("base");
  });

  it("supports installing the claude-code adapter", () => {
    runScript("install.sh", [dir, "--adapter=claude-code"]);
    assertExists(join(dir, "CLAUDE.md"));
    assertExists(join(dir, ".claude/skills/.version"));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".codex"))).toBe(false);

    const metadata = JSON.parse(readFileSync(join(dir, ".ai-office/install.json"), "utf8"));
    expect(metadata.adapter).toBe("claude-code");
  });

  it("supports installing the opencode adapter", () => {
    runScript("install.sh", [dir, "--adapter=opencode"]);
    assertExists(join(dir, "opencode.json"));
    assertExists(join(dir, ".opencode/.version"));
    assertExists(join(dir, ".opencode/commands/office.md"));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);

    const metadata = JSON.parse(readFileSync(join(dir, ".ai-office/install.json"), "utf8"));
    expect(metadata.adapter).toBe("opencode");
  });

  it("supports installing the windsurf adapter", () => {
    runScript("install.sh", [dir, "--adapter=windsurf"]);
    assertExists(join(dir, "AGENTS.md"));
    assertExists(join(dir, ".windsurf/.version"));
    assertExists(join(dir, ".windsurf/rules/ai-office-workspace.md"));
    assertExists(join(dir, ".windsurf/workflows/office.md"));
    expect(existsSync(join(dir, ".codex"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);

    const metadata = JSON.parse(readFileSync(join(dir, ".ai-office/install.json"), "utf8"));
    expect(metadata.adapter).toBe("windsurf");
  });
});

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "fs";
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
    expect(content).toContain("agency: software-studio");
    expect(content).toContain("project_name: test-project");
    expect(content).toContain("typecheck_cmd:");
    expect(content).toContain("lint_cmd:");
    expect(content).toContain("test_cmd:");
    expect(content).toContain("coverage_min:");
    expect(content).toContain("lighthouse_min:");
    expect(content).toContain("advance_mode:");
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

  it("copies all 5 bundled agency templates", () => {
    runScript("setup.sh", [
      dir,
      "--non-interactive",
      "--agency=software-studio",
      "--name=test-project",
    ]);
    const agencies = [
      "software-studio",
      "lean-startup",
      "game-studio",
      "creative-agency",
      "penetration-test-agency",
    ];
    for (const agency of agencies) {
      assertExists(join(dir, `.ai-office/agencies/${agency}`), agency);
      assertExists(join(dir, `.ai-office/agencies/${agency}/config.md`), `${agency}/config.md`);
    }
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
    expect(updated).toContain('dev_web_cmd: "bun run dev:web"');
    expect(updated).toContain('dev_queues_cmd: "bun run dev:queues"');
    expect(updated).toContain("> Preserved project note");
    expect(updated).toContain("> Second line");
    expect(updated).toContain("# Tech stack — used by $office-validate (dev stage)");
    expect(updated).toContain("# Design system — used by $office-review (UX sector)");
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

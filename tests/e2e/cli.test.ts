import { afterEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "@ai-office/runtime-host/runtime-command.ts";

const temporaryDirectories: string[] = [];

function createProjectRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-office-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function captureIo(answers: string[] = []): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
  prompts: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];

  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async (message) => {
        prompts.push(message);
        return answers.shift() ?? "";
      },
    },
    stdout,
    stderr,
    prompts,
  };
}

function prepareExistingProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(join(root, "README.md"), "# Existing project");
  writeFileSync(join(root, "index.ts"), "export const value = 1;");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "existing-project",
      devDependencies: { vitest: "latest" },
    }),
  );
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Project/Task CLI vertical slice", () => {
  test("creates a project and tasks, persists them, and lists them", async () => {
    const projectRoot = createProjectRoot();
    const projectOutput = captureIo();
    const projectExitCode = await runCli(["project:create", "Demo"], {
      projectRoot,
      io: projectOutput.io,
    });
    const projectId = projectOutput.stdout[0]?.replace("Project created: ", "");

    expect(projectExitCode).toBe(0);
    expect(typeof projectId).toBe("string");
    expect(existsSync(join(projectRoot, ".ai-office", "project.sqlite"))).toBe(
      true,
    );

    const lowOutput = captureIo();
    expect(
      await runCli(
        [
          "task:create",
          "--project",
          projectId ?? "",
          "--title",
          "Low",
          "--priority",
          "1",
        ],
        { projectRoot, io: lowOutput.io },
      ),
    ).toBe(0);

    const highOutput = captureIo();
    expect(
      await runCli(
        [
          "task:create",
          "--project",
          projectId ?? "",
          "--title",
          "High",
          "--priority",
          "10",
        ],
        { projectRoot, io: highOutput.io },
      ),
    ).toBe(0);

    const listOutput = captureIo();
    expect(
      await runCli(["task:list", "--project", projectId ?? ""], {
        projectRoot,
        io: listOutput.io,
      }),
    ).toBe(0);
    expect(listOutput.stdout[0]).toBe(
      "ID\tSTATUS\tREQUIREMENTS\tPRIORITY\tTITLE",
    );
    // No linked requirements yet, so the progress column is empty and the
    // status column carries no inconsistency marker.
    expect(listOutput.stdout[1]).toMatch(/\tpending\t—\t10\tHigh$/);
    expect(listOutput.stdout[2]).toMatch(/\tpending\t—\t1\tLow$/);
    expect(listOutput.stderr).toEqual([]);
  });

  test("prints a useful error and fails when the project does not exist", async () => {
    const output = captureIo();

    const exitCode = await runCli(
      ["task:create", "--project", "missing", "--title", "Orphan"],
      { projectRoot: createProjectRoot(), io: output.io },
    );

    expect(exitCode).toBe(1);
    expect(output.stderr).toEqual(["Project missing not found"]);
    expect(output.stdout).toEqual([]);
  });

  test("displays the imported profile and exports it deterministically", async () => {
    const projectRoot = prepareExistingProjectRoot();
    const importedOutput = captureIo();
    expect(
      await runCli(["project:import", projectRoot], {
        projectRoot,
        io: importedOutput.io,
      }),
    ).toBe(0);
    const projectId =
      importedOutput.stdout[0]?.replace("Project imported: ", "") ?? "";

    const profileOutput = captureIo();
    expect(
      await runCli(["project:profile", "--project", projectId], {
        projectRoot,
        io: profileOutput.io,
      }),
    ).toBe(0);
    expect(profileOutput.stdout[0]).toContain("## Detected facts");
    expect(profileOutput.stdout[0]).toContain("TypeScript");

    const exportOutput = captureIo();
    expect(
      await runCli(["project:export", "--project", projectId], {
        projectRoot,
        io: exportOutput.io,
      }),
    ).toBe(0);
    const outputPath = join(
      projectRoot,
      ".ai-office",
      "generated",
      "project-profile.md",
    );
    const firstExport = readFileSync(outputPath, "utf8");

    expect(
      await runCli(["project:export", "--project", projectId], {
        projectRoot,
        io: captureIo().io,
      }),
    ).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(firstExport);
    expect(firstExport).toBe(`${profileOutput.stdout[0]}\n`);
  });

  test("rejects removed provider-backed onboarding without reading provider configuration", async () => {
    vi.stubEnv("AI_OFFICE_LLM_MODEL", "anthropic:claude-sonnet-4-6");
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-be-read");
    const output = captureIo();

    expect(
      await runCli(["project:onboard", "--project", "legacy"], {
        projectRoot: createProjectRoot(),
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr[0]).toContain("Unknown command: project:onboard");
    expect(output.stderr[0]).not.toContain("ANTHROPIC_API_KEY");
    expect(output.stderr[0]).not.toContain("project:onboard --project");
  });

  test("applies the manifest byte limit to inline UTF-8 input", async () => {
    const oversizedManifest = JSON.stringify({
      padding: "é".repeat(128 * 1024),
    });
    const output = captureIo();

    expect(
      await runCli(["office:validate", "--manifest", oversizedManifest], {
        projectRoot: createProjectRoot(),
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr).toEqual([
      "Office manifest exceeds the 262144-byte limit",
    ]);
  });
});

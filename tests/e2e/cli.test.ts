import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../apps/cli/src/cli.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

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
      }
    },
    stdout,
    stderr,
    prompts
  };
}

function prepareExistingProjectRoot(): string {
  const root = createProjectRoot();
  writeFileSync(join(root, "README.md"), "# Existing project");
  writeFileSync(join(root, "index.ts"), "export const value = 1;");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "existing-project", devDependencies: { vitest: "latest" } })
  );
  return root;
}

afterEach(() => {
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
      io: projectOutput.io
    });
    const projectId = projectOutput.stdout[0]?.replace("Project created: ", "");

    expect(projectExitCode).toBe(0);
    expect(typeof projectId).toBe("string");
    expect(existsSync(join(projectRoot, ".ai-office", "project.sqlite"))).toBe(true);

    const lowOutput = captureIo();
    expect(
      await runCli(
        ["task:create", "--project", projectId ?? "", "--title", "Low", "--priority", "1"],
        { projectRoot, io: lowOutput.io }
      )
    ).toBe(0);

    const highOutput = captureIo();
    expect(
      await runCli(
        ["task:create", "--project", projectId ?? "", "--title", "High", "--priority", "10"],
        { projectRoot, io: highOutput.io }
      )
    ).toBe(0);

    const listOutput = captureIo();
    expect(
      await runCli(["task:list", "--project", projectId ?? ""], {
        projectRoot,
        io: listOutput.io
      })
    ).toBe(0);
    expect(listOutput.stdout[0]).toBe("ID\tSTATUS\tPRIORITY\tTITLE");
    expect(listOutput.stdout[1]).toMatch(/\tpending\t10\tHigh$/);
    expect(listOutput.stdout[2]).toMatch(/\tpending\t1\tLow$/);
    expect(listOutput.stderr).toEqual([]);
  });

  test("prints a useful error and fails when the project does not exist", async () => {
    const output = captureIo();

    const exitCode = await runCli(
      ["task:create", "--project", "missing", "--title", "Orphan"],
      { projectRoot: createProjectRoot(), io: output.io }
    );

    expect(exitCode).toBe(1);
    expect(output.stderr).toEqual(["Project missing not found"]);
    expect(output.stdout).toEqual([]);
  });

  test("answers a question, displays the categorized profile, and exports deterministically", async () => {
    const projectRoot = prepareExistingProjectRoot();
    const importedOutput = captureIo();
    expect(await runCli(["project:import", "."], { projectRoot, io: importedOutput.io })).toBe(0);
    const projectId = importedOutput.stdout[0]?.replace("Project imported: ", "") ?? "";

    const database = openDatabase(join(projectRoot, ".ai-office", "project.sqlite"));
    const goalQuestion = database
      .query<{ id: string }, []>(
        "SELECT id FROM project_question WHERE key = 'next_outcome' AND answer_json IS NULL"
      )
      .get();
    database.close();

    const answerOutput = captureIo();
    expect(
      await runCli(
        [
          "project:answer",
          "--project",
          projectId,
          "--question",
          goalQuestion?.id ?? "",
          "--answer",
          "Publish the onboarding milestone"
        ],
        { projectRoot, io: answerOutput.io }
      )
    ).toBe(0);
    expect(answerOutput.stdout[0]).toContain("(goal)");

    const profileOutput = captureIo();
    expect(
      await runCli(["project:profile", "--project", projectId], {
        projectRoot,
        io: profileOutput.io
      })
    ).toBe(0);
    expect(profileOutput.stdout[0]).toContain("## Detected facts");
    expect(profileOutput.stdout[0]).toContain("## Goals");
    expect(profileOutput.stdout[0]).toContain("Publish the onboarding milestone");

    const exportOutput = captureIo();
    expect(
      await runCli(["project:export", "--project", projectId], {
        projectRoot,
        io: exportOutput.io
      })
    ).toBe(0);
    const outputPath = join(projectRoot, ".ai-office", "generated", "project-profile.md");
    const firstExport = readFileSync(outputPath, "utf8");

    expect(
      await runCli(["project:export", "--project", projectId], {
        projectRoot,
        io: captureIo().io
      })
    ).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(firstExport);
    expect(firstExport).toBe(`${profileOutput.stdout[0]}\n`);
  });

  test("runs interactive onboarding one open question at a time", async () => {
    const projectRoot = prepareExistingProjectRoot();
    const importedOutput = captureIo();
    expect(await runCli(["project:import", "."], { projectRoot, io: importedOutput.io })).toBe(0);
    const projectId = importedOutput.stdout[0]?.replace("Project imported: ", "") ?? "";
    const onboardingOutput = captureIo([
      "Ship M1.5",
      "read_files,modify_files,run_tests",
      "Keep strict TypeScript"
    ]);

    expect(
      await runCli(["project:onboard", "--project", projectId], {
        projectRoot,
        io: onboardingOutput.io
      })
    ).toBe(0);
    expect(onboardingOutput.prompts).toEqual(["> ", "> ", "> "]);
    expect(onboardingOutput.stdout.filter((line) => line.startsWith("["))).toEqual([
      "[goal] Qual è il prossimo risultato concreto che vuoi ottenere?",
      "[permission] Quali operazioni possono eseguire autonomamente gli agenti?",
      "[constraint] Quali vincoli architetturali o tecnologici non devono essere modificati?"
    ]);

    const database = openDatabase(join(projectRoot, ".ai-office", "project.sqlite"));
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_question WHERE answer_json IS NULL"
        )
        .get()?.count
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_profile_entry WHERE origin = 'user'"
        )
        .get()?.count
    ).toBe(3);
    database.close();
  });
});

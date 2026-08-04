import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../apps/cli/src/cli.ts";

const temporaryDirectories: string[] = [];

function createProjectRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-office-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    },
    stdout,
    stderr
  };
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
    expect(projectId).toBeString();
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
    expect(listOutput.stdout[1]).toEndWith("\tpending\t10\tHigh");
    expect(listOutput.stdout[2]).toEndWith("\tpending\t1\tLow");
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
});

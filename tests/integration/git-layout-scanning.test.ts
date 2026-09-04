import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import {
  repositoryFactsFromProfile,
  repositorySignalsFromFacts,
  repositoryUnderstandingFingerprint,
} from "@ai-office/application/project-lifecycle/repository-understanding.ts";
import { classifyRepositoryMaturity } from "@ai-office/domain/project/project-handover.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { LocalProjectScanner } from "@ai-office/runtime-host/local-project-scanner.ts";

const temporaryDirectories: string[] = [];
const migrationDirectory = join(process.cwd(), "migrations", "project");
const remoteUrl = "https://example.test/team/app.git";

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "AI Office",
  GIT_AUTHOR_EMAIL: "ai-office@example.test",
  GIT_COMMITTER_NAME: "AI Office",
  GIT_COMMITTER_EMAIL: "ai-office@example.test",
  GIT_TERMINAL_PROMPT: "0",
};

function gitIsAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnvironment, stdio: "pipe" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ai-office-git-layout-")));
  temporaryDirectories.push(root);
  return root;
}

function writeSources(root: string, moduleCount: number): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  writeFileSync(join(root, "CONTRIBUTING.md"), "# Contributing\n");
  for (let index = 0; index < moduleCount; index += 1)
    writeFileSync(
      join(root, "src", `module-${index}.ts`),
      `export const value${index} = ${index};\n`,
    );
}

function committedRepository(moduleCount: number): string {
  const root = temporaryRoot();
  writeSources(root, moduleCount);
  git(root, "init", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial commit");
  git(root, "remote", "add", "origin", remoteUrl);
  return root;
}

function linkedWorktree(mainCheckout: string, branch: string): string {
  const parent = temporaryRoot();
  const worktree = join(parent, branch);
  git(mainCheckout, "worktree", "add", "-b", branch, worktree);
  return worktree;
}

function nestedWorktree(mainCheckout: string, branch: string): string {
  const worktree = join(mainCheckout, ".worktrees", branch);
  git(mainCheckout, "worktree", "add", "-b", branch, worktree);
  return worktree;
}

function importHarness() {
  const root = temporaryRoot();
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrationDirectory);
  const profiles = new SqliteProjectProfileRepository(database);
  const importer = new ImportProject(
    new SqliteProjectRepository(database),
    profiles,
    new LocalProjectScanner(),
    new SqliteRepositoryIdentityRepository(database),
    new CryptoIdGenerator(),
    new SystemClock(),
    new SqliteTransactionRunner(database),
  );
  return { database, profiles, importer };
}

async function importedFacts(rootPath: string) {
  const { database, profiles, importer } = importHarness();
  const imported = await importer.execute({ rootPath });
  const facts = repositoryFactsFromProfile(
    await profiles.listActiveProfileEntries(imported.projectId),
  );
  database.close();
  return facts;
}

const describeGit = gitIsAvailable() ? describe : describe.skip;

describeGit("LocalProjectScanner Git layout resolution", () => {
  test("reads branch, remote, and commit evidence from a standard checkout", async () => {
    const root = committedRepository(30);

    const scan = await new LocalProjectScanner().scan(root);

    expect(scan.currentBranch).toBe("main");
    expect(scan.remoteUrl).toBe(remoteUrl);
    expect(scan.hasCommitHistory).toBe(true);
  });

  test("reports no commit history for an initialised repository without commits", async () => {
    const root = temporaryRoot();
    writeSources(root, 5);
    git(root, "init", "-b", "main");

    const scan = await new LocalProjectScanner().scan(root);

    expect(scan.currentBranch).toBe("main");
    expect(scan.hasCommitHistory).toBe(false);
  });

  test("prefers the origin remote when several remotes are configured", async () => {
    const root = committedRepository(5);
    git(root, "remote", "rename", "origin", "temporary");
    git(root, "remote", "add", "upstream", "https://example.test/other/app.git");
    git(root, "remote", "rename", "temporary", "origin");

    const scan = await new LocalProjectScanner().scan(root);

    expect(scan.remoteUrl).toBe(remoteUrl);
  });

  test("resolves branch, remote, and history from a linked worktree", async () => {
    const mainCheckout = committedRepository(30);
    const worktree = linkedWorktree(mainCheckout, "feature");

    const scan = await new LocalProjectScanner().scan(worktree);

    expect(scan.currentBranch).toBe("feature");
    expect(scan.remoteUrl).toBe(remoteUrl);
    expect(scan.hasCommitHistory).toBe(true);
  });

  test("detects history from packed refs in the main checkout and a worktree", async () => {
    const mainCheckout = committedRepository(30);
    const worktree = linkedWorktree(mainCheckout, "packed");
    git(mainCheckout, "pack-refs", "--all");
    const scanner = new LocalProjectScanner();

    expect((await scanner.scan(mainCheckout)).hasCommitHistory).toBe(true);
    expect((await scanner.scan(worktree)).hasCommitHistory).toBe(true);
  });

  test("resolves a gitdir pointer without a common directory, as submodules use", async () => {
    const superProject = temporaryRoot();
    const module = join(superProject, "lib");
    mkdirSync(module, { recursive: true });
    writeSources(module, 10);
    git(module, "init", "-b", "main");
    git(module, "add", ".");
    git(module, "commit", "-m", "Initial commit");
    git(module, "remote", "add", "origin", remoteUrl);
    mkdirSync(join(superProject, ".git", "modules"), { recursive: true });
    renameSync(join(module, ".git"), join(superProject, ".git", "modules", "lib"));
    writeFileSync(join(module, ".git"), "gitdir: ../.git/modules/lib\n");

    const scan = await new LocalProjectScanner().scan(module);

    expect(scan.currentBranch).toBe("main");
    expect(scan.remoteUrl).toBe(remoteUrl);
    expect(scan.hasCommitHistory).toBe(true);
  });
});

describeGit("repository evidence with nested linked worktrees", () => {
  test("excludes a registered worktree that lives inside the scanned root", async () => {
    const mainCheckout = committedRepository(60);
    const scanner = new LocalProjectScanner();
    const before = await scanner.scan(mainCheckout);

    nestedWorktree(mainCheckout, "nested");
    const after = await scanner.scan(mainCheckout);

    expect(after.detectedFiles.length).toBe(before.detectedFiles.length);
    expect(after.detectedFiles).toEqual(before.detectedFiles);
  });

  test("scans a registered worktree normally when it is the scanned root", async () => {
    const mainCheckout = committedRepository(60);
    const worktree = nestedWorktree(mainCheckout, "nested");
    const scanner = new LocalProjectScanner();

    const scan = await scanner.scan(worktree);

    expect(scan.detectedFiles).toEqual(
      (await scanner.scan(mainCheckout)).detectedFiles,
    );
    expect(scan.currentBranch).toBe("nested");
  });

  test("excludes every registered worktree under the scanned root", async () => {
    const mainCheckout = committedRepository(60);
    const scanner = new LocalProjectScanner();
    const before = await scanner.scan(mainCheckout);

    nestedWorktree(mainCheckout, "first");
    nestedWorktree(mainCheckout, "second");
    git(mainCheckout, "worktree", "add", "-b", "third", join(mainCheckout, "review"));
    const after = await scanner.scan(mainCheckout);

    expect(after.detectedFiles).toEqual(before.detectedFiles);
  });

  test("ignores worktrees registered outside the scanned root", async () => {
    const mainCheckout = committedRepository(60);
    const scanner = new LocalProjectScanner();
    const before = await scanner.scan(mainCheckout);

    linkedWorktree(mainCheckout, "elsewhere");

    expect((await scanner.scan(mainCheckout)).detectedFiles).toEqual(
      before.detectedFiles,
    );
  });

  test("keeps a plain .worktrees directory that Git never registered", async () => {
    const root = temporaryRoot();
    writeSources(root, 10);
    mkdirSync(join(root, ".worktrees", "notes"), { recursive: true });
    writeFileSync(join(root, ".worktrees", "notes", "draft.ts"), "export const a = 1;\n");
    git(root, "init", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-m", "Initial commit");

    const scan = await new LocalProjectScanner().scan(root);

    expect(scan.detectedFiles).toContain(join(".worktrees", "notes", "draft.ts"));
  });
});

describeGit("handover facts across equivalent Git checkouts", () => {
  test("a linked worktree yields the same repository understanding as its main checkout", async () => {
    const mainCheckout = committedRepository(10);
    const worktree = linkedWorktree(mainCheckout, "handover");

    const fromMain = await importedFacts(mainCheckout);
    const fromWorktree = await importedFacts(worktree);

    expect(fromMain).not.toBeNull();
    expect(fromWorktree).not.toBeNull();
    expect(fromWorktree!.remoteUrl).toBe(fromMain!.remoteUrl);
    expect(fromMain!.hasCommitHistory).toBe(true);
    expect(fromWorktree!.hasCommitHistory).toBe(true);
    // Ten source files only reach "existing" through commit evidence, so a
    // worktree that lost its history would be misread as a new project.
    expect(
      classifyRepositoryMaturity(repositorySignalsFromFacts(fromMain!)),
    ).toBe("existing");
    expect(
      classifyRepositoryMaturity(repositorySignalsFromFacts(fromWorktree!)),
    ).toBe("existing");
    // The fingerprint describes the project, not how Git materialised it, so a
    // confirmed review must not go stale when work moves to a worktree.
    expect(repositoryUnderstandingFingerprint(fromWorktree!)).toBe(
      repositoryUnderstandingFingerprint(fromMain!),
    );
  });
  test("creating a nested worktree leaves the review fingerprint untouched", async () => {
    const mainCheckout = committedRepository(60);
    const { database, profiles, importer } = importHarness();
    const facts = async (projectId: string) =>
      repositoryFactsFromProfile(
        await profiles.listActiveProfileEntries(projectId),
      )!;
    const imported = await importer.execute({ rootPath: mainCheckout });
    const before = await facts(imported.projectId);

    nestedWorktree(mainCheckout, "review");
    await importer.execute({ rootPath: mainCheckout });
    const after = await facts(imported.projectId);

    expect(after.sourceFileCount).toBe(before.sourceFileCount);
    expect(after).toEqual(before);
    expect(classifyRepositoryMaturity(repositorySignalsFromFacts(after))).toBe(
      classifyRepositoryMaturity(repositorySignalsFromFacts(before)),
    );
    expect(repositoryUnderstandingFingerprint(after)).toBe(
      repositoryUnderstandingFingerprint(before),
    );

    // A real structural change must still move the fingerprint.
    for (let index = 0; index < 300; index += 1)
      writeFileSync(join(mainCheckout, "src", `service-${index}.py`), `VALUE = ${index}\n`);
    await importer.execute({ rootPath: mainCheckout });
    const changed = await facts(imported.projectId);

    expect(changed.sourceFileCount!).toBeGreaterThan(before.sourceFileCount!);
    expect(repositoryUnderstandingFingerprint(changed)).not.toBe(
      repositoryUnderstandingFingerprint(before),
    );
    database.close();
  });
});

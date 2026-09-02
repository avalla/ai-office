import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import {
  ConfirmRepositoryUnderstanding,
  RepositoryUnderstandingError,
} from "@ai-office/application/project-lifecycle/confirm-repository-understanding.ts";
import {
  AssessProjectHandover,
  type ProjectHandoverReport,
} from "@ai-office/application/project-lifecycle/assess-project-handover.ts";
import type {
  ManageProjectLifecycle,
  ProjectLifecycleStatus,
} from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { LocalProjectScanner } from "../../apps/cli/src/local-project-scanner.ts";

const temporaryDirectories: string[] = [];
const migrationDirectory = join(process.cwd(), "migrations", "project");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function repositoryFixture(moduleCount: number, withHistory = true): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-handover-evidence-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  writeFileSync(join(root, "CONTRIBUTING.md"), "# Contributing\n");
  for (let index = 0; index < moduleCount; index += 1)
    writeFileSync(
      join(root, "src", `module-${index}.ts`),
      `export const value${index} = ${index};\n`,
    );
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (withHistory)
    writeFileSync(
      join(root, ".git", "refs", "heads", "main"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
  return root;
}

function lifecycleStatus(
  projectId: string,
  root: string,
  office: ProjectLifecycleStatus["office"]["state"],
): ProjectLifecycleStatus {
  return {
    schemaVersion: 3,
    installed: true,
    health: "healthy",
    project: {
      id: projectId,
      name: "Fixture",
      root,
      repositoryIdentity: {
        id: "repo_fixture",
        path: join(root, ".ai-office", "project.json"),
        state: "valid",
      },
      runtimeAssociation: { projectId, state: "valid" },
    },
    runtime: {
      daemon: "reachable",
      home: root,
      authoritativeState: "available",
    },
    office: {
      state: office,
      onboarding: office === "configured" ? "not_tracked" : "not_completed",
      revision: 1,
      name: "Software delivery office",
      roles: ["Developer"],
    },
    clients: [],
    tasks: { open: 0, wip: 0 },
    issues: [],
  };
}

function harness(databasePath: string) {
  const database = openDatabase(databasePath);
  migrate(database, migrationDirectory);
  const profiles = new SqliteProjectProfileRepository(database);
  const projects = new SqliteProjectRepository(database);
  const ids = new CryptoIdGenerator();
  const clock = new SystemClock();
  const transactions = new SqliteTransactionRunner(database);
  const importer = new ImportProject(
    projects,
    profiles,
    new LocalProjectScanner(),
    new SqliteRepositoryIdentityRepository(database),
    ids,
    clock,
    transactions,
  );
  const confirm = new ConfirmRepositoryUnderstanding(
    projects,
    profiles,
    ids,
    clock,
    transactions,
  );
  const assess = (status: ProjectLifecycleStatus) =>
    new AssessProjectHandover({
      lifecycle: {
        status: async () => status,
      } as unknown as ManageProjectLifecycle,
      profiles,
      manifests: new SqliteOfficeManifestRepository(database),
      governance: new SqliteGovernanceRepository(database),
      tasks: new SqliteTaskRepository(database),
    }).fromStatus(status);
  return {
    database,
    profiles,
    projects,
    ids,
    clock,
    importer,
    confirm,
    assess,
  };
}

function databaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-handover-db-"));
  temporaryDirectories.push(root);
  return join(root, "project.sqlite");
}

function understanding(report: ProjectHandoverReport): string {
  return report.handover.dimensions.find(
    (dimension) => dimension.id === "repository_understanding",
  )!.state;
}

describe("handover repository review evidence", () => {
  test("records one active confirmation and supersedes the previous one", async () => {
    const root = repositoryFixture(30);
    const { database, profiles, importer, confirm } = harness(databaseRoot());
    const imported = await importer.execute({ rootPath: root });

    const first = await confirm.execute({
      projectId: imported.projectId,
      summary: "First review",
    });
    const second = await confirm.execute({
      projectId: imported.projectId,
      summary: "Second review",
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.scanId).not.toBeNull();
    const active = (
      await profiles.listActiveProfileEntries(imported.projectId)
    ).filter(
      (entry) =>
        entry.category === "handover" && entry.key === "repository_review",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.origin).toBe("user");
    expect(active[0]?.confirmedAt).toBeInstanceOf(Date);
    expect((active[0]?.value as { summary: string }).summary).toBe(
      "Second review",
    );
    database.close();
  });

  test("binds the confirmation to the latest recorded scan", async () => {
    const root = repositoryFixture(30);
    const { database, profiles, importer, confirm } = harness(databaseRoot());
    const imported = await importer.execute({ rootPath: root });
    await importer.execute({ rootPath: root });

    const latest = await profiles.findLatestScan(imported.projectId);
    const confirmation = await confirm.execute({
      projectId: imported.projectId,
      summary: "Reviewed",
    });

    expect(latest).not.toBeNull();
    expect(confirmation.scanId).toBe(latest!.id);
    database.close();
  });

  test("refuses to confirm a review for a project that was never scanned", async () => {
    const { database, projects, confirm, ids, clock } = harness(databaseRoot());
    const { Project } = await import("@ai-office/domain/project/project.ts");
    const project = Project.create({
      id: ids.generate(),
      name: "Unscanned",
      now: clock.now(),
    });
    await projects.save(project);

    await expect(
      confirm.execute({
        projectId: project.snapshot().id,
        summary: "Nothing to review",
      }),
    ).rejects.toBeInstanceOf(RepositoryUnderstandingError);
    database.close();
  });
});

describe("handover assessment against stored evidence", () => {
  test("an approved office alone leaves repository understanding unconfirmed", async () => {
    const root = repositoryFixture(30);
    const { database, importer, assess } = harness(databaseRoot());
    const imported = await importer.execute({ rootPath: root });

    const report = await assess(
      lifecycleStatus(imported.projectId, root, "configured"),
    );

    expect(understanding(report)).toBe("discovered");
    expect(report.handover.repository).toBe("existing");
    database.close();
  });

  test("a confirmed review becomes stale after a material re-import", async () => {
    const root = repositoryFixture(30);
    const { database, importer, confirm, assess } = harness(databaseRoot());
    const imported = await importer.execute({ rootPath: root });
    await confirm.execute({
      projectId: imported.projectId,
      summary: "TypeScript library",
    });
    expect(
      understanding(
        await assess(lifecycleStatus(imported.projectId, root, "configured")),
      ),
    ).toBe("ready");

    for (let index = 0; index < 300; index += 1)
      writeFileSync(
        join(root, "src", `service-${index}.py`),
        `VALUE = ${index}\n`,
      );
    await importer.execute({ rootPath: root });

    expect(
      understanding(
        await assess(lifecycleStatus(imported.projectId, root, "configured")),
      ),
    ).toBe("needs_input");
    database.close();
  });

  test("degrades to unknown maturity for projects imported before file evidence existed", async () => {
    const root = repositoryFixture(30);
    const { database, importer, confirm, assess } = harness(databaseRoot());
    const imported = await importer.execute({ rootPath: root });
    // Reproduce a project imported by an earlier release, which recorded no
    // file-count or commit-history evidence.
    database
      .prepare(
        `DELETE FROM project_profile_entry
         WHERE project_id = ? AND category = 'repository'
           AND key IN ('file_count', 'source_file_count', 'has_commit_history')`,
      )
      .run(imported.projectId);

    const before = await assess(
      lifecycleStatus(imported.projectId, root, "configured"),
    );
    expect(before.handover.repository).toBe("unknown");
    expect(understanding(before)).toBe("discovered");
    expect(before.handover.state).not.toBe("ready");

    // A confirmation recorded against legacy evidence still resolves, and a
    // later re-import that adds the missing evidence stales it honestly.
    await confirm.execute({
      projectId: imported.projectId,
      summary: "Legacy review",
    });
    expect(
      understanding(
        await assess(lifecycleStatus(imported.projectId, root, "configured")),
      ),
    ).toBe("ready");

    await importer.execute({ rootPath: root });
    const after = await assess(
      lifecycleStatus(imported.projectId, root, "configured"),
    );
    expect(after.handover.repository).toBe("existing");
    expect(understanding(after)).toBe("needs_input");
    database.close();
  });

  test("counts open goal and constraint questions as blocking", async () => {
    const root = repositoryFixture(30);
    const { database, profiles, importer, confirm, assess } =
      harness(databaseRoot());
    const imported = await importer.execute({ rootPath: root });
    await confirm.execute({
      projectId: imported.projectId,
      summary: "Reviewed",
    });
    const ids = new CryptoIdGenerator();
    await profiles.ensureQuestions([
      {
        id: ids.generate(),
        projectId: imported.projectId,
        key: "primary_goal",
        question: "What is the next outcome?",
        normalizedQuestion: "what is the next outcome",
        reason: "Product direction is missing",
        answerCategory: "goal",
        answerType: "text",
        priority: 10,
        source: "deterministic",
      },
      {
        id: ids.generate(),
        projectId: imported.projectId,
        key: "editor_preference",
        question: "Preferred commit style?",
        normalizedQuestion: "preferred commit style",
        reason: "Nice to have",
        answerCategory: "preference",
        answerType: "text",
        priority: 1,
        source: "deterministic",
      },
    ]);

    const report = await assess(
      lifecycleStatus(imported.projectId, root, "configured"),
    );

    expect(report.handover.openQuestions).toEqual({
      blocking: 1,
      advisory: 1,
    });
    expect(
      report.handover.recommendedActions.map((action) => action.id),
    ).toContain("answer_open_questions");
    expect(report.handover.state).not.toBe("ready");
    database.close();
  });
});

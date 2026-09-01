import { afterEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ManageProjectPortability } from "@ai-office/application/project-portability/manage-project-portability.ts";
import {
  createPortableProjectArchive,
  parsePortableProjectArchive,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { LocalProjectBindingAdapter } from "../../apps/cli/src/local-project-binding-adapter.ts";
import { LocalProjectScanner } from "../../apps/cli/src/local-project-scanner.ts";

const roots: string[] = [];
const migrations = join(process.cwd(), "migrations", "project");

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function openRuntime(root: string) {
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrations);
  const projects = new SqliteProjectRepository(database);
  const profiles = new SqliteProjectProfileRepository(database);
  const identities = new SqliteRepositoryIdentityRepository(database);
  const states = new SqliteProjectStateRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const ids = new CryptoIdGenerator();
  const clock = new SystemClock();
  const service = new ManageProjectPortability({
    projects,
    profiles,
    identities,
    states,
    bindings: new LocalProjectBindingAdapter(),
    scanner: new LocalProjectScanner(),
    transactions,
    ids,
    clock,
  });
  return {
    database,
    projects,
    profiles,
    identities,
    states,
    transactions,
    ids,
    clock,
    service,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project portability", () => {
  test("backs up and restores one logical project at a different machine path", async () => {
    const machineA = temporaryRoot("ai-office-portable-a-");
    const machineB = temporaryRoot("ai-office-portable-b-");
    const sourceA = temporaryRoot("ai-office-source-a-");
    const sourceB = temporaryRoot("ai-office-source-b-");
    writeFileSync(join(sourceA, "package.json"), '{"name":"portable"}\n');
    writeFileSync(join(sourceB, "package.json"), '{"name":"portable"}\n');

    const a = openRuntime(machineA);
    const imported = await new ImportProject(
      a.projects,
      a.profiles,
      new LocalProjectScanner(),
      a.identities,
      a.ids,
      a.clock,
      a.transactions,
    ).execute({ rootPath: sourceA });
    await new CreateTask(
      a.projects,
      new SqliteTaskRepository(a.database),
      a.ids,
      a.clock,
    ).execute({
      projectId: imported.projectId,
      title: "Portable task",
      priority: 7,
    });

    const first = await a.service.backup(imported.projectId);
    const serialized = serializePortableProjectArchive(first.archive);
    expect(serialized).not.toContain(sourceA);
    expect(serialized).not.toContain("project.sqlite");
    expect(first.archive.state.tasks).toEqual([
      expect.objectContaining({ title: "Portable task", priority: 7 }),
    ]);
    const repeated = await a.service.backup(imported.projectId);
    expect(repeated.revisionId).toBe(first.revisionId);
    expect(serializePortableProjectArchive(repeated.archive)).toBe(serialized);
    a.database.close();

    const b = openRuntime(machineB);
    const restored = await b.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: sourceB,
    });
    expect(restored.outcome).toBe("restored");
    expect(restored.projectId).not.toBe(imported.projectId);
    expect(restored.projectIdentity).toBe(first.projectIdentity);
    expect(
      JSON.parse(
        readFileSync(join(sourceB, ".ai-office", "project.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: first.projectIdentity,
    });
    expect(await b.states.loadPortableState(restored.projectId)).toEqual(
      first.archive.state,
    );
    const duplicate = await b.service.restore({
      archive: first.archive,
      rootPath: sourceB,
    });
    expect(duplicate.outcome).toBe("unchanged");
    b.database.close();
  });

  test("creates parented revisions and rejects rollback over changed local state", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-revision-");
    const source = temporaryRoot("ai-office-portable-source-");
    writeFileSync(join(source, "package.json"), '{"name":"portable"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await new ImportProject(
      runtime.projects,
      runtime.profiles,
      new LocalProjectScanner(),
      runtime.identities,
      runtime.ids,
      runtime.clock,
      runtime.transactions,
    ).execute({ rootPath: source });
    const first = await runtime.service.backup(imported.projectId);
    const independentHead = createPortableProjectArchive({
      state: first.archive.state,
      manifest: {
        ...first.archive.manifest,
        revision: {
          ...first.archive.manifest.revision,
          id: "rev_independent_same_state",
        },
      },
    });
    await expect(
      runtime.service.restore({ archive: independentHead, rootPath: source }),
    ).rejects.toThrow(`local head ${first.revisionId}`);
    await new CreateTask(
      runtime.projects,
      new SqliteTaskRepository(runtime.database),
      runtime.ids,
      runtime.clock,
    ).execute({ projectId: imported.projectId, title: "New local work" });
    const second = await runtime.service.backup(imported.projectId);
    expect(second.parentRevisionId).toBe(first.revisionId);
    await expect(
      runtime.service.restore({ archive: first.archive, rootPath: source }),
    ).rejects.toThrow("Restore conflict");
    runtime.database.close();
  });

  test("rejects a repository/archive identity mismatch before state mutation", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-source-runtime-");
    const source = temporaryRoot("ai-office-portable-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-target-runtime-");
    const target = temporaryRoot("ai-office-portable-target-");
    writeFileSync(join(source, "package.json"), '{"name":"origin"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"target"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const bindings = new LocalProjectBindingAdapter();
    await bindings.applyWrite(
      await bindings.planWrite(target, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: "repo_unrelated",
      }),
    );
    const destination = openRuntime(targetRuntime);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow("does not match archive project");
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(0);
    destination.database.close();
  });

  test("rejects restore into a checkout with different Git provenance", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-git-source-");
    const source = temporaryRoot("ai-office-portable-git-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-git-target-");
    const target = temporaryRoot("ai-office-portable-git-checkout-");
    for (const [root, remote] of [
      [source, "https://portable:must-not-export@example.test/team/source.git"],
      [target, "https://example.test/team/unrelated.git"],
    ] as const) {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        `[remote "origin"]\n  url = ${remote}\n`,
      );
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    const backup = await origin.service.backup(imported.projectId);
    expect(serializePortableProjectArchive(backup.archive)).not.toContain(
      "must-not-export",
    );
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow("Git remote does not match");
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(0);
    const bindings = new LocalProjectBindingAdapter();
    await bindings.applyWrite(
      await bindings.planWrite(target, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: backup.projectIdentity,
      }),
    );
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).resolves.toMatchObject({
      outcome: "restored",
      projectIdentity: backup.projectIdentity,
    });
    destination.database.close();
  });

  test("rolls back authoritative state when a restored entity conflicts", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-atomic-source-");
    const source = temporaryRoot("ai-office-portable-atomic-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-atomic-target-");
    const target = temporaryRoot("ai-office-portable-atomic-checkout-");
    writeFileSync(join(source, "package.json"), '{"name":"origin"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"target"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    await new CreateTask(
      origin.projects,
      new SqliteTaskRepository(origin.database),
      origin.ids,
      origin.clock,
    ).execute({ projectId: imported.projectId, title: "Colliding task" });
    const backup = await origin.service.backup(imported.projectId);
    const taskId = backup.archive.state.tasks[0]!.id;
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const now = "2026-09-01T00:00:00.000Z";
    destination.database
      .prepare(
        `INSERT INTO project(id, name, created_at, updated_at)
         VALUES ('unrelated', 'Unrelated', ?, ?)`,
      )
      .run(now, now);
    destination.database
      .prepare(
        `INSERT INTO task(
           id, project_id, title, status, priority, created_at, updated_at
         ) VALUES (?, 'unrelated', 'Existing', 'pending', 0, ?, ?)`,
      )
      .run(taskId, now, now);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow();
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(1);
    expect(
      await destination.identities.findProjectId(backup.projectIdentity),
    ).toBeNull();
    expect(
      await new LocalProjectBindingAdapter().inspect(target),
    ).toMatchObject({ status: "missing" });
    destination.database.close();
  });
});

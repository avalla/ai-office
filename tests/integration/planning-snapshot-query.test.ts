import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import {
  GetPlanningSnapshot,
  PlanningScopeNotFoundError,
} from "@ai-office/application/coordination/get-planning-snapshot.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";

const now = new Date("2026-10-16T08:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-planning-snapshot-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  let sequence = 0;
  const ids = {
    generate: () => `id-${String((sequence += 1)).padStart(3, "0")}`,
  };
  const clock = { now: () => new Date(now) };
  const governance = new ManageGovernance(
    storage.projects,
    storage.governance,
    ids,
    clock,
  );
  async function project(id: string): Promise<void> {
    await storage.projects.save(Project.create({ id, name: id, now }));
  }
  async function task(projectId: string, id: string, priority = 0) {
    await storage.tasks.save(
      Task.create({
        id,
        projectId,
        title: `Title ${id}`,
        description: `SECRET-DESCRIPTION ${id}`,
        priority,
        now,
      }),
    );
  }
  async function link(
    projectId: string,
    taskId: string,
    requirementId: string,
  ) {
    expect(
      await storage.taskRequirements.link({
        projectId,
        taskId,
        requirementId,
        now,
      }),
    ).toBe(true);
  }
  async function depend(
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ) {
    await storage.taskDependencies.link({
      projectId,
      taskId,
      dependsOnTaskId,
      createdAt: now,
    });
  }
  return {
    database,
    storage,
    governance,
    project,
    task,
    link,
    depend,
    service: new GetPlanningSnapshot(storage.planningReads),
  };
}

describe("planning snapshot over SQLite", () => {
  test("reads one project's planning state and never its descriptions", async () => {
    const f = await fixture();
    await f.project("p");
    await f.project("other");
    const m1 = await f.governance.createMilestone({
      projectId: "p",
      title: "M1",
      description: "SECRET-MILESTONE",
    });
    const archived = await f.governance.createMilestone({
      projectId: "p",
      title: "Old",
    });
    f.database
      .prepare(
        "UPDATE milestone SET status = 'completed', archived_at = ? WHERE id = ?",
      )
      .run(now.toISOString(), archived);
    const r1 = await f.governance.createRequirement({
      projectId: "p",
      key: "R-1",
      title: "Req",
      description: "SECRET-REQUIREMENT",
      milestoneId: m1,
    });
    await f.task("p", "a", 2);
    await f.task("p", "b", 1);
    await f.task("other", "x");
    await f.link("p", "a", r1);
    await f.depend("p", "b", "a");

    const milestones = await f.service.execute({
      projectId: "p",
      collection: "milestones",
    });
    expect(milestones.items).toEqual([
      { milestoneId: m1, title: "M1", status: "planned" },
      { milestoneId: archived, title: "Old", status: "archived" },
    ]);
    const tasks = await f.service.execute({ projectId: "p" });
    expect(tasks.items).toEqual([
      {
        taskId: "a",
        title: "Title a",
        status: "pending",
        priority: 2,
        milestoneIds: [m1],
        requirementIds: [r1],
        prerequisiteIds: [],
      },
      {
        taskId: "b",
        title: "Title b",
        status: "pending",
        priority: 1,
        milestoneIds: [],
        requirementIds: [],
        prerequisiteIds: ["a"],
      },
    ]);
    const requirements = await f.service.execute({
      projectId: "p",
      collection: "requirements",
    });
    expect(requirements.items).toEqual([
      {
        requirementId: r1,
        key: "R-1",
        title: "Req",
        status: "proposed",
        milestoneId: m1,
        taskIds: ["a"],
      },
    ]);
    const all = JSON.stringify([milestones, tasks, requirements]);
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain('"x"');
    expect(
      new Set([milestones, tasks, requirements].map((p) => p.snapshotId)).size,
    ).toBe(1);

    const scoped = await f.service.execute({ projectId: "p", milestoneId: m1 });
    expect(
      scoped.items.map((item) => (item as { taskId: string }).taskId),
    ).toEqual(["a"]);
    expect(scoped.snapshotId).not.toBe(tasks.snapshotId);
  });

  test("returns byte-identical output for unchanged state and a new identity after a write", async () => {
    const f = await fixture();
    await f.project("p");
    await f.task("p", "a");
    await f.task("p", "b");
    const first = JSON.stringify(await f.service.execute({ projectId: "p" }));
    expect(JSON.stringify(await f.service.execute({ projectId: "p" }))).toBe(
      first,
    );
    await f.depend("p", "b", "a");
    const after = await f.service.execute({ projectId: "p" });
    expect(after.snapshotId).not.toBe(JSON.parse(first).snapshotId);
    expect(after.counts.dependencies).toBe(1);
  });

  test("reports an unknown project or a milestone of another project as not found", async () => {
    const f = await fixture();
    await f.project("p");
    await f.project("other");
    const foreign = await f.governance.createMilestone({
      projectId: "other",
      title: "Foreign",
    });
    await expect(
      f.service.execute({ projectId: "missing" }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      f.service.execute({ projectId: "p", milestoneId: foreign }),
    ).rejects.toBeInstanceOf(PlanningScopeNotFoundError);
  });

  test("writes nothing on read", async () => {
    const f = await fixture();
    await f.project("p");
    await f.task("p", "a");
    const count = () =>
      f.database
        .query<{ n: number }, []>("SELECT COUNT(*) n FROM audit_event")
        .get()!.n;
    const before = count();
    await f.service.execute({ projectId: "p", collection: "decisions" });
    expect(count()).toBe(before);
  });
});

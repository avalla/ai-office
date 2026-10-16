/**
 * The coordination read service over real SQLite storage (CB-10), and the
 * planning read refusing to observe a writer's open transaction on the
 * shared connection.
 */

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import { GetPlanningSnapshot } from "@ai-office/application/coordination/get-planning-snapshot.ts";
import {
  CoordinationReadService,
  type CoordinationCollectionResponse,
} from "@ai-office/application/coordination/coordination-read-service.ts";
import { PlanningReadBusyError } from "@ai-office/application/ports/planning-read.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";

const now = new Date("2026-10-16T08:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function open() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-coordination-read-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  return { database, storage: createSqliteProjectStorage(database) };
}

function task(projectId: string, id: string, priority = 0): Task {
  return Task.create({
    id,
    projectId,
    title: `Title ${id}`,
    description: `SECRET-DESCRIPTION ${id}`,
    priority,
    now,
  });
}

describe("coordination read service over SQLite", () => {
  test("reads committed planning state through the shared service", async () => {
    const { database, storage } = open();
    try {
      await storage.projects.save(Project.create({ id: "p", name: "p", now }));
      await storage.tasks.save(task("p", "t1", 2));
      await storage.tasks.save(task("p", "t2", 1));
      const reads = new CoordinationReadService(
        new GetPlanningSnapshot(storage.planningReads),
      );
      const page = (await reads.execute({
        projectId: "p",
        operation: "tasks",
      })) as CoordinationCollectionResponse;
      expect(page.items.map((item) => item.taskId)).toEqual(["t1", "t2"]);
      expect(JSON.stringify(page)).not.toContain("SECRET");
    } finally {
      database.close();
    }
  });

  test("refuses to read inside an open writer transaction and reads after it", async () => {
    const { database, storage } = open();
    try {
      await storage.projects.save(Project.create({ id: "p", name: "p", now }));
      const reads = new CoordinationReadService(
        new GetPlanningSnapshot(storage.planningReads),
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      // A writer that keeps its transaction open across an await, as the
      // Runtime's transaction runner does, and then rolls back.
      const writer = new SqliteTransactionRunner(database)
        .run(async () => {
          await storage.tasks.save(task("p", "uncommitted"));
          entered();
          await held;
          throw new Error("roll back");
        })
        .catch(() => undefined);
      await inside;
      await expect(
        reads.execute({ projectId: "p", operation: "tasks" }),
      ).rejects.toBeInstanceOf(PlanningReadBusyError);
      release();
      await writer;
      const page = (await reads.execute({
        projectId: "p",
        operation: "tasks",
      })) as CoordinationCollectionResponse;
      // The rolled-back task was never observed.
      expect(page.items).toEqual([]);
    } finally {
      database.close();
    }
  });
});

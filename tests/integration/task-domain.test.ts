import { describe, expect, test } from "bun:test";
import { Task } from "@ai-office/domain/task/task.ts";

describe("Task", () => {
  test("moves from pending to running to completed", () => {
    const createdAt = new Date("2026-08-05T00:00:00.000Z");
    const startedAt = new Date("2026-08-05T00:01:00.000Z");
    const completedAt = new Date("2026-08-05T00:02:00.000Z");

    const task = Task.create({
      id: "task-1",
      projectId: "project-1",
      title: "Implement vertical slice",
      now: createdAt
    });

    task.start(startedAt);
    expect(task.snapshot().status).toBe("running");

    task.complete(completedAt);
    expect(task.snapshot().status).toBe("completed");
  });
});

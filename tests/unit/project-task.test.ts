import { describe, expect, test } from "vitest";
import { DomainValidationError, InvalidTaskTransitionError } from "@ai-office/domain/errors.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";

const now = new Date("2026-08-05T00:00:00.000Z");

describe("Project", () => {
  test("trims its name", () => {
    const project = Project.create({ id: "project-1", name: "  Demo  ", now });

    expect(project.snapshot().name).toBe("Demo");
  });

  test("rejects an empty name", () => {
    expect(() => Project.create({ id: "project-1", name: "  ", now })).toThrow(
      DomainValidationError
    );
  });
});

describe("Task", () => {
  test("moves from pending to running to completed", () => {
    const task = Task.create({
      id: "task-1",
      projectId: "project-1",
      title: "Implement vertical slice",
      now
    });

    task.start(new Date("2026-08-05T00:01:00.000Z"));
    expect(task.snapshot().status).toBe("running");

    task.complete(new Date("2026-08-05T00:02:00.000Z"));
    expect(task.snapshot().status).toBe("completed");
  });

  test("rejects an invalid transition", () => {
    const task = Task.create({
      id: "task-1",
      projectId: "project-1",
      title: "Implement vertical slice",
      now
    });

    expect(() => task.complete(now)).toThrow(InvalidTaskTransitionError);
  });

  test("rejects a non-integer priority", () => {
    expect(() =>
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Implement vertical slice",
        priority: 1.5,
        now
      })
    ).toThrow(DomainValidationError);
  });

  test("defaults priority to zero and accepts negative priorities", () => {
    const base = { projectId: "project-1", title: "Order me", now };
    expect(Task.create({ id: "task-1", ...base }).snapshot().priority).toBe(0);
    expect(
      Task.create({ id: "task-2", priority: -3, ...base }).snapshot().priority,
    ).toBe(-3);
  });

  test("updates priority without changing lifecycle state", () => {
    const task = Task.create({
      id: "task-1",
      projectId: "project-1",
      title: "Reprioritize",
      description: "Keep me",
      priority: 1,
      now,
    });
    task.start(now);
    const later = new Date("2026-08-05T00:05:00.000Z");

    task.updatePriority(-7, later);

    expect(task.snapshot()).toMatchObject({
      status: "running",
      description: "Keep me",
      priority: -7,
      updatedAt: later,
    });
  });

  test.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses to update priority to %s and leaves the task unchanged",
    (priority) => {
      const task = Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Reprioritize",
        priority: 4,
        now,
      });

      expect(() =>
        task.updatePriority(priority, new Date("2026-08-05T00:05:00.000Z")),
      ).toThrow(new DomainValidationError("Task priority must be a safe integer"));
      expect(task.snapshot()).toMatchObject({ priority: 4, updatedAt: now });
    },
  );
});

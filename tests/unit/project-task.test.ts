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

  const rangeError = new DomainValidationError(
    "Task priority must be an integer between -2147483648 and 2147483647",
  );
  const accepted = [-2147483648, 0, 2147483647];
  const refused = [
    -2147483649,
    2147483648,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  test.each(accepted)("creates a task with priority %s", (priority) => {
    expect(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Order me",
        priority,
        now,
      }).snapshot().priority,
    ).toBe(priority);
  });

  test.each(refused)("refuses to create a task with priority %s", (priority) => {
    expect(() =>
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Order me",
        priority,
        now,
      }),
    ).toThrow(rangeError);
  });

  test("defaults priority to zero and stores negative zero as zero", () => {
    const base = { projectId: "project-1", title: "Order me", now };
    expect(Task.create({ id: "task-1", ...base }).snapshot().priority).toBe(0);
    expect(
      Object.is(
        Task.create({ id: "task-2", priority: -0, ...base }).snapshot()
          .priority,
        0,
      ),
    ).toBe(true);
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

  test.each(accepted)("updates priority to %s", (priority) => {
    const task = Task.create({
      id: "task-1",
      projectId: "project-1",
      title: "Reprioritize",
      priority: 4,
      now,
    });
    task.updatePriority(priority, new Date("2026-08-05T00:05:00.000Z"));
    expect(task.snapshot().priority).toBe(priority);
  });

  test.each(refused)(
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
      ).toThrow(rangeError);
      expect(task.snapshot()).toMatchObject({ priority: 4, updatedAt: now });
    },
  );
});

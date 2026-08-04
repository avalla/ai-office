import { describe, expect, test } from "bun:test";
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
});

import { describe, expect, test } from "vitest";
import { blockingPrerequisites } from "@ai-office/domain/task/task-dependency.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";

const statuses = new Map<string, TaskStatus>([
  ["done", "completed"],
  ["review", "waiting_review"],
  ["running", "running"],
  ["blocked", "blocked"],
]);

describe("blockingPrerequisites requirement", () => {
  test("start accepts completed and review-submitted prerequisites", () => {
    expect(
      blockingPrerequisites("t", ["done", "review"], statuses, "start"),
    ).toEqual([]);
    // Start is the default, so existing callers keep their behavior.
    expect(blockingPrerequisites("t", ["review"], statuses)).toEqual([]);
    expect(
      blockingPrerequisites("t", ["running", "blocked"], statuses, "start"),
    ).toEqual([
      { taskId: "running", status: "running" },
      { taskId: "blocked", status: "blocked" },
    ]);
  });

  test("completion requires every prerequisite completed", () => {
    expect(
      blockingPrerequisites("t", ["done"], statuses, "completion"),
    ).toEqual([]);
    expect(
      blockingPrerequisites("t", ["done", "review"], statuses, "completion"),
    ).toEqual([{ taskId: "review", status: "waiting_review" }]);
  });

  test("a missing prerequisite is an error under both requirements", () => {
    for (const requirement of ["start", "completion"] as const)
      expect(() =>
        blockingPrerequisites("t", ["absent"], statuses, requirement),
      ).toThrow("does not exist");
  });
});

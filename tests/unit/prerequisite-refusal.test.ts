import { expect, test } from "vitest";
import {
  isPrerequisiteRefusal,
  TaskPrerequisiteIncompleteError,
} from "@ai-office/application/commands/manage-task-dependencies.ts";

test("recognizes the typed refusal and the storage guard refusal only", () => {
  expect(
    isPrerequisiteRefusal(
      new TaskPrerequisiteIncompleteError(
        "t",
        [{ taskId: "p", status: "waiting_review" }],
        "completion",
      ),
    ),
  ).toBe(true);
  expect(
    isPrerequisiteRefusal(new Error("task has incomplete prerequisites")),
  ).toBe(true);
  expect(isPrerequisiteRefusal(new Error("disk full"))).toBe(false);
  expect(isPrerequisiteRefusal("task has incomplete prerequisites")).toBe(
    false,
  );
});

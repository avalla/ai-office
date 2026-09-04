/**
 * The task lifecycle as a whole.
 *
 * `task.status` is authoritative operational state, so these tests pin two
 * things: every declared status is reachable through a named transition, and no
 * terminal status can ever be left. The second is the invariant that stops a
 * board from fabricating project history.
 */

import { describe, expect, test } from "vitest";
import {
  InvalidTaskCorrectionError,
  InvalidTaskTransitionError,
} from "@ai-office/domain/errors.ts";
import {
  allowedTaskTransitions,
  isHistoricalCompletionApplicable,
  isTaskTransitionAllowed,
  isTerminalTaskStatus,
  maximumTaskReasonLength,
  normalizeTaskReason,
  Task,
  terminalTaskStatuses,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";

const now = new Date("2026-09-04T10:00:00.000Z");
const later = (minutes: number): Date =>
  new Date(now.getTime() + minutes * 60_000);

const everyStatus: readonly TaskStatus[] = [
  "pending",
  "assigned",
  "running",
  "blocked",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
];

function task(status: TaskStatus = "pending"): Task {
  const value = Task.create({
    id: "task-1",
    projectId: "project-1",
    title: "Implement vertical slice",
    now,
  });
  if (status === "pending") return value;
  return Task.restore({ ...value.snapshot(), status });
}

describe("task transition table", () => {
  test("declares transitions for every status", () => {
    for (const status of everyStatus)
      expect(Array.isArray(allowedTaskTransitions(status))).toBe(true);
  });

  test("no transition leaves a terminal status", () => {
    for (const status of terminalTaskStatuses()) {
      expect(isTerminalTaskStatus(status)).toBe(true);
      expect(allowedTaskTransitions(status)).toEqual([]);
      for (const target of everyStatus)
        expect(isTaskTransitionAllowed(status, target)).toBe(false);
    }
  });

  test("every non-terminal status can reach a terminal one", () => {
    for (const status of everyStatus) {
      if (isTerminalTaskStatus(status)) continue;
      expect(
        allowedTaskTransitions(status).some(isTerminalTaskStatus),
      ).toBe(true);
    }
  });

  test("every status except assigned is reachable by some transition", () => {
    const reachable = new Set<TaskStatus>(["pending"]);
    for (const from of everyStatus)
      for (const to of allowedTaskTransitions(from)) reachable.add(to);
    for (const status of everyStatus) {
      // `assigned` has no transition into it on purpose: the aggregate holds no
      // assignee, so the state could not say who it is assigned to.
      if (status === "assigned") {
        expect(reachable.has(status)).toBe(false);
        continue;
      }
      expect(reachable.has(status)).toBe(true);
    }
  });
});

describe("Task transitions", () => {
  test("runs the full happy path through review", () => {
    const value = task();
    value.start(later(1));
    expect(value.snapshot().status).toBe("running");
    value.submitForReview(later(2));
    expect(value.snapshot().status).toBe("waiting_review");
    value.complete(later(3));
    expect(value.snapshot().status).toBe("completed");
    expect(value.snapshot().updatedAt).toEqual(later(3));
  });

  test("blocks and unblocks back to pending", () => {
    const value = task();
    value.start(later(1));
    value.block(later(2));
    expect(value.snapshot().status).toBe("blocked");
    // Back to `pending`, not to `running`: the aggregate keeps no previous
    // status and inventing one would invent history.
    value.unblock(later(3));
    expect(value.snapshot().status).toBe("pending");
    value.start(later(4));
    expect(value.snapshot().status).toBe("running");
  });

  test("fails only once work has begun", () => {
    expect(() => task("pending").fail(later(1))).toThrow(
      InvalidTaskTransitionError,
    );
    const running = task("running");
    running.fail(later(1));
    expect(running.snapshot().status).toBe("failed");
    const blocked = task("blocked");
    blocked.fail(later(1));
    expect(blocked.snapshot().status).toBe("failed");
  });

  test("cancels from every non-terminal status and from no terminal one", () => {
    for (const status of everyStatus) {
      const value = task(status);
      if (isTerminalTaskStatus(status)) {
        expect(() => value.cancel(later(1))).toThrow(
          InvalidTaskTransitionError,
        );
        continue;
      }
      value.cancel(later(1));
      expect(value.snapshot().status).toBe("cancelled");
    }
  });

  test("refuses to reverse any terminal status", () => {
    for (const status of terminalTaskStatuses()) {
      const value = task(status);
      for (const attempt of [
        () => value.start(later(1)),
        () => value.submitForReview(later(1)),
        () => value.complete(later(1)),
        () => value.block(later(1)),
        () => value.unblock(later(1)),
        () => value.fail(later(1)),
        () => value.cancel(later(1)),
      ])
        expect(attempt).toThrow(InvalidTaskTransitionError);
      // Nothing was written, not even the timestamp.
      expect(value.snapshot().status).toBe(status);
      expect(value.snapshot().updatedAt).toEqual(now);
    }
  });

  test("names the allowed transitions when it refuses one", () => {
    try {
      task("pending").complete(later(1));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTaskTransitionError);
      const failure = error as InvalidTaskTransitionError;
      expect(failure.from).toBe("pending");
      expect(failure.to).toBe("completed");
      expect(failure.allowed).toEqual(["running", "blocked", "cancelled"]);
      expect(failure.message).toContain("running, blocked, cancelled");
    }
  });

  test("says a terminal status is terminal rather than listing nothing", () => {
    try {
      task("completed").start(later(1));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as InvalidTaskTransitionError).message).toContain(
        "completed is terminal",
      );
    }
  });
});

/**
 * Historical completion correction.
 *
 * The correction exists because the transition table deliberately refuses
 * `pending -> completed`. These tests pin that it did not become a way around
 * the table: it is narrower than the lifecycle everywhere, it never touches a
 * terminal status, and it is unavailable precisely where `task:complete` works.
 */
describe("historical completion correction", () => {
  test("applies exactly where the lifecycle cannot reach completed", () => {
    for (const status of everyStatus)
      expect(isHistoricalCompletionApplicable(status)).toBe(
        status === "pending" || status === "assigned" || status === "blocked",
      );
  });

  test("is derived from the transition table rather than restated", () => {
    for (const status of everyStatus) {
      const reachable = isTaskTransitionAllowed(status, "completed");
      const terminal = isTerminalTaskStatus(status);
      // The correction never overlaps a legal transition and never touches a
      // terminal status. Those two facts are the whole guard.
      expect(isHistoricalCompletionApplicable(status)).toBe(
        !terminal && !reachable,
      );
    }
  });

  test("records completion without passing through running", () => {
    const value = task("pending");
    value.recordHistoricalCompletion(later(1));
    const snapshot = value.snapshot();
    expect(snapshot.status).toBe("completed");
    expect(snapshot.updatedAt).toEqual(later(1));
  });

  test("refuses every terminal status", () => {
    for (const status of terminalTaskStatuses()) {
      const value = task(status);
      expect(() => value.recordHistoricalCompletion(later(1))).toThrow(
        InvalidTaskCorrectionError,
      );
      expect(value.snapshot().status).toBe(status);
    }
  });

  test("refuses a status the ordinary lifecycle already completes", () => {
    for (const status of ["running", "waiting_review"] as const) {
      const value = task(status);
      try {
        value.recordHistoricalCompletion(later(1));
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTaskCorrectionError);
        expect((error as InvalidTaskCorrectionError).message).toContain(
          "use task:complete",
        );
      }
      expect(value.snapshot().status).toBe(status);
    }
  });

  test("leaves the transition table untouched", () => {
    // The correction must not have been implemented by widening the table: if
    // it had, `task:complete` would work from pending for every future task.
    expect(allowedTaskTransitions("pending")).not.toContain("completed");
    expect(allowedTaskTransitions("assigned")).not.toContain("completed");
    expect(allowedTaskTransitions("blocked")).not.toContain("completed");
    expect(() => task("pending").complete(later(1))).toThrow(
      InvalidTaskTransitionError,
    );
  });
});

describe("lifecycle rationale", () => {
  test("refuses a blank or whitespace-only reason", () => {
    for (const value of ["", "   ", "\t\n"])
      expect(() => normalizeTaskReason(value, "block reason")).toThrow(
        /block reason cannot be empty/u,
      );
  });

  test("bounds the length and trims what it keeps", () => {
    expect(normalizeTaskReason("  waiting on vendor  ", "block reason")).toBe(
      "waiting on vendor",
    );
    expect(
      normalizeTaskReason("x".repeat(maximumTaskReasonLength), "fail reason"),
    ).toHaveLength(maximumTaskReasonLength);
    expect(() =>
      normalizeTaskReason("x".repeat(maximumTaskReasonLength + 1), "fail reason"),
    ).toThrow(/cannot exceed 2000 characters/u);
    // Trimming happens before the bound, so surrounding space cannot push a
    // legitimate reason over it.
    expect(
      normalizeTaskReason(` ${"x".repeat(maximumTaskReasonLength)} `, "fail reason"),
    ).toHaveLength(maximumTaskReasonLength);
  });
});

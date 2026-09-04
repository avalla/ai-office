/**
 * The task lifecycle as a whole.
 *
 * `task.status` is authoritative operational state, so these tests pin two
 * things: every declared status is reachable through a named transition, and no
 * terminal status can ever be left. The second is the invariant that stops a
 * board from fabricating project history.
 */

import { describe, expect, test } from "vitest";
import { InvalidTaskTransitionError } from "@ai-office/domain/errors.ts";
import {
  allowedTaskTransitions,
  isTaskTransitionAllowed,
  isTerminalTaskStatus,
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

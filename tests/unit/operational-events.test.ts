import { describe, expect, test } from "vitest";
import {
  OperationalEventBus,
  OperationalEventBusFullError,
} from "@ai-office/application/events/operational-event-bus.ts";
import {
  commandInvalidationTopics,
  parseBoolean,
  parseIdentifier,
  parseLimit,
  queryLimits,
  QueryValidationError,
} from "@ai-office/application/protocol/query-protocol.ts";
import type { QueryEvent } from "@ai-office/application/protocol/query-protocol.ts";

const clock = () => new Date("2026-09-03T12:00:00.000Z");

describe("operational event bus", () => {
  test("delivers every published topic to every subscriber", () => {
    const bus = new OperationalEventBus({ now: clock });
    const first: QueryEvent[] = [];
    const second: QueryEvent[] = [];
    bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));

    bus.publish(["task.updated", "activity.created"], { projectId: "p-1" });

    expect(first.map((event) => event.topic)).toEqual([
      "task.updated",
      "activity.created",
    ]);
    expect(second).toHaveLength(2);
    expect(first[0]).toEqual({
      topic: "task.updated",
      projectId: "p-1",
      occurredAt: "2026-09-03T12:00:00.000Z",
    });
  });

  test("omits projectId when the change is not project scoped", () => {
    const bus = new OperationalEventBus({ now: clock });
    const received: QueryEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.publish(["activity.created"]);
    expect(received[0]).not.toHaveProperty("projectId");
  });

  test("unsubscribing removes the listener and is idempotent", () => {
    const bus = new OperationalEventBus({ now: clock });
    const received: QueryEvent[] = [];
    const release = bus.subscribe((event) => received.push(event));

    expect(bus.subscriberCount).toBe(1);
    release();
    release();
    expect(bus.subscriberCount).toBe(0);

    bus.publish(["task.updated"]);
    expect(received).toEqual([]);
  });

  test("a throwing subscriber is dropped and cannot break the others", () => {
    const errors: unknown[] = [];
    const bus = new OperationalEventBus({
      now: clock,
      onListenerError: (error) => errors.push(error),
    });
    const healthy: QueryEvent[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber is gone");
    });
    bus.subscribe((event) => healthy.push(event));

    bus.publish(["run.updated"]);

    expect(healthy).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(bus.subscriberCount).toBe(1);

    bus.publish(["run.updated"]);
    expect(healthy).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  test("subscribers are bounded so a leaking client cannot grow the bus", () => {
    const bus = new OperationalEventBus({ now: clock, maxSubscribers: 2 });
    bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(() => bus.subscribe(() => {})).toThrow(OperationalEventBusFullError);
    expect(bus.subscriberCount).toBe(2);
  });

  test("clear drops every subscriber", () => {
    const bus = new OperationalEventBus({ now: clock });
    bus.subscribe(() => {});
    bus.subscribe(() => {});
    bus.clear();
    expect(bus.subscriberCount).toBe(0);
  });

  test("publishing without subscribers or topics is a no-op", () => {
    const bus = new OperationalEventBus({ now: clock });
    expect(() => bus.publish(["task.updated"])).not.toThrow();
    const received: QueryEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.publish([]);
    expect(received).toEqual([]);
  });
});

describe("command invalidation topics", () => {
  test("every command reports activity", () => {
    for (const command of ["status", "task:list", "unknown:command"])
      expect(commandInvalidationTopics(command)).toContain("activity.created");
  });

  test("maps command families to the data they can change", () => {
    expect(commandInvalidationTopics("task:create")).toEqual(
      expect.arrayContaining(["task.updated", "project.updated"]),
    );
    expect(commandInvalidationTopics("pipeline:transition")).toEqual(
      expect.arrayContaining([
        "pipeline.updated",
        "task.updated",
        "run.updated",
      ]),
    );
    expect(commandInvalidationTopics("review:decide")).toEqual(
      expect.arrayContaining(["review.updated", "approval.updated"]),
    );
    expect(commandInvalidationTopics("run:tick")).toContain("run.updated");
    expect(commandInvalidationTopics("install")).toContain("project.updated");
  });

  test("topics are unique", () => {
    const topics = commandInvalidationTopics("pipeline:start");
    expect(new Set(topics).size).toBe(topics.length);
  });
});

describe("query parameter validation", () => {
  test("identifiers must be present, bounded, and well formed", () => {
    expect(parseIdentifier("project-1", "projectId")).toBe("project-1");
    expect(() => parseIdentifier(undefined, "projectId")).toThrow(
      QueryValidationError,
    );
    expect(() => parseIdentifier("", "projectId")).toThrow(
      QueryValidationError,
    );
    expect(() => parseIdentifier("a/b", "projectId")).toThrow(
      QueryValidationError,
    );
    expect(() => parseIdentifier("../etc", "projectId")).toThrow(
      QueryValidationError,
    );
    expect(() => parseIdentifier("x".repeat(200), "projectId")).toThrow(
      QueryValidationError,
    );
  });

  test("limits default, clamp, and reject nonsense", () => {
    expect(parseLimit(null, queryLimits.activity)).toBe(
      queryLimits.activity.default,
    );
    expect(parseLimit("10", queryLimits.activity)).toBe(10);
    expect(parseLimit("100000", queryLimits.activity)).toBe(
      queryLimits.activity.max,
    );
    expect(() => parseLimit("0", queryLimits.activity)).toThrow(
      QueryValidationError,
    );
    expect(() => parseLimit("-1", queryLimits.activity)).toThrow(
      QueryValidationError,
    );
    expect(() => parseLimit("abc", queryLimits.activity)).toThrow(
      QueryValidationError,
    );
  });

  test("booleans are validated", () => {
    expect(parseBoolean(null, "active")).toBe(false);
    expect(parseBoolean("true", "active")).toBe(true);
    expect(parseBoolean("1", "active")).toBe(true);
    expect(parseBoolean("false", "active")).toBe(false);
    expect(() => parseBoolean("yes", "active")).toThrow(QueryValidationError);
  });
});

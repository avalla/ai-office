import { describe, expect, test } from "vitest";
import {
  parseCoordinationReadParameters,
  parseCoordinationRoute,
} from "@ai-office/application/protocol/coordination-query-protocol.ts";
import { QueryValidationError } from "@ai-office/application/protocol/query-protocol.ts";

describe("coordination route grammar", () => {
  test("matches health and every read operation", () => {
    expect(parseCoordinationRoute("/api/coordination/v1/health")).toEqual({
      kind: "health",
    });
    for (const operation of [
      "status",
      "milestones",
      "tasks",
      "requirements",
      "dependencies",
      "blockers",
      "runnable",
    ])
      expect(
        parseCoordinationRoute(`/api/coordination/v1/projects/p-1/${operation}`),
      ).toEqual({ kind: "read", projectId: "p-1", operation });
  });

  test.each([
    "/health",
    "/commands",
    "/api",
    "/api/status",
    "/api/projects",
    "/api/projects/p/tasks",
    "/api/events",
    "/api/memory",
    "/api/runs/r",
    "/api/activity",
    "/api/coordination",
    "/api/coordination/v1",
    "/api/coordination/v1/",
    "/api/coordination/v2/health",
    "/api/coordination/v1/health/",
    "/api/coordination/v1/projects",
    "/api/coordination/v1/projects/p",
    "/api/coordination/v1/projects/p/runs",
    "/api/coordination/v1/projects/p/active",
    "/api/coordination/v1/projects/p/tasks/extra",
    "/api/coordination/v1/projects/p/commands",
    "/api/coordination/v1/../../commands",
  ])("%s is not a route", (path) => {
    expect(parseCoordinationRoute(path)).toEqual({ kind: "not_found" });
  });

  test("refuses an undecodable or invalid project identifier", () => {
    expect(() =>
      parseCoordinationRoute("/api/coordination/v1/projects/%E0%A4%A/tasks"),
    ).toThrow(QueryValidationError);
    expect(() =>
      parseCoordinationRoute("/api/coordination/v1/projects/a%2Fb/tasks"),
    ).toThrow(QueryValidationError);
    expect(() =>
      parseCoordinationRoute(`/api/coordination/v1/projects/${"a".repeat(129)}/tasks`),
    ).toThrow(QueryValidationError);
  });
});

describe("coordination read parameters", () => {
  const parse = (search: string) =>
    parseCoordinationReadParameters(new URLSearchParams(search));

  test("parses the closed parameter set", () => {
    expect(parse("")).toEqual({ milestoneId: null });
    expect(parse("milestone=m1&offset=0&limit=200&classes=P,T")).toEqual({
      milestoneId: "m1",
      offset: 0,
      limit: 200,
      classes: ["P", "T"],
    });
  });

  test.each([
    ["unknown=1", "Unknown parameter unknown"],
    ["limit=1&limit=2", "repeated"],
    ["offset=-1", "offset must be a non-negative decimal integer"],
    ["limit=1e3", "limit must be a non-negative decimal integer"],
    ["limit=0x10", "limit must be"],
    ["limit=", "limit must be"],
    ["offset=01", "offset must be"],
    ["offset=99999999999999999", "offset must be"],
    ["milestone=", "milestone is required"],
    ["milestone=a%20b", "milestone is not a valid identifier"],
  ])("refuses %s", (search, message) => {
    expect(() => parse(search)).toThrow(message);
  });
});

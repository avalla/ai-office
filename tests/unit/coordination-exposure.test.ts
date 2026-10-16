import { describe, expect, test } from "vitest";
import {
  coordinationExposureRegistry,
  exposeItem,
  redactionMarker,
  scrubCredentials,
} from "@ai-office/application/coordination/coordination-exposure.ts";

describe("coordination exposure registry", () => {
  test("lists exactly the exposed fields and their classes", () => {
    const classes = Object.fromEntries(
      Object.entries(coordinationExposureRegistry).map(([name, fields]) => [
        name,
        Object.fromEntries(
          Object.entries(fields).map(([field, exposure]) => [
            field,
            exposure.dataClass,
          ]),
        ),
      ]),
    );
    expect(classes).toEqual({
      milestones: { milestoneId: "P", title: "T", status: "P" },
      tasks: {
        taskId: "P",
        title: "T",
        status: "P",
        priority: "P",
        milestoneIds: "P",
        requirementIds: "P",
        prerequisiteIds: "P",
      },
      requirements: {
        requirementId: "P",
        key: "P",
        title: "T",
        status: "P",
        milestoneId: "P",
        taskIds: "P",
      },
      dependencies: { taskId: "P", dependsOnTaskId: "P" },
      blockers: {
        taskId: "P",
        status: "P",
        reasons: "P",
        unmetPrerequisiteIds: "P",
      },
      runnable: { taskId: "P", status: "P", priority: "P" },
    });
  });

  test("copies registered fields only and never an unregistered one", () => {
    const source = {
      taskId: "t1",
      title: "Title",
      status: "pending",
      priority: 2,
      milestoneIds: ["m"],
      requirementIds: [],
      prerequisiteIds: ["t0"],
      description: "SECRET-DESCRIPTION",
      agentOutput: "SECRET-OUTPUT",
    };
    const item = exposeItem("tasks", source, ["P", "T"]);
    expect(item).toEqual({
      taskId: "t1",
      title: "Title",
      status: "pending",
      priority: 2,
      milestoneIds: ["m"],
      requirementIds: [],
      prerequisiteIds: ["t0"],
    });
    expect(JSON.stringify(item)).not.toContain("SECRET");
    // Arrays are copies, so a caller cannot reach the read model through them.
    expect(item.prerequisiteIds).not.toBe(source.prerequisiteIds);
  });

  test("drops T fields when only P is allowed", () => {
    expect(
      exposeItem(
        "requirements",
        {
          requirementId: "r",
          key: "R-1",
          title: "Title",
          status: "proposed",
          milestoneId: null,
          taskIds: [],
        },
        ["P"],
      ),
    ).toEqual({
      requirementId: "r",
      key: "R-1",
      status: "proposed",
      milestoneId: null,
      taskIds: [],
    });
  });

  test("ignores inherited properties", () => {
    const source = Object.create({ title: "inherited" }) as object;
    Object.assign(source, { milestoneId: "m", status: "active" });
    expect(exposeItem("milestones", source, ["P", "T"])).toEqual({
      milestoneId: "m",
      status: "active",
    });
  });

  test("truncates text at 256 code points and flags the field", () => {
    const long = `${"x".repeat(255)}😀😀`;
    const item = exposeItem(
      "milestones",
      { milestoneId: "m", title: long, status: "active" },
      ["P", "T"],
    );
    expect(item.title).toBe(`${"x".repeat(255)}😀`);
    expect(Array.from(item.title as string)).toHaveLength(256);
    expect(item.truncatedFields).toEqual(["title"]);
    const exact = exposeItem(
      "milestones",
      { milestoneId: "m", title: "y".repeat(256), status: "active" },
      ["P", "T"],
    );
    expect(exact).not.toHaveProperty("truncatedFields");
  });

  test("scrubs before truncating, so a token at the boundary is still removed", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const item = exposeItem(
      "milestones",
      { milestoneId: "m", title: `${"x".repeat(240)}${token}`, status: "active" },
      ["P", "T"],
    );
    expect(item.title).toBe(`${"x".repeat(240)}${redactionMarker}`);
    expect(item).not.toHaveProperty("truncatedFields");
  });
});

describe("credential scrubber", () => {
  test.each([
    `ghp_${"A".repeat(36)}`,
    `github_pat_${"B".repeat(40)}`,
    `sk-${"c".repeat(40)}`,
    `sk-ant-api03-${"d".repeat(40)}`,
    `xoxb-${"1".repeat(20)}`,
    "AKIAABCDEFGHIJKLMNOP",
    `AIza${"e".repeat(35)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlLXZhbHVl",
    `Bearer ${"f".repeat(32)}`,
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  ])("redacts %s", (secret) => {
    const scrubbed = scrubCredentials(`before ${secret} after`);
    expect(scrubbed).toBe(`before ${redactionMarker} after`);
  });

  test("leaves ordinary planning text alone", () => {
    for (const text of [
      "CB-R10 shared coordination API",
      "Fix the task-sk-board layout",
      "Bearer of bad news",
    ])
      expect(scrubCredentials(text)).toBe(text);
  });
});

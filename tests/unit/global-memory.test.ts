import { describe, expect, test } from "vitest";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { GlobalLesson } from "@ai-office/domain/memory/global-lesson.ts";
import { GlobalPattern } from "@ai-office/domain/memory/global-pattern.ts";
import {
  GlobalRole,
  type MemoryStatus,
} from "@ai-office/domain/memory/global-role.ts";
import { MemoryReference } from "@ai-office/domain/memory/memory-reference.ts";

const now = new Date("2026-08-23T09:00:00.000Z");

describe("global memory domain", () => {
  test("validates reusable role definitions and deprecates deterministically", () => {
    const role = GlobalRole.create({
      id: "role",
      name: "Reviewer",
      version: 1,
      definition: {
        key: "reviewer",
        description: "Reviews changes",
        responsibilities: ["review"],
        capabilities: ["repository.read"],
        tools: ["git"],
        modelPolicy: "balanced",
        limits: {
          maxIterations: 5,
          maxCostMicros: "1000000",
          timeoutSeconds: 300,
        },
      },
      now,
    });

    role.deprecate(new Date("2026-08-23T10:00:00.000Z"));
    expect(role.snapshot()).toMatchObject({
      id: "role",
      status: "deprecated",
      updatedAt: new Date("2026-08-23T10:00:00.000Z"),
    });
    expect(() =>
      GlobalRole.create({
        id: "invalid",
        name: "Invalid",
        version: 0,
        definition: role.snapshot().definition,
        now,
      }),
    ).toThrow(DomainValidationError);
  });

  test("validates pattern, lesson, and reference invariants", () => {
    const pattern = GlobalPattern.create({
      id: "pattern",
      version: 1,
      name: "Short transactions",
      problem: "External work inside a transaction",
      context: "SQLite application services",
      solution: "Persist intent before external work",
      applicability: ["sqlite"],
      now,
    });
    const lesson = GlobalLesson.create({
      id: "lesson",
      sourceProjectId: "project",
      sourceTaskId: "task",
      title: "Avoid long transactions",
      content: "Do not call providers from a transaction",
      confidence: 0.9,
      now,
    });
    const reference = MemoryReference.create({
      id: "reference",
      projectId: "project",
      targetId: pattern.snapshot().id,
      targetVersion: 1,
      targetType: "pattern",
      referenceType: "adopted",
      now,
    });

    expect(pattern.snapshot().status).toBe("active");
    expect(lesson.snapshot().confidence).toBe(0.9);
    expect(reference.snapshot().usageCount).toBe(1);
    expect(() =>
      MemoryReference.create({
        id: "invalid",
        projectId: "project",
        targetId: "pattern",
        targetVersion: 0,
        targetType: "pattern",
        referenceType: "adopted",
        now,
      }),
    ).toThrow("targetVersion must be a positive safe integer");
    expect(() =>
      GlobalLesson.create({
        id: "invalid",
        title: "Invalid",
        content: "Invalid",
        confidence: 1.1,
        now,
      }),
    ).toThrow("confidence must be between 0 and 1");
  });

  test("restore revalidates every durable global-memory aggregate", () => {
    const role = GlobalRole.create({
      id: "role",
      name: "Reviewer",
      version: 1,
      definition: {
        key: "reviewer",
        description: "Reviews changes",
        responsibilities: [],
        capabilities: [],
        tools: [],
        modelPolicy: "balanced",
        limits: {
          maxIterations: 5,
          maxCostMicros: "1000000",
          timeoutSeconds: 300,
        },
      },
      now,
    }).snapshot();
    expect(() =>
      GlobalRole.restore({
        ...role,
        status: "corrupt" as MemoryStatus,
      }),
    ).toThrow("Global role status must be active or deprecated");

    const pattern = GlobalPattern.create({
      id: "pattern",
      version: 1,
      name: "Pattern",
      problem: "Problem",
      context: "Context",
      solution: "Solution",
      now,
    }).snapshot();
    expect(() =>
      GlobalPattern.restore({ ...pattern, successCount: -1 }),
    ).toThrow("successCount must be a non-negative safe integer");
    expect(() =>
      GlobalPattern.restore({
        ...pattern,
        applicability: ["valid", 1] as unknown as readonly string[],
      }),
    ).toThrow("Global pattern applicability must be a string");

    const lesson = GlobalLesson.create({
      id: "lesson",
      title: "Lesson",
      content: "Content",
      confidence: 0.8,
      now,
    }).snapshot();
    expect(() =>
      GlobalLesson.restore({ ...lesson, sourceTaskId: "orphan-task" }),
    ).toThrow("sourceTaskId requires sourceProjectId");

    const reference = MemoryReference.create({
      id: "reference",
      projectId: "project",
      targetId: "pattern",
      targetVersion: 1,
      targetType: "pattern",
      referenceType: "adopted",
      now,
    }).snapshot();
    expect(() =>
      MemoryReference.restore({ ...reference, usageCount: 0 }),
    ).toThrow("usageCount must be a positive safe integer");
  });
});

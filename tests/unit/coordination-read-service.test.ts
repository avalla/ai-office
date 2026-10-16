import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import {
  CoordinationClassNotEnabledError,
  CoordinationOperationError,
  CoordinationReadService,
  CoordinationResponseTooLargeError,
  coordinationReadOperations,
  type CoordinationCollectionResponse,
  type CoordinationStatusResponse,
} from "@ai-office/application/coordination/coordination-read-service.ts";
import {
  GetPlanningSnapshot,
  PlanningScopeNotFoundError,
  PlanningSnapshotQueryError,
} from "@ai-office/application/coordination/get-planning-snapshot.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import {
  PlanningReadBusyError,
  type PlanningReadRepository,
  type PlanningStateRecord,
} from "@ai-office/application/ports/planning-read.port.ts";

function state(): PlanningStateRecord {
  return {
    projectId: "p",
    milestones: [
      {
        id: "m1",
        title: "Milestone one",
        status: "active",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    ],
    tasks: [
      { id: "a", title: "Task A", status: "waiting_review", priority: 1 },
      { id: "b", title: "Task B", status: "pending", priority: 5 },
      { id: "c", title: "Task C", status: "blocked", priority: 0 },
      { id: "d", title: "Task D", status: "completed", priority: 0 },
    ],
    dependencies: [
      { taskId: "b", dependsOnTaskId: "c" },
      { taskId: "c", dependsOnTaskId: "a" },
    ],
    requirements: [
      {
        id: "r1",
        key: "R-1",
        title: "Req 1",
        status: "accepted",
        milestoneId: "m1",
      },
    ],
    taskRequirementLinks: [
      { taskId: "a", requirementId: "r1" },
      { taskId: "b", requirementId: "r1" },
    ],
  };
}

function service(
  read: () => PlanningStateRecord | null = state,
): CoordinationReadService {
  const reads: PlanningReadRepository = {
    readPlanningState: async (projectId) =>
      projectId === "p" ? read() : null,
  };
  return new CoordinationReadService(new GetPlanningSnapshot(reads));
}

const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`;

describe("coordination read service", () => {
  test("serves every read operation", () => {
    expect(coordinationReadOperations).toEqual([
      "status",
      "milestones",
      "tasks",
      "requirements",
      "dependencies",
      "blockers",
      "runnable",
    ]);
  });

  test("status counts the scope without exposing items", async () => {
    const status = (await service().execute({
      projectId: "p",
      operation: "status",
    })) as CoordinationStatusResponse;
    expect(status).toEqual({
      coordinationApiVersion: 1,
      operation: "status",
      schemaVersion: 1,
      snapshotId: expect.stringMatching(/^snapshot:sha256:[0-9a-f]{64}$/),
      scope: { projectId: "p", milestoneId: null },
      classes: ["P", "T"],
      counts: {
        milestones: 1,
        tasks: 4,
        requirements: 1,
        dependencies: 2,
        runnable: 0,
        active: 1,
        blockers: 2,
        decisions: 1,
        inconsistencies: 0,
      },
      taskStatusCounts: {
        pending: 1,
        assigned: 0,
        running: 0,
        blocked: 1,
        waiting_review: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    const scoped = (await service().execute({
      projectId: "p",
      operation: "status",
      milestoneId: "m1",
    })) as CoordinationStatusResponse;
    expect(scoped.counts.tasks).toBe(2);
    expect(scoped.taskStatusCounts.pending).toBe(1);
    expect(scoped.taskStatusCounts.blocked).toBe(0);
  });

  test("the status snapshot identity equals the collection identity", async () => {
    const reads = service();
    const status = await reads.execute({ projectId: "p", operation: "status" });
    const tasks = await reads.execute({ projectId: "p", operation: "tasks" });
    expect(status.snapshotId).toBe(tasks.snapshotId);
  });

  test("collections are exposed pages whose digest covers the whole response", async () => {
    const page = (await service().execute({
      projectId: "p",
      operation: "tasks",
      limit: 2,
    })) as CoordinationCollectionResponse;
    expect(page).toMatchObject({
      coordinationApiVersion: 1,
      operation: "tasks",
      collection: "tasks",
      section: "authoritative",
      page: { offset: 0, limit: 2, total: 4, truncated: true },
    });
    expect(page.items.map((item) => item.taskId)).toEqual(["b", "a"]);
    const { pageDigest, ...rest } = page;
    expect(pageDigest).toBe(digest(rest));
  });

  test("blockers and runnable are derived collections", async () => {
    const blockers = (await service().execute({
      projectId: "p",
      operation: "blockers",
    })) as CoordinationCollectionResponse;
    expect(blockers.section).toBe("derived");
    expect(blockers.items).toEqual([
      {
        taskId: "b",
        status: "pending",
        reasons: ["unmet_prerequisites"],
        unmetPrerequisiteIds: ["c"],
      },
      {
        taskId: "c",
        status: "blocked",
        reasons: ["recorded_blocked"],
        unmetPrerequisiteIds: [],
      },
    ]);
    const runnable = (await service(() => ({
      ...state(),
      dependencies: [],
    })).execute({
      projectId: "p",
      operation: "runnable",
    })) as CoordinationCollectionResponse;
    expect(runnable.items).toEqual([
      { taskId: "b", status: "pending", priority: 5 },
    ]);
  });

  test("the same state yields byte-identical responses", async () => {
    for (const operation of coordinationReadOperations)
      expect(
        JSON.stringify(await service().execute({ projectId: "p", operation })),
      ).toBe(
        JSON.stringify(await service().execute({ projectId: "p", operation })),
      );
  });

  test("titles are scrubbed and truncated in the exposed page", async () => {
    const page = (await service(() => ({
      ...state(),
      milestones: [
        {
          id: "m1",
          title: `${"x".repeat(300)} sk-${"k".repeat(30)}`,
          status: "active",
          createdAt: new Date(0),
        },
      ],
    })).execute({
      projectId: "p",
      operation: "milestones",
    })) as CoordinationCollectionResponse;
    expect(page.items).toEqual([
      {
        milestoneId: "m1",
        title: "x".repeat(256),
        status: "active",
        truncatedFields: ["title"],
      },
    ]);
    expect(JSON.stringify(page)).not.toContain("kkkk");
  });

  test("a caller cannot receive a class that is not allowed", async () => {
    const reads = service();
    const onlyP = {
      kind: "exposure" as const,
      projects: new Map([["p", ["P"] as const]]),
    };
    const page = (await reads.execute(
      { projectId: "p", operation: "milestones" },
      onlyP,
    )) as CoordinationCollectionResponse;
    expect(page.classes).toEqual(["P"]);
    expect(page.items).toEqual([{ milestoneId: "m1", status: "active" }]);
    await expect(
      reads.execute(
        { projectId: "p", operation: "milestones", classes: ["P", "T"] },
        onlyP,
      ),
    ).rejects.toBeInstanceOf(CoordinationClassNotEnabledError);
    // An existing project outside the exposure policy reads as missing.
    await expect(
      reads.execute(
        { projectId: "p", operation: "status" },
        { kind: "exposure", projects: new Map([["other", ["P", "T"]]]) },
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    // An invalid class is invalid, not "not enabled".
    await expect(
      reads.execute(
        { projectId: "p", operation: "milestones", classes: ["P", "D"] },
        onlyP,
      ),
    ).rejects.toBeInstanceOf(PlanningSnapshotQueryError);
  });

  test("typed refusals", async () => {
    const reads = service();
    await expect(
      reads.execute({ projectId: "p", operation: "active" }),
    ).rejects.toBeInstanceOf(CoordinationOperationError);
    await expect(
      reads.execute({ projectId: "p", operation: "runs" }),
    ).rejects.toBeInstanceOf(CoordinationOperationError);
    await expect(
      reads.execute({ projectId: "missing", operation: "tasks" }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      reads.execute({ projectId: "p", operation: "tasks", milestoneId: "mx" }),
    ).rejects.toBeInstanceOf(PlanningScopeNotFoundError);
    await expect(
      reads.execute({ projectId: "p", operation: "tasks", limit: 201 }),
    ).rejects.toBeInstanceOf(PlanningSnapshotQueryError);
    await expect(
      reads.execute({ projectId: "p", operation: "status", limit: 1 }),
    ).rejects.toBeInstanceOf(PlanningSnapshotQueryError);
    const busy = new CoordinationReadService(
      new GetPlanningSnapshot({
        readPlanningState: async () => {
          throw new PlanningReadBusyError();
        },
      }),
    );
    await expect(
      busy.execute({ projectId: "p", operation: "status" }),
    ).rejects.toBeInstanceOf(PlanningReadBusyError);
  });

  test("a response above 256 KiB is refused; a smaller window of the same operation is served", async () => {
    // 200 tasks, each with 100 prerequisites of 60-character ids: every item
    // is at the list bound, so a full page is far above 256 KiB.
    const prerequisites = Array.from(
      { length: 100 },
      (_, index) => `pre-${String(index).padStart(3, "0")}-${"p".repeat(52)}`,
    );
    const tasks = Array.from({ length: 200 }, (_, index) => ({
      id: `task-${String(index).padStart(3, "0")}`,
      title: "t",
      status: "pending" as const,
      priority: 0,
    }));
    const big = (): PlanningStateRecord => ({
      ...state(),
      tasks: [
        ...tasks,
        ...prerequisites.map((id) => ({
          id,
          title: "p",
          status: "completed" as const,
          priority: 0,
        })),
      ],
      dependencies: tasks.flatMap((task) =>
        prerequisites.map((dependsOnTaskId) => ({
          taskId: task.id,
          dependsOnTaskId,
        })),
      ),
      requirements: [],
      taskRequirementLinks: [],
    });
    await expect(
      service(big).execute({ projectId: "p", operation: "tasks", limit: 200 }),
    ).rejects.toBeInstanceOf(CoordinationResponseTooLargeError);
    const page = (await service(big).execute({
      projectId: "p",
      operation: "tasks",
      limit: 10,
    })) as CoordinationCollectionResponse;
    expect(page.items).toHaveLength(10);
  });

  test("one item always fits: a requirement with thousands of tasks is listed with a cut, flagged list", async () => {
    const tasks = Array.from({ length: 3000 }, (_, index) => ({
      id: `task-${String(index).padStart(5, "0")}-${"i".repeat(100)}`,
      title: "t",
      status: "pending" as const,
      priority: 0,
    }));
    const page = (await service(() => ({
      ...state(),
      tasks,
      dependencies: [],
      taskRequirementLinks: tasks.map((task) => ({
        taskId: task.id,
        requirementId: "r1",
      })),
    })).execute({
      projectId: "p",
      operation: "requirements",
    })) as CoordinationCollectionResponse;
    expect(page.items[0]!.taskIds).toHaveLength(100);
    expect(page.items[0]!.truncatedFields).toEqual(["taskIds"]);
  });

  test("a read that meets a short write retries, a long write stays busy", async () => {
    const delays: number[] = [];
    const sleep = async (milliseconds: number) => {
      delays.push(milliseconds);
    };
    let busyReads = 2;
    const reads: PlanningReadRepository = {
      readPlanningState: async () => {
        if (busyReads > 0) {
          busyReads -= 1;
          throw new PlanningReadBusyError();
        }
        return state();
      },
    };
    const retried = new CoordinationReadService(
      new GetPlanningSnapshot(reads, { attempts: 5, delayMs: 7, sleep }),
    );
    await expect(
      retried.execute({ projectId: "p", operation: "status" }),
    ).resolves.toMatchObject({ operation: "status" });
    expect(delays).toEqual([7, 7]);

    delays.length = 0;
    let calls = 0;
    const stuck = new CoordinationReadService(
      new GetPlanningSnapshot(
        {
          readPlanningState: async () => {
            calls += 1;
            throw new PlanningReadBusyError();
          },
        },
        { attempts: 3, delayMs: 5, sleep },
      ),
    );
    await expect(
      stuck.execute({ projectId: "p", operation: "tasks" }),
    ).rejects.toBeInstanceOf(PlanningReadBusyError);
    expect(calls).toBe(3);
    expect(delays).toEqual([5, 5]);

    // Any other failure is not retried.
    calls = 0;
    const broken = new GetPlanningSnapshot(
      {
        readPlanningState: async () => {
          calls += 1;
          throw new Error("disk");
        },
      },
      { attempts: 3, delayMs: 5, sleep },
    );
    await expect(broken.execute({ projectId: "p" })).rejects.toThrow("disk");
    expect(calls).toBe(1);
  });

  test("matches the recorded v1 fixture byte for byte", async () => {
    const fixture = readFileSync(
      new URL(
        "../fixtures/coordination/v1-tasks-response.json",
        import.meta.url,
      ),
      "utf8",
    ).trimEnd();
    const response = await service().execute({
      projectId: "p",
      operation: "tasks",
      limit: 2,
      offset: 1,
    });
    expect(JSON.stringify(response)).toBe(fixture);
  });
});

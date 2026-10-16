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

  test("the exposed identity cannot confirm a scrubbed secret or a cut title tail", async () => {
    const withTitle = (title: string) =>
      service(() => ({
        ...state(),
        milestones: [
          { id: "m1", title, status: "active", createdAt: new Date(0) },
        ],
      }));
    const secret = (value: string) =>
      `Deploy ${["gh", "p_", value].join("")}`;
    const tail = (value: string) => `${"x".repeat(256)}${value}`;
    const pairs: [string, string][] = [
      [secret("a".repeat(36)), secret("b".repeat(36))],
      [tail("guess-one"), tail("guess-two")],
    ];
    for (const [left, right] of pairs) {
      for (const operation of ["status", "milestones", "tasks"]) {
        const one = await withTitle(left).execute({ projectId: "p", operation });
        const two = await withTitle(right).execute({
          projectId: "p",
          operation,
        });
        // Byte-identical: neither snapshotId nor pageDigest differs.
        expect(JSON.stringify(one)).toBe(JSON.stringify(two));
      }
    }
    // A change that is visible in the exposed projection changes it.
    const visible = await withTitle("Milestone two").execute({
      projectId: "p",
      operation: "status",
    });
    const base = await service().execute({ projectId: "p", operation: "status" });
    expect(visible.snapshotId).not.toBe(base.snapshotId);
    // Without T, a title change is not visible and the identity holds.
    const onlyP = { kind: "exposure" as const, projects: new Map([["p", ["P"] as const]]) };
    expect(
      (await withTitle("Milestone two").execute({ projectId: "p", operation: "status" }, onlyP))
        .snapshotId,
    ).toBe(
      (await service().execute({ projectId: "p", operation: "status" }, onlyP))
        .snapshotId,
    );
  });

  test("requirements are ordered by their exposed key, not the stored one", async () => {
    const below = ["AKIA", "Q".repeat(16)].join("");
    const above = ["gh", "p_", "z".repeat(36)].join("");
    const withKey = (key: string) =>
      service(() => ({
        ...state(),
        requirements: [
          { id: "r1", key, title: "One", status: "accepted", milestoneId: "m1" },
          { id: "r2", key: "R-2", title: "Two", status: "accepted", milestoneId: "m1" },
        ],
      }));
    // Stored keys sort on opposite sides of "R-2"; exposed, both read
    // "[redacted]", so the order and every byte must match.
    expect(below < "R-2" && above > "R-2").toBe(true);
    const low = await withKey(below).execute({ projectId: "p", operation: "requirements" });
    const high = await withKey(above).execute({ projectId: "p", operation: "requirements" });
    expect(JSON.stringify(low)).toBe(JSON.stringify(high));
    expect(
      (low as CoordinationCollectionResponse).items.map((item) => item.requirementId),
    ).toEqual(["r2", "r1"]);
  });

  test("milestones are ordered by id, not by their unexposed creation time", async () => {
    const withTimes = (first: number, second: number) =>
      service(() => ({
        ...state(),
        milestones: [
          { id: "m1", title: "One", status: "active", createdAt: new Date(first) },
          { id: "m2", title: "Two", status: "active", createdAt: new Date(second) },
        ],
      }));
    // Swapping only the creation times changes nothing that is exposed, so
    // the order, the snapshotId and the pageDigest must all match.
    for (const operation of ["milestones", "status"]) {
      const early = await withTimes(0, 1).execute({ projectId: "p", operation });
      const late = await withTimes(1, 0).execute({ projectId: "p", operation });
      expect(JSON.stringify(early)).toBe(JSON.stringify(late));
    }
    const page = (await withTimes(1, 0).execute({
      projectId: "p",
      operation: "milestones",
    })) as CoordinationCollectionResponse;
    expect(page.items.map((item) => item.milestoneId)).toEqual(["m1", "m2"]);
  });

  test("pages and status served from the cached projection match a fresh service", async () => {
    let reads = 0;
    const counting = new CoordinationReadService(
      new GetPlanningSnapshot({
        readPlanningState: async () => {
          reads += 1;
          return state();
        },
      }),
    );
    const first = await counting.execute({ projectId: "p", operation: "tasks", limit: 1 });
    const second = await counting.execute({ projectId: "p", operation: "tasks", limit: 1, offset: 1 });
    const status = await counting.execute({ projectId: "p", operation: "status" });
    expect(reads).toBe(3);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(status.snapshotId).toBe(first.snapshotId);
    // A fresh service over the same state yields the same bytes as the cache.
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(
        await service().execute({ projectId: "p", operation: "tasks", limit: 1, offset: 1 }),
      ),
    );
  });

  test("changing a returned item cannot change later responses", async () => {
    const reads = service();
    const before = JSON.stringify(
      await reads.execute({ projectId: "p", operation: "tasks" }),
    );
    const first = (await reads.execute({
      projectId: "p",
      operation: "tasks",
    })) as CoordinationCollectionResponse;
    first.items[0]!.title = "tampered";
    (first.items[0]!.requirementIds as string[]).push("tampered");
    first.items.pop();
    expect(
      JSON.stringify(await reads.execute({ projectId: "p", operation: "tasks" })),
    ).toBe(before);
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

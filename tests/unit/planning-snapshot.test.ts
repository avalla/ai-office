import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  planningSnapshotCollections,
  planningSnapshotPage,
  projectPlanningSnapshot,
  type PlanningDataClass,
  type PlanningSnapshotScope,
} from "@ai-office/application/coordination/planning-snapshot.ts";
import {
  GetPlanningSnapshot,
  PlanningScopeNotFoundError,
  PlanningSnapshotQueryError,
} from "@ai-office/application/coordination/get-planning-snapshot.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import type { PlanningStateRecord } from "@ai-office/application/ports/planning-read.port.ts";

/**
 * m1 (active) holds r1 (accepted) → a, b and r2 (verified) → stale.
 * m2 (completed) holds r3 (proposed) → c, still open.
 * Prerequisites: b → a, c → b, done-early → open-prereq.
 */
function state(): PlanningStateRecord {
  return {
    projectId: "p",
    milestones: [
      { id: "m1", title: "Milestone one", status: "active" },
      { id: "m2", title: "Milestone two", status: "completed" },
    ],
    tasks: [
      { id: "a", title: "Task A", status: "waiting_review", priority: 1 },
      { id: "b", title: "Task B", status: "pending", priority: 5 },
      { id: "c", title: "Task C", status: "blocked", priority: 0 },
      { id: "stale", title: "Stale", status: "pending", priority: 0 },
      { id: "free", title: "Free", status: "assigned", priority: 2 },
      { id: "run", title: "Running", status: "running", priority: 3 },
      { id: "open-prereq", title: "Open", status: "pending", priority: 0 },
      { id: "done-early", title: "Done", status: "completed", priority: 0 },
    ],
    dependencies: [
      { taskId: "b", dependsOnTaskId: "a" },
      { taskId: "c", dependsOnTaskId: "b" },
      { taskId: "done-early", dependsOnTaskId: "open-prereq" },
    ],
    requirements: [
      {
        id: "r1",
        key: "R-1",
        title: "Req 1",
        status: "accepted",
        milestoneId: "m1",
      },
      {
        id: "r2",
        key: "R-2",
        title: "Req 2",
        status: "verified",
        milestoneId: "m1",
      },
      {
        id: "r3",
        key: "R-3",
        title: "Req 3",
        status: "proposed",
        milestoneId: "m2",
      },
      {
        id: "r4",
        key: "R-4",
        title: "Req 4",
        status: "proposed",
        milestoneId: null,
      },
    ],
    taskRequirementLinks: [
      { taskId: "a", requirementId: "r1" },
      { taskId: "b", requirementId: "r1" },
      { taskId: "c", requirementId: "r3" },
      { taskId: "stale", requirementId: "r2" },
    ],
  };
}

const project: PlanningSnapshotScope = { projectId: "p", milestoneId: null };
const both: PlanningDataClass[] = ["P", "T"];

function reads(value: PlanningStateRecord | null) {
  return { readPlanningState: async () => value };
}

describe("planning read model", () => {
  test("carries authoritative collections apart from derived analysis", () => {
    const snapshot = projectPlanningSnapshot(state(), project, both);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.snapshotId).toMatch(/^snapshot:sha256:[0-9a-f]{64}$/);
    expect(Object.keys(snapshot.authoritative)).toEqual([
      "milestones",
      "tasks",
      "requirements",
      "dependencies",
    ]);
    expect(Object.keys(snapshot.derived)).toEqual([
      "runnable",
      "active",
      "blockers",
      "decisions",
      "inconsistencies",
    ]);
    // Priority first, then id.
    expect(snapshot.authoritative.tasks.map((t) => t.taskId)).toEqual([
      "b",
      "run",
      "free",
      "a",
      "c",
      "done-early",
      "open-prereq",
      "stale",
    ]);
    expect(snapshot.authoritative.tasks[0]).toEqual({
      taskId: "b",
      title: "Task B",
      status: "pending",
      priority: 5,
      milestoneIds: ["m1"],
      requirementIds: ["r1"],
      prerequisiteIds: ["a"],
    });
    expect(snapshot.authoritative.requirements[0]).toEqual({
      requirementId: "r1",
      key: "R-1",
      title: "Req 1",
      status: "accepted",
      milestoneId: "m1",
      taskIds: ["a", "b"],
    });
  });

  test("derives runnable, active, blockers, decisions and inconsistencies", () => {
    const { derived } = projectPlanningSnapshot(state(), project, both);
    // b is admitted because its prerequisite is in review; stale and
    // open-prereq have no prerequisite; free is assigned and unblocked.
    expect(derived.runnable.map((t) => t.taskId)).toEqual([
      "b",
      "free",
      "open-prereq",
      "stale",
    ]);
    expect(derived.active).toEqual([
      { taskId: "run", status: "running", priority: 3 },
      { taskId: "a", status: "waiting_review", priority: 1 },
    ]);
    expect(derived.blockers).toEqual([
      {
        taskId: "c",
        status: "blocked",
        reasons: ["unmet_prerequisites", "recorded_blocked"],
        unmetPrerequisiteIds: ["b"],
      },
    ]);
    expect(derived.decisions).toEqual([
      { kind: "task_review_pending", subjectType: "task", subjectId: "a" },
      {
        kind: "requirement_proposed",
        subjectType: "requirement",
        subjectId: "r3",
      },
      {
        kind: "requirement_proposed",
        subjectType: "requirement",
        subjectId: "r4",
      },
    ]);
    expect(derived.inconsistencies).toEqual([
      {
        code: "COMPLETED_WITH_INCOMPLETE_PREREQUISITE",
        subjectType: "task",
        subjectId: "done-early",
        relatedIds: ["open-prereq"],
      },
      {
        code: "MILESTONE_CLOSED_WITH_OPEN_TASK",
        subjectType: "milestone",
        subjectId: "m2",
        relatedIds: ["c"],
      },
      {
        code: "TASK_CONTRADICTS_REQUIREMENTS",
        subjectType: "task",
        subjectId: "stale",
        relatedIds: ["r2"],
      },
    ]);
  });

  test("a milestone scope keeps readiness from prerequisites outside it", () => {
    const value = state();
    // d belongs to m2 and depends on b, which belongs to m1 only.
    value.tasks.push({ id: "d", title: "D", status: "pending", priority: 0 });
    value.dependencies.push({ taskId: "d", dependsOnTaskId: "b" });
    value.taskRequirementLinks.push({ taskId: "d", requirementId: "r3" });
    const snapshot = projectPlanningSnapshot(
      value,
      { projectId: "p", milestoneId: "m2" },
      both,
    );
    expect(snapshot.authoritative.milestones.map((m) => m.milestoneId)).toEqual(
      ["m2"],
    );
    expect(snapshot.authoritative.tasks.map((t) => t.taskId)).toEqual([
      "c",
      "d",
    ]);
    expect(snapshot.authoritative.requirements.map((r) => r.key)).toEqual([
      "R-3",
    ]);
    expect(snapshot.authoritative.dependencies).toEqual([
      { taskId: "c", dependsOnTaskId: "b" },
      { taskId: "d", dependsOnTaskId: "b" },
    ]);
    expect(snapshot.derived.runnable).toEqual([]);
    expect(snapshot.derived.blockers.map((b) => b.taskId)).toEqual(["c", "d"]);
    expect(snapshot.derived.decisions.map((d) => d.subjectId)).toEqual(["r3"]);
    expect(snapshot.snapshotId).not.toBe(
      projectPlanningSnapshot(value, project, both).snapshotId,
    );
  });

  test("exposes exactly the P and T field sets and drops titles without T", () => {
    const withTitles = projectPlanningSnapshot(state(), project, both);
    const without = projectPlanningSnapshot(state(), project, ["P"]);
    expect(Object.keys(withTitles.authoritative.milestones[0]!).sort()).toEqual(
      ["milestoneId", "status", "title"],
    );
    expect(Object.keys(withTitles.authoritative.tasks[0]!).sort()).toEqual([
      "milestoneIds",
      "prerequisiteIds",
      "priority",
      "requirementIds",
      "status",
      "taskId",
      "title",
    ]);
    expect(
      Object.keys(withTitles.authoritative.requirements[0]!).sort(),
    ).toEqual([
      "key",
      "milestoneId",
      "requirementId",
      "status",
      "taskIds",
      "title",
    ]);
    const serialized = JSON.stringify(without);
    for (const text of ["Task B", "Milestone one", "Req 1"])
      expect(serialized).not.toContain(text);
    expect(without.classes).toEqual(["P"]);
    expect(without.snapshotId).not.toBe(withTitles.snapshotId);
  });

  test("never exposes a field the port record gains", () => {
    const value = state() as PlanningStateRecord & {
      tasks: (PlanningStateRecord["tasks"][number] & {
        description?: string;
      })[];
    };
    value.tasks[0]!.description = "SECRET-DESCRIPTION token=abc";
    (value.requirements[0] as { description?: string }).description =
      "SECRET-REQ";
    const serialized = JSON.stringify(
      projectPlanningSnapshot(value, project, both),
    );
    expect(serialized).not.toContain("SECRET");
  });

  test("is deterministic and independent of record order", () => {
    const first = projectPlanningSnapshot(state(), project, both);
    const shuffled = state();
    shuffled.tasks.reverse();
    shuffled.dependencies.reverse();
    shuffled.requirements.reverse();
    shuffled.taskRequirementLinks.reverse();
    const second = projectPlanningSnapshot(shuffled, project, ["T", "P", "T"]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("changes identity when any scoped planning fact changes", () => {
    const base = projectPlanningSnapshot(state(), project, both).snapshotId;
    const priority = state();
    priority.tasks[0]!.priority = 9;
    const edge = state();
    edge.dependencies.pop();
    const title = state();
    title.milestones[0]!.title = "Renamed";
    const ids = [priority, edge, title].map(
      (value) => projectPlanningSnapshot(value, project, both).snapshotId,
    );
    expect(new Set([base, ...ids]).size).toBe(4);
  });

  test("keeps the snapshot identity across windows and digests each page", () => {
    const snapshot = projectPlanningSnapshot(state(), project, both);
    const first = planningSnapshotPage(snapshot, "tasks", {
      offset: 0,
      limit: 3,
    });
    const second = planningSnapshotPage(snapshot, "tasks", {
      offset: 3,
      limit: 3,
    });
    const last = planningSnapshotPage(snapshot, "tasks", {
      offset: 6,
      limit: 3,
    });
    const whole = planningSnapshotPage(snapshot, "tasks", {
      offset: 0,
      limit: 200,
    });
    expect(
      new Set([first, second, last, whole].map((p) => p.snapshotId)).size,
    ).toBe(1);
    expect(
      new Set([first, second, last, whole].map((p) => p.pageDigest)).size,
    ).toBe(4);
    expect(first.pageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.page).toEqual({
      offset: 0,
      limit: 3,
      total: 8,
      truncated: true,
    });
    expect(last.page).toEqual({
      offset: 6,
      limit: 3,
      total: 8,
      truncated: false,
    });
    expect([...first.items, ...second.items, ...last.items]).toEqual(
      whole.items,
    );
    expect(first.section).toBe("authoritative");
    expect(
      planningSnapshotPage(snapshot, "blockers", { offset: 0, limit: 1 })
        .section,
    ).toBe("derived");
    expect(first.counts).toEqual({
      milestones: 2,
      tasks: 8,
      requirements: 4,
      dependencies: 3,
      runnable: 4,
      active: 2,
      blockers: 1,
      decisions: 3,
      inconsistencies: 3,
    });
    expect(
      planningSnapshotPage(snapshot, "tasks", { offset: 50, limit: 3 }),
    ).toMatchObject({ items: [], page: { total: 8, truncated: false } });
  });

  test("matches the recorded v1 fixture byte for byte", () => {
    const fixture = readFileSync(
      new URL(
        "../fixtures/planning-snapshot/v1-tasks-page.json",
        import.meta.url,
      ),
      "utf8",
    ).trimEnd();
    const page = planningSnapshotPage(
      projectPlanningSnapshot(state(), project, both),
      "tasks",
      { offset: 0, limit: 2 },
    );
    expect(JSON.stringify(page)).toBe(fixture);
  });
});

describe("GetPlanningSnapshot", () => {
  test("defaults to the tasks collection, P and T, and a window of 50", async () => {
    const page = await new GetPlanningSnapshot(reads(state())).execute({
      projectId: "p",
    });
    expect(page).toMatchObject({
      collection: "tasks",
      classes: ["P", "T"],
      page: { offset: 0, limit: 50, total: 8, truncated: false },
      scope: { projectId: "p", milestoneId: null },
    });
    expect(planningSnapshotCollections).toContain(page.collection);
  });

  test("refuses an unknown project, milestone, collection, window or class", async () => {
    const service = new GetPlanningSnapshot(reads(state()));
    await expect(
      new GetPlanningSnapshot(reads(null)).execute({ projectId: "missing" }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      service.execute({ projectId: "p", milestoneId: "nope" }),
    ).rejects.toBeInstanceOf(PlanningScopeNotFoundError);
    for (const query of [
      { collection: "runs" },
      { collection: "__proto__" },
      { limit: 0 },
      { limit: 201 },
      { offset: -1 },
      { offset: 1.5 },
      { classes: ["T"] },
      { classes: ["P", "D"] },
      { classes: ["P", "A"] },
    ])
      await expect(
        service.execute({ projectId: "p", ...query }),
      ).rejects.toBeInstanceOf(PlanningSnapshotQueryError);
    await expect(
      service.execute({ projectId: "p", limit: 200 }),
    ).resolves.toMatchObject({
      page: { limit: 200 },
    });
  });
});

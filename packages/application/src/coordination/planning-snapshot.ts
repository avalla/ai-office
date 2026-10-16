/**
 * The planning read model (CB-02, ADR-0036 Decisions 7 and 9).
 *
 * One deterministic, minimized projection of authoritative planning state. The
 * query route, the GitHub bridge and the MCP server consume it through the
 * coordination API and never recompute it.
 *
 * - Only data classes P (identifiers, keys, statuses, priorities,
 *   relationships, counts) and T (titles) exist here. Every item is built by an
 *   explicit mapper; no record is spread, so a field the port gains later is
 *   not exposed by accident.
 * - Authoritative collections carry recorded state; derived collections carry
 *   analysis computed from it, and the two never share an item.
 * - The snapshot carries no volatile field. Its identity is the digest of the
 *   complete scoped canonical projection, computed before pagination, so it
 *   does not change with the page window; each page carries its own digest.
 *   The same state yields byte-identical output.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type {
  MilestoneStatus,
  RequirementStatus,
} from "@ai-office/domain/governance/governance.ts";
import { blockingPrerequisites } from "@ai-office/domain/task/task-dependency.ts";
import {
  isTerminalTaskStatus,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import { isTerminalRequirementStatus } from "../commands/task-requirement-progress.ts";
import type { PlanningStateRecord } from "../ports/planning-read.port.ts";

export const planningSnapshotSchemaVersion = 1 as const;

export const planningSnapshotLimits = {
  defaultLimit: 50,
  maxLimit: 200,
} as const;

/** P is always present; T (titles) is opt-out. D and A never exist here. */
export type PlanningDataClass = "P" | "T";

export const planningSnapshotCollections = [
  "milestones",
  "tasks",
  "requirements",
  "dependencies",
  "runnable",
  "active",
  "blockers",
  "decisions",
  "inconsistencies",
] as const;

export type PlanningSnapshotCollection =
  (typeof planningSnapshotCollections)[number];

const authoritativeCollections: ReadonlySet<PlanningSnapshotCollection> =
  new Set(["milestones", "tasks", "requirements", "dependencies"]);

export interface PlanningSnapshotScope {
  projectId: string;
  /** Restricts the snapshot to one milestone; `null` is the whole project. */
  milestoneId: string | null;
}

export interface PlanningMilestone {
  milestoneId: string;
  title?: string;
  status: MilestoneStatus;
}

export interface PlanningTask {
  taskId: string;
  title?: string;
  /** The recorded `task.status`; operational state is not planning state. */
  status: TaskStatus;
  priority: number;
  /** Milestones reached through linked requirements. */
  milestoneIds: string[];
  requirementIds: string[];
  /** Direct prerequisites, whether or not they are inside the scope. */
  prerequisiteIds: string[];
}

export interface PlanningRequirement {
  requirementId: string;
  key: string;
  title?: string;
  status: RequirementStatus;
  milestoneId: string | null;
  taskIds: string[];
}

export interface PlanningDependency {
  taskId: string;
  dependsOnTaskId: string;
}

/** A task whose work can start now: not started and admitted by its prerequisites. */
export interface PlanningRunnableTask {
  taskId: string;
  status: TaskStatus;
  priority: number;
}

/** A task with work in progress or submitted for review. */
export interface PlanningActiveTask {
  taskId: string;
  status: TaskStatus;
  priority: number;
}

export type PlanningBlockerReason = "unmet_prerequisites" | "recorded_blocked";

export interface PlanningBlocker {
  taskId: string;
  status: TaskStatus;
  reasons: PlanningBlockerReason[];
  /** Prerequisites that do not yet admit work (neither completed nor in review). */
  unmetPrerequisiteIds: string[];
}

export type PlanningDecisionKind =
  "task_review_pending" | "requirement_proposed";

export interface PlanningDecision {
  kind: PlanningDecisionKind;
  subjectType: "task" | "requirement";
  subjectId: string;
}

export type PlanningInconsistencyCode =
  /** Not started while every linked requirement is already terminal. */
  | "TASK_CONTRADICTS_REQUIREMENTS"
  /** Completed while a prerequisite is not completed. */
  | "COMPLETED_WITH_INCOMPLETE_PREREQUISITE"
  /** Completed, cancelled or archived while a linked task is still open. */
  | "MILESTONE_CLOSED_WITH_OPEN_TASK";

export interface PlanningInconsistency {
  code: PlanningInconsistencyCode;
  subjectType: "task" | "milestone";
  subjectId: string;
  relatedIds: string[];
}

export interface PlanningSnapshot {
  schemaVersion: typeof planningSnapshotSchemaVersion;
  /** `snapshot:sha256:<hex>` of the complete scoped projection. */
  snapshotId: string;
  scope: PlanningSnapshotScope;
  classes: PlanningDataClass[];
  authoritative: {
    milestones: PlanningMilestone[];
    tasks: PlanningTask[];
    requirements: PlanningRequirement[];
    dependencies: PlanningDependency[];
  };
  derived: {
    runnable: PlanningRunnableTask[];
    active: PlanningActiveTask[];
    blockers: PlanningBlocker[];
    decisions: PlanningDecision[];
    inconsistencies: PlanningInconsistency[];
  };
}

export type PlanningSnapshotItem =
  | PlanningMilestone
  | PlanningTask
  | PlanningRequirement
  | PlanningDependency
  | PlanningRunnableTask
  | PlanningActiveTask
  | PlanningBlocker
  | PlanningDecision
  | PlanningInconsistency;

export interface PlanningSnapshotPage {
  schemaVersion: typeof planningSnapshotSchemaVersion;
  snapshotId: string;
  scope: PlanningSnapshotScope;
  classes: PlanningDataClass[];
  /** Totals of every collection in the scope, independent of the window. */
  counts: Record<PlanningSnapshotCollection, number>;
  collection: PlanningSnapshotCollection;
  section: "authoritative" | "derived";
  page: { offset: number; limit: number; total: number; truncated: boolean };
  /** `sha256:<hex>` of the collection, window and items of this page. */
  pageDigest: string;
  items: PlanningSnapshotItem[];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

/** Code-unit order: locale-independent, so the output is the same on every host. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTasks(
  a: { priority: number; id: string },
  b: { priority: number; id: string },
): number {
  // Higher priority first, as on the board; the id makes the order total.
  return b.priority - a.priority || compareText(a.id, b.id);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function index<K, V>(pairs: Iterable<readonly [K, V]>): Map<K, V[]> {
  const result = new Map<K, V[]>();
  for (const [key, value] of pairs) {
    const list = result.get(key);
    if (list === undefined) result.set(key, [value]);
    else list.push(value);
  }
  return result;
}

/**
 * The complete snapshot of one scope. Readiness is evaluated over the whole
 * project graph, because a prerequisite outside a milestone still gates work
 * inside it; the result is then restricted to the scope.
 */
export function projectPlanningSnapshot(
  state: PlanningStateRecord,
  scope: PlanningSnapshotScope,
  classes: readonly PlanningDataClass[],
): PlanningSnapshot {
  const withTitles = classes.includes("T");
  const title = (value: string): { title?: string } =>
    withTitles ? { title: value } : {};

  const tasks = [...state.tasks].sort(compareTasks);
  const statuses = new Map(tasks.map((task) => [task.id, task.status]));
  const requirementById = new Map(state.requirements.map((r) => [r.id, r]));
  const prerequisitesOf = index(
    state.dependencies.map((edge) => [edge.taskId, edge.dependsOnTaskId]),
  );
  const requirementsOf = index(
    state.taskRequirementLinks.map((link) => [link.taskId, link.requirementId]),
  );
  const tasksOfRequirement = index(
    state.taskRequirementLinks.map((link) => [link.requirementId, link.taskId]),
  );
  const milestonesOf = new Map(
    tasks.map((task) => [
      task.id,
      sortedUnique(
        (requirementsOf.get(task.id) ?? []).flatMap((id) => {
          const milestoneId = requirementById.get(id)?.milestoneId;
          return milestoneId === null || milestoneId === undefined
            ? []
            : [milestoneId];
        }),
      ),
    ]),
  );
  const unmetStart = new Map(
    tasks.map((task) => [
      task.id,
      blockingPrerequisites(
        task.id,
        prerequisitesOf.get(task.id) ?? [],
        statuses,
      )
        .map((blocker) => blocker.taskId)
        .sort(compareText),
    ]),
  );

  const inScopeTask = (taskId: string): boolean =>
    scope.milestoneId === null ||
    (milestonesOf.get(taskId) ?? []).includes(scope.milestoneId);
  const scopedTasks = tasks.filter((task) => inScopeTask(task.id));
  const scopedMilestones = state.milestones.filter(
    (milestone) =>
      scope.milestoneId === null || milestone.id === scope.milestoneId,
  );
  const scopedRequirements = state.requirements
    .filter(
      (requirement) =>
        scope.milestoneId === null ||
        requirement.milestoneId === scope.milestoneId,
    )
    .sort((a, b) => compareText(a.key, b.key) || compareText(a.id, b.id));

  const milestones: PlanningMilestone[] = scopedMilestones.map((milestone) => ({
    milestoneId: milestone.id,
    ...title(milestone.title),
    status: milestone.status,
  }));
  const plannedTasks: PlanningTask[] = scopedTasks.map((task) => ({
    taskId: task.id,
    ...title(task.title),
    status: task.status,
    priority: task.priority,
    milestoneIds: milestonesOf.get(task.id) ?? [],
    requirementIds: sortedUnique(requirementsOf.get(task.id) ?? []),
    prerequisiteIds: sortedUnique(prerequisitesOf.get(task.id) ?? []),
  }));
  const requirements: PlanningRequirement[] = scopedRequirements.map(
    (requirement) => ({
      requirementId: requirement.id,
      key: requirement.key,
      ...title(requirement.title),
      status: requirement.status,
      milestoneId: requirement.milestoneId,
      taskIds: sortedUnique(tasksOfRequirement.get(requirement.id) ?? []),
    }),
  );
  const dependencies: PlanningDependency[] = state.dependencies
    .filter((edge) => inScopeTask(edge.taskId))
    .map((edge) => ({
      taskId: edge.taskId,
      dependsOnTaskId: edge.dependsOnTaskId,
    }))
    .sort(
      (a, b) =>
        compareText(a.taskId, b.taskId) ||
        compareText(a.dependsOnTaskId, b.dependsOnTaskId),
    );

  const runnable: PlanningRunnableTask[] = scopedTasks
    .filter(
      (task) =>
        // Not started yet, and admitted by the start rule of
        // ManageTaskDependencies.readiness (blockingPrerequisites "start").
        (task.status === "pending" || task.status === "assigned") &&
        (unmetStart.get(task.id) ?? []).length === 0,
    )
    .map((task) => ({
      taskId: task.id,
      status: task.status,
      priority: task.priority,
    }));
  const active: PlanningActiveTask[] = scopedTasks
    .filter(
      (task) => task.status === "running" || task.status === "waiting_review",
    )
    .map((task) => ({
      taskId: task.id,
      status: task.status,
      priority: task.priority,
    }));
  const blockers: PlanningBlocker[] = scopedTasks.flatMap((task) => {
    if (isTerminalTaskStatus(task.status)) return [];
    const unmet = unmetStart.get(task.id) ?? [];
    const reasons: PlanningBlockerReason[] = [];
    if (unmet.length > 0) reasons.push("unmet_prerequisites");
    if (task.status === "blocked") reasons.push("recorded_blocked");
    return reasons.length === 0
      ? []
      : [
          {
            taskId: task.id,
            status: task.status,
            reasons,
            unmetPrerequisiteIds: unmet,
          },
        ];
  });
  const decisions: PlanningDecision[] = [
    ...scopedTasks
      .filter((task) => task.status === "waiting_review")
      .map((task): PlanningDecision => ({
        kind: "task_review_pending",
        subjectType: "task",
        subjectId: task.id,
      })),
    ...scopedRequirements
      .filter((requirement) => requirement.status === "proposed")
      .map((requirement): PlanningDecision => ({
        kind: "requirement_proposed",
        subjectType: "requirement",
        subjectId: requirement.id,
      })),
  ];

  const inconsistencies: PlanningInconsistency[] = [];
  for (const task of scopedTasks) {
    const linked = sortedUnique(requirementsOf.get(task.id) ?? []);
    if (
      (task.status === "pending" || task.status === "assigned") &&
      linked.length > 0 &&
      linked.every((id) => {
        const status = requirementById.get(id)?.status;
        return status !== undefined && isTerminalRequirementStatus(status);
      })
    )
      inconsistencies.push({
        code: "TASK_CONTRADICTS_REQUIREMENTS",
        subjectType: "task",
        subjectId: task.id,
        relatedIds: linked,
      });
    if (task.status === "completed") {
      const incomplete = blockingPrerequisites(
        task.id,
        prerequisitesOf.get(task.id) ?? [],
        statuses,
        "completion",
      )
        .map((blocker) => blocker.taskId)
        .sort(compareText);
      if (incomplete.length > 0)
        inconsistencies.push({
          code: "COMPLETED_WITH_INCOMPLETE_PREREQUISITE",
          subjectType: "task",
          subjectId: task.id,
          relatedIds: incomplete,
        });
    }
  }
  for (const milestone of scopedMilestones) {
    if (
      milestone.status !== "completed" &&
      milestone.status !== "cancelled" &&
      milestone.status !== "archived"
    )
      continue;
    const open = tasks
      .filter(
        (task) =>
          !isTerminalTaskStatus(task.status) &&
          (milestonesOf.get(task.id) ?? []).includes(milestone.id),
      )
      .map((task) => task.id)
      .sort(compareText);
    if (open.length > 0)
      inconsistencies.push({
        code: "MILESTONE_CLOSED_WITH_OPEN_TASK",
        subjectType: "milestone",
        subjectId: milestone.id,
        relatedIds: open,
      });
  }
  inconsistencies.sort(
    (a, b) =>
      compareText(a.code, b.code) || compareText(a.subjectId, b.subjectId),
  );

  const body = {
    schemaVersion: planningSnapshotSchemaVersion,
    scope: { projectId: scope.projectId, milestoneId: scope.milestoneId },
    classes: [...new Set(classes)].sort(compareText),
    authoritative: {
      milestones,
      tasks: plannedTasks,
      requirements,
      dependencies,
    },
    derived: { runnable, active, blockers, decisions, inconsistencies },
  };
  return { ...body, snapshotId: `snapshot:sha256:${sha256(body)}` };
}

function collectionItems(
  snapshot: PlanningSnapshot,
  collection: PlanningSnapshotCollection,
): readonly PlanningSnapshotItem[] {
  switch (collection) {
    case "milestones":
    case "tasks":
    case "requirements":
    case "dependencies":
      return snapshot.authoritative[collection];
    case "runnable":
    case "active":
    case "blockers":
    case "decisions":
    case "inconsistencies":
      return snapshot.derived[collection];
  }
}

/** One window of one collection. The caller validates the window. */
export function planningSnapshotPage(
  snapshot: PlanningSnapshot,
  collection: PlanningSnapshotCollection,
  window: { offset: number; limit: number },
): PlanningSnapshotPage {
  const all = collectionItems(snapshot, collection);
  const items = all.slice(window.offset, window.offset + window.limit);
  const counts = Object.fromEntries(
    planningSnapshotCollections.map((name) => [
      name,
      collectionItems(snapshot, name).length,
    ]),
  ) as Record<PlanningSnapshotCollection, number>;
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    scope: snapshot.scope,
    classes: snapshot.classes,
    counts,
    collection,
    section: authoritativeCollections.has(collection)
      ? "authoritative"
      : "derived",
    page: {
      offset: window.offset,
      limit: window.limit,
      total: all.length,
      truncated: window.offset + items.length < all.length,
    },
    pageDigest: `sha256:${sha256({
      collection,
      offset: window.offset,
      limit: window.limit,
      items,
    })}`,
    items,
  };
}

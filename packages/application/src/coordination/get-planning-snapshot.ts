import { ProjectNotFoundError } from "../errors.ts";
import type { PlanningReadRepository } from "../ports/planning-read.port.ts";
import {
  planningSnapshotCollections,
  planningSnapshotLimits,
  planningSnapshotPage,
  projectPlanningSnapshot,
  type PlanningDataClass,
  type PlanningSnapshotCollection,
  type PlanningSnapshotPage,
} from "./planning-snapshot.ts";

/** A planning query whose collection, window or class set is not accepted. */
export class PlanningSnapshotQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningSnapshotQueryError";
  }
}

/** The requested milestone scope does not exist in the project. */
export class PlanningScopeNotFoundError extends Error {
  constructor(projectId: string, milestoneId: string) {
    super(`Milestone ${milestoneId} not found in project ${projectId}`);
    this.name = "PlanningScopeNotFoundError";
  }
}

export interface PlanningSnapshotQuery {
  projectId: string;
  milestoneId?: string | null | undefined;
  collection?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  /** Defaults to P and T. P cannot be left out. */
  classes?: readonly string[] | undefined;
}

function isCollection(value: string): value is PlanningSnapshotCollection {
  return (planningSnapshotCollections as readonly string[]).includes(value);
}

function classSet(values: readonly string[]): PlanningDataClass[] {
  const unique = [...new Set(values)];
  if (!unique.includes("P") || unique.some((v) => v !== "P" && v !== "T"))
    throw new PlanningSnapshotQueryError(
      "Planning data classes must be P or P,T",
    );
  return unique as PlanningDataClass[];
}

function windowValue(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  )
    throw new PlanningSnapshotQueryError(
      `Planning ${name} must be an integer from ${minimum} to ${maximum}`,
    );
  return resolved;
}

/**
 * One page of the planning read model. Read-only: it reads one consistent
 * planning state and writes nothing, not even audit.
 */
export class GetPlanningSnapshot {
  constructor(private readonly reads: PlanningReadRepository) {}

  async execute(query: PlanningSnapshotQuery): Promise<PlanningSnapshotPage> {
    const collection = query.collection ?? "tasks";
    if (!isCollection(collection))
      throw new PlanningSnapshotQueryError(
        `Planning collection must be one of: ${planningSnapshotCollections.join(", ")}`,
      );
    const offset = windowValue(
      "offset",
      query.offset,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = windowValue(
      "limit",
      query.limit,
      planningSnapshotLimits.defaultLimit,
      1,
      planningSnapshotLimits.maxLimit,
    );
    const classes = classSet(query.classes ?? ["P", "T"]);
    const milestoneId = query.milestoneId ?? null;

    const state = await this.reads.readPlanningState(query.projectId);
    if (state === null) throw new ProjectNotFoundError(query.projectId);
    if (
      milestoneId !== null &&
      !state.milestones.some((milestone) => milestone.id === milestoneId)
    )
      throw new PlanningScopeNotFoundError(query.projectId, milestoneId);

    const snapshot = projectPlanningSnapshot(
      state,
      { projectId: query.projectId, milestoneId },
      classes,
    );
    return planningSnapshotPage(snapshot, collection, { offset, limit });
  }
}

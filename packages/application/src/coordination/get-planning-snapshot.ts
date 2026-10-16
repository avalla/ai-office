import { ProjectNotFoundError } from "../errors.ts";
import {
  PlanningReadBusyError,
  type PlanningReadRepository,
} from "../ports/planning-read.port.ts";
import {
  planningSnapshotCollections,
  planningSnapshotLimits,
  planningSnapshotPage,
  projectPlanningSnapshot,
  type PlanningDataClass,
  type PlanningSnapshot,
  type PlanningSnapshotCollection,
  type PlanningSnapshotPage,
} from "./planning-snapshot.ts";

/** How a read that meets an open writer transaction is retried. */
export interface PlanningReadBusyRetry {
  /** Total attempts, the first included. */
  attempts: number;
  delayMs: number;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultBusyRetry: PlanningReadBusyRetry = {
  attempts: 5,
  delayMs: 20,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

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

/** Validates a requested class set: P, optionally with T. */
export function planningClassSet(
  values: readonly string[],
): PlanningDataClass[] {
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
 * planning state and appends no planning or domain audit.
 */
export class GetPlanningSnapshot {
  constructor(
    private readonly reads: PlanningReadRepository,
    private readonly busy: PlanningReadBusyRetry = defaultBusyRetry,
  ) {}

  async execute(query: PlanningSnapshotQuery): Promise<PlanningSnapshotPage> {
    return (await this.executeWithSnapshot(query)).page;
  }

  /**
   * The page together with the complete snapshot it was cut from, from one
   * read, for callers that also need the whole scope.
   */
  async executeWithSnapshot(
    query: PlanningSnapshotQuery,
  ): Promise<{ snapshot: PlanningSnapshot; page: PlanningSnapshotPage }> {
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
    const snapshot = await this.readSnapshot(query);
    return {
      snapshot,
      page: planningSnapshotPage(snapshot, collection, { offset, limit }),
    };
  }

  /** The complete snapshot of one validated scope, before pagination. */
  async readSnapshot(
    query: Pick<PlanningSnapshotQuery, "projectId" | "milestoneId" | "classes">,
  ): Promise<PlanningSnapshot> {
    const classes = planningClassSet(query.classes ?? ["P", "T"]);
    const milestoneId = query.milestoneId ?? null;

    const state = await this.readState(query.projectId);
    if (state === null) throw new ProjectNotFoundError(query.projectId);
    if (
      milestoneId !== null &&
      !state.milestones.some((milestone) => milestone.id === milestoneId)
    )
      throw new PlanningScopeNotFoundError(query.projectId, milestoneId);

    return projectPlanningSnapshot(
      state,
      { projectId: query.projectId, milestoneId },
      classes,
    );
  }

  /**
   * Writer transactions on the shared connection are short, so a read that
   * meets one waits briefly and retries; only a write still open after the
   * last attempt surfaces as {@link PlanningReadBusyError}.
   */
  private async readState(projectId: string) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.reads.readPlanningState(projectId);
      } catch (error) {
        if (
          !(error instanceof PlanningReadBusyError) ||
          attempt >= this.busy.attempts
        )
          throw error;
        await this.busy.sleep(this.busy.delayMs);
      }
    }
  }
}

import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";

/** One persisted Task <-> Requirement link. */
export interface TaskRequirementLink {
  taskId: string;
  requirementId: string;
  createdAt: Date;
}

/** A requirement as seen from the task that links it. */
export interface LinkedRequirement {
  requirementId: string;
  key: string;
  title: string;
  status: RequirementStatus;
}

/**
 * Read and write side of the explicit Task <-> Requirement relation.
 *
 * The relation is many-to-many: one task can deliver several requirements and
 * one requirement can need several tasks, so neither side owns the other. Every
 * method is project-scoped because a link may never cross a project boundary.
 */
export interface TaskRequirementRepository {
  /**
   * Creates the link. Returns false when it already existed, so a caller can
   * distinguish "created" from "already linked" without a prior read.
   */
  link(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
    now: Date;
  }): Promise<boolean>;

  /** Removes the link. Returns false when there was nothing to remove. */
  unlink(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
  }): Promise<boolean>;

  /** Requirements linked to one task, ordered by requirement key. */
  listForTask(
    projectId: string,
    taskId: string,
  ): Promise<LinkedRequirement[]>;

  /**
   * Requirements linked to each of the given tasks, in one query. Used by the
   * board and by reconciliation so neither issues a query per task.
   */
  listForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, LinkedRequirement[]>>;

  /** Every link of a project, for portable export. Ordered deterministically. */
  listByProject(projectId: string): Promise<TaskRequirementLink[]>;
}

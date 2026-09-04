/**
 * Explicit Task <-> Requirement linkage.
 *
 * The relation is many-to-many because both directions are real: one task can
 * deliver several requirements, and one requirement can need several tasks.
 * Nothing is inferred — a link exists because an operator created it. Matching
 * a task title against a requirement key would be an unverifiable heuristic, and
 * persisting a guess is worse than persisting nothing.
 */

import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { GovernanceRepository } from "../ports/governance-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type {
  LinkedRequirement,
  TaskRequirementRepository,
} from "../ports/task-requirement-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { TaskNotFoundError } from "./schedule-agent-run.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";

export class RequirementNotFoundError extends Error {
  constructor(id: string) {
    super(`Requirement ${id} not found`);
    this.name = "RequirementNotFoundError";
  }
}

export class TaskRequirementLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRequirementLinkError";
  }
}

export interface TaskRequirementInput {
  projectId: string;
  taskId: string;
  requirementId: string;
  actorId: string;
}

export class ManageTaskRequirements {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly governance: GovernanceRepository,
    private readonly links: TaskRequirementRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * Links a task to a requirement.
   *
   * Linking is idempotent on purpose, unlike a lifecycle transition: the link is
   * a fact about a relation, not an event, so asking for a relation that already
   * holds is not an error. `created` reports which happened, and a repeat emits
   * no audit event because nothing changed.
   */
  async link(input: TaskRequirementInput): Promise<{ created: boolean }> {
    await this.requireBothEnds(input);
    let created = false;
    await this.transactions.run(async () => {
      created = await this.links.link({
        projectId: input.projectId,
        taskId: input.taskId,
        requirementId: input.requirementId,
        now: this.clock.now(),
      });
      if (!created) return;
      await this.audit.execute({
        eventType: "task.requirement_linked",
        actorType: "cli",
        actorId: input.actorId,
        projectId: input.projectId,
        aggregateType: "task",
        aggregateId: input.taskId,
        payload: { requirementId: input.requirementId },
      });
    });
    return { created };
  }

  /** Removes a link. Unlinking something already absent is likewise not an error. */
  async unlink(input: TaskRequirementInput): Promise<{ removed: boolean }> {
    await this.requireBothEnds(input);
    let removed = false;
    await this.transactions.run(async () => {
      removed = await this.links.unlink({
        projectId: input.projectId,
        taskId: input.taskId,
        requirementId: input.requirementId,
      });
      if (!removed) return;
      await this.audit.execute({
        eventType: "task.requirement_unlinked",
        actorType: "cli",
        actorId: input.actorId,
        projectId: input.projectId,
        aggregateType: "task",
        aggregateId: input.taskId,
        payload: { requirementId: input.requirementId },
      });
    });
    return { removed };
  }

  async listForTask(
    projectId: string,
    taskId: string,
  ): Promise<LinkedRequirement[]> {
    await this.requireProject(projectId);
    await this.requireTask(projectId, taskId);
    return this.links.listForTask(projectId, taskId);
  }

  /**
   * Both ends must exist *and* belong to the named project.
   *
   * The database trigger enforces this too, but it must be checked here as
   * well: a trigger produces a storage error, and the application boundary owes
   * the caller a typed one that names which end is wrong.
   */
  private async requireBothEnds(input: TaskRequirementInput): Promise<void> {
    await this.requireProject(input.projectId);
    await this.requireTask(input.projectId, input.taskId);
    // `findStatus` is project-scoped, so a requirement of another project reads
    // as absent — the caller learns nothing about projects it did not name.
    const status = await this.governance.findStatus(
      "requirement",
      input.requirementId,
      input.projectId,
    );
    if (status === null)
      throw new RequirementNotFoundError(input.requirementId);
  }

  private async requireProject(projectId: string): Promise<void> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
  }

  private async requireTask(projectId: string, taskId: string): Promise<void> {
    const task = await this.tasks.findById(taskId);
    if (task === null || task.snapshot().projectId !== projectId)
      throw new TaskNotFoundError(taskId);
  }
}

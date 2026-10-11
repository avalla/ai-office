/**
 * Read-only reconciliation of task state against the work it represents.
 *
 * Nothing here derives task status. It compares the persisted task against
 * persisted pipelines, agent runs, and linked requirements and reports where
 * they contradict each other. Detection never writes.
 *
 * Repair is deliberately narrow. Exactly one finding has an outcome the
 * codebase already defines — a terminal pipeline whose task never followed it,
 * which `ManagePipelineRuns.syncTaskTerminal` would have produced had its
 * transaction not been interrupted. Everything else is reported and refused,
 * because guessing a task's history from circumstantial evidence fabricates
 * project history, and a wrong `completed` is unrecoverable.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import {
  allowedTaskTransitions,
  isHistoricalCompletionApplicable,
  isTerminalTaskStatus,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TaskRequirementRepository } from "../ports/task-requirement-repository.port.ts";
import type { GovernanceRepository } from "../ports/governance-repository.port.ts";
import type { TaskDependencyRepository } from "../ports/task-dependency-repository.port.ts";
import {
  assertAcyclicDependency,
  blockingPrerequisites,
} from "@ai-office/domain/task/task-dependency.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  taskLifecycleOperations,
  type ManageTaskLifecycle,
  type TaskLifecycleOperation,
} from "./manage-task-lifecycle.ts";
import { taskCompletionRecordCommand } from "./record-task-completion.ts";
import {
  requirementProgress,
  type RequirementProgress,
} from "./task-requirement-progress.ts";

/** Every contradiction reconciliation knows how to name. */
export type TaskReconciliationFinding =
  /** A pipeline reached a terminal state; its task did not follow. */
  | "terminal_pipeline_open_task"
  /** A pipeline is still active while its task is already terminal. */
  | "active_pipeline_terminal_task"
  /** Every explicitly linked requirement is terminal; the task is not started. */
  | "stale_pending_task"
  /** The task is completed while linked requirements are still open. */
  | "completed_task_open_requirements"
  /** The task claims to be in flight with nothing executing it. */
  | "in_flight_task_without_execution"
  | "completed_milestone_active_task"
  | "verified_requirement_competing_tasks"
  | "verified_requirement_duplicate_tasks"
  | "blocking_prerequisite_incomplete"
  | "invalid_task_dependency";

export type TaskReconciliationSeverity = "inconsistent" | "warning";

export interface TaskReconciliationIssue {
  finding: TaskReconciliationFinding;
  severity: TaskReconciliationSeverity;
  taskId: string;
  title: string;
  status: TaskStatus;
  /** Safe human text naming the persisted facts that disagree. */
  summary: string;
  /**
   * The command an operator would run next, or null when none applies.
   *
   * Always executable from `status` as shown. A suggestion the current state
   * would reject is worse than no suggestion: it sends an operator to a command
   * that refuses, and the only way to force it through would be to fabricate the
   * intermediate history this board exists to protect.
   */
  suggestedCommand: string | null;
  /**
   * The lifecycle operation `--fix` would apply. Null whenever the repair is
   * refused, including when the suggestion is a manual correction rather than a
   * lifecycle transition.
   */
  repairOperation: TaskLifecycleOperation | null;
  /**
   * Whether `--fix` will act on this issue. False means the evidence does not
   * determine a single correct outcome, so the repair is refused with a reason.
   */
  repairable: boolean;
  /** Why a repair is refused. Null when `repairable` is true. */
  refusalReason: string | null;
}

export interface TaskReconciliationReport {
  projectId: string;
  generatedAt: string;
  tasksInspected: number;
  issues: readonly TaskReconciliationIssue[];
  /**
   * Present only when at least one issue is repairable. An operator re-runs
   * with `--fix --approve <planHash>`; the hash covers the exact repairs
   * listed, so a plan that has gone stale is refused rather than reapplied to
   * different state.
   */
  planHash: string | null;
}

export interface TaskRepairResult {
  applied: readonly {
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    operation: TaskLifecycleOperation;
  }[];
  refused: readonly TaskReconciliationIssue[];
}

export class TaskReconciliationApprovalError extends Error {
  constructor() {
    super(
      "Reconciliation plan approval does not match the current plan; re-run task:reconcile and approve the new plan hash",
    );
    this.name = "TaskReconciliationApprovalError";
  }
}

const activeRunStatuses = new Set([
  "queued",
  "preparing",
  "running",
  "reviewing",
]);

/** Statuses that assert work is under way right now. */
const inFlightTaskStatuses = new Set<TaskStatus>([
  "assigned",
  "running",
  "waiting_review",
]);

// Re-exported so existing callers keep one import for "the board's numbers",
// while the calculation itself lives outside this command.
export { requirementProgress, type RequirementProgress };

export class ReconcileTasks {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly pipelines: PipelineRunRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly links: TaskRequirementRepository,
    private readonly lifecycle: ManageTaskLifecycle,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly governance?: GovernanceRepository,
    private readonly dependencies?: TaskDependencyRepository,
  ) {}

  /** Detection. Performs no write of any kind. */
  async inspect(projectId: string): Promise<TaskReconciliationReport> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);

    const tasks = (await this.tasks.listByProject(projectId)).map((task) =>
      task.snapshot(),
    );
    const [pipelines, runs, linked, governance, dependencies] =
      await Promise.all([
        this.pipelines.listByProject(projectId),
        this.runtime.listRuns(projectId),
        this.links.listForTasks(
          projectId,
          tasks.map((task) => task.id),
        ),
        this.governance?.getSnapshot(projectId),
        this.dependencies?.listByProject(projectId),
      ]);

    const requirementById = new Map(
      governance?.requirements.map((item) => [item.id, item] as const) ?? [],
    );
    const milestoneById = new Map(
      governance?.milestones.map((item) => [item.id, item] as const) ?? [],
    );
    const statusByTask = new Map(
      tasks.map((item) => [item.id, item.status] as const),
    );
    const tasksByRequirement = new Map<string, typeof tasks>();
    for (const task of tasks)
      for (const requirement of linked.get(task.id) ?? []) {
        const values = tasksByRequirement.get(requirement.requirementId) ?? [];
        values.push(task);
        tasksByRequirement.set(requirement.requirementId, values);
      }

    const pipelinesByTask = new Map<
      string,
      ReturnType<(typeof pipelines)[number]["snapshot"]>[]
    >();
    for (const pipeline of pipelines) {
      const snapshot = pipeline.snapshot();
      const list = pipelinesByTask.get(snapshot.taskId) ?? [];
      list.push(snapshot);
      pipelinesByTask.set(snapshot.taskId, list);
    }

    const activeRunTasks = new Set(
      runs
        .map((run) => run.snapshot())
        .filter((run) => activeRunStatuses.has(run.status))
        .map((run) => run.taskId),
    );

    const issues: TaskReconciliationIssue[] = [];
    for (const task of tasks) {
      const taskPipelines = pipelinesByTask.get(task.id) ?? [];
      const requirements = linked.get(task.id) ?? [];
      const progress = requirementProgress(requirements);
      const base = { taskId: task.id, title: task.title, status: task.status };

      if (dependencies !== undefined) {
        const prerequisites = dependencies.filter(
          (edge) => edge.taskId === task.id,
        );
        try {
          const blockedBy = blockingPrerequisites(
            task.id,
            prerequisites.map((edge) => edge.dependsOnTaskId),
            statusByTask,
          );
          if (blockedBy.length > 0 && !isTerminalTaskStatus(task.status)) {
            const started =
              task.status === "running" || task.status === "waiting_review";
            const unmet = blockedBy
              .map((item) => `${item.taskId} (${item.status})`)
              .join(", ");
            issues.push({
              ...base,
              finding: "blocking_prerequisite_incomplete",
              severity: "warning",
              summary: started
                ? `started with prerequisites neither completed nor in review: ${unmet}; completing it requires every prerequisite completed`
                : `cannot start until prerequisites are completed or in review: ${unmet}`,
              suggestedCommand: null,
              repairOperation: null,
              repairable: false,
              refusalReason: started
                ? "prerequisites must be completed before this task can complete; resolve them through their own lifecycle"
                : "prerequisites must reach review or completion through their own lifecycle",
            });
          }
        } catch {
          issues.push({
            ...base,
            finding: "invalid_task_dependency",
            severity: "inconsistent",
            summary: "a prerequisite task reference is missing",
            suggestedCommand: null,
            repairOperation: null,
            repairable: false,
            refusalReason: "planning reference requires operator inspection",
          });
        }
      }

      for (const linkedRequirement of requirements) {
        const requirement = requirementById.get(
          linkedRequirement.requirementId,
        );
        const milestone =
          requirement?.milestoneId === undefined
            ? undefined
            : milestoneById.get(requirement.milestoneId);
        if (
          (milestone?.status === "completed" ||
            milestone?.status === "archived") &&
          inFlightTaskStatuses.has(task.status)
        )
          issues.push({
            ...base,
            finding: "completed_milestone_active_task",
            severity: "inconsistent",
            summary: `completed milestone ${milestone.title} still has task ${task.status}`,
            suggestedCommand: null,
            repairOperation: null,
            repairable: false,
            refusalReason: "milestone status cannot attest to a task outcome",
          });
        if (requirement?.status !== "verified") continue;
        const peers = tasksByRequirement.get(requirement.id) ?? [];
        const competing = peers.find(
          (peer) =>
            peer.id !== task.id &&
            peer.status === "completed" &&
            inFlightTaskStatuses.has(task.status) &&
            similarTaskTitles(peer.title, task.title),
        );
        if (competing !== undefined)
          issues.push({
            ...base,
            finding: "verified_requirement_competing_tasks",
            severity: "warning",
            summary: `verified requirement ${requirement.key} has completed task ${competing.id} and similar task ${task.id} still ${task.status}`,
            suggestedCommand: null,
            repairOperation: null,
            repairable: false,
            refusalReason:
              "multiple linked tasks may be legitimate slices; an operator must reconcile duplicates",
          });
        const duplicate = peers.find(
          (peer) =>
            peer.id !== task.id &&
            isTerminalTaskStatus(peer.status) &&
            isTerminalTaskStatus(task.status) &&
            (peer.createdAt.getTime() < task.createdAt.getTime() ||
              (peer.createdAt.getTime() === task.createdAt.getTime() &&
                peer.id < task.id)) &&
            similarTaskTitles(peer.title, task.title),
        );
        if (duplicate !== undefined)
          issues.push({
            ...base,
            finding: "verified_requirement_duplicate_tasks",
            severity: "warning",
            summary: `verified requirement ${requirement.key} links similar terminal tasks ${duplicate.id} and ${task.id}`,
            suggestedCommand: null,
            repairOperation: null,
            repairable: false,
            refusalReason:
              "terminal task history is immutable; inspect links and document supersession",
          });
      }

      const terminalPipelines = taskPipelines.filter(
        (value) => value.status !== "active",
      );
      const activePipelines = taskPipelines.filter(
        (value) => value.status === "active",
      );

      // 1. A terminal pipeline whose task never followed it.
      let explainedByPipeline = false;
      if (terminalPipelines.length > 0 && !isTerminalTaskStatus(task.status)) {
        explainedByPipeline = true;
        const outcomes = new Set(
          terminalPipelines.map((value) => value.status),
        );
        // Two pipelines that ended differently do not determine one outcome,
        // and an active pipeline means work is still in flight.
        const ambiguous = outcomes.size > 1 || activePipelines.length > 0;
        const target = terminalPipelines.some(
          (value) => value.status === "completed",
        )
          ? "completed"
          : "cancelled";
        const operation: TaskLifecycleOperation =
          target === "completed" ? "complete" : "cancel";
        const reachable = this.lifecycleAllows(task.status, target);
        // `complete` is refused while a prerequisite is not completed, so an
        // approved plan must not offer it.
        const prerequisitesOpen =
          operation === "complete" &&
          dependencies !== undefined &&
          blockingPrerequisites(
            task.id,
            dependencies
              .filter((edge) => edge.taskId === task.id)
              .map((edge) => edge.dependsOnTaskId),
            statusByTask,
            "completion",
          ).length > 0;
        const repairable = !ambiguous && reachable && !prerequisitesOpen;
        issues.push({
          ...base,
          finding: "terminal_pipeline_open_task",
          severity: "inconsistent",
          summary: `pipeline ${[...outcomes].join("/")} while task is ${task.status}`,
          // When the lifecycle cannot reach the pipeline's outcome, the honest
          // next step is the explicit operator correction, not a transition the
          // task would reject.
          suggestedCommand: prerequisitesOpen
            ? null
            : reachable
              ? taskLifecycleOperations[operation].command
              : correctionCommandFor(task.status, target),
          repairOperation: repairable ? operation : null,
          repairable,
          refusalReason: ambiguous
            ? "pipelines for this task disagree or one is still active"
            : reachable
              ? prerequisitesOpen
                ? "completion requires every prerequisite to be completed"
                : null
              : `task cannot move from ${task.status} to ${target}`,
        });
      }

      // 2. An active pipeline under a task that is already terminal.
      if (activePipelines.length > 0 && isTerminalTaskStatus(task.status))
        issues.push({
          ...base,
          finding: "active_pipeline_terminal_task",
          severity: "inconsistent",
          summary: `pipeline still active while task is ${task.status}`,
          suggestedCommand: null,
          repairOperation: null,
          repairable: false,
          refusalReason:
            "a terminal task cannot be reopened, and cancelling live execution is not a reconciliation decision",
        });

      // 3. The reported symptom: nothing started, everything accepted.
      if (
        (task.status === "pending" || task.status === "assigned") &&
        progress.total > 0 &&
        progress.open === 0
      )
        issues.push({
          ...base,
          finding: "stale_pending_task",
          severity: "warning",
          summary: `task is ${task.status} while ${progress.terminal}/${progress.total} linked requirements are terminal`,
          // `task:complete` is deliberately not named here: the lifecycle
          // refuses it from a task that never started, and the workaround —
          // task:start followed by task:complete — would enter a moment at
          // which work began that nobody observed. What is offered instead is
          // the explicit attestation, which the operator makes and the system
          // never infers.
          suggestedCommand: correctionCommandFor(task.status, "completed"),
          repairOperation: null,
          repairable: false,
          refusalReason:
            "requirement completion alone is insufficient evidence that operational work completed",
        });

      // 4. Completed work whose acceptance is still open.
      if (task.status === "completed" && progress.open > 0)
        issues.push({
          ...base,
          finding: "completed_task_open_requirements",
          severity: "warning",
          summary: `task is completed while ${progress.open}/${progress.total} linked requirements are still open`,
          suggestedCommand: null,
          repairOperation: null,
          repairable: false,
          refusalReason:
            "requirement acceptance is governance state and is never changed by task reconciliation",
        });

      // 5. In flight according to the board, with nothing executing it.
      //
      // Skipped when finding 1 already fired: a task left behind by a terminal
      // pipeline is the same situation described more precisely, and reporting
      // it twice would make one defect look like two.
      if (
        !explainedByPipeline &&
        inFlightTaskStatuses.has(task.status) &&
        activePipelines.length === 0 &&
        !activeRunTasks.has(task.id)
      )
        issues.push({
          ...base,
          finding: "in_flight_task_without_execution",
          severity: "warning",
          summary: `task is ${task.status} with no active pipeline run and no active agent run`,
          suggestedCommand: null,
          repairOperation: null,
          repairable: false,
          refusalReason:
            "absence of execution does not distinguish finished, abandoned, and blocked work",
        });
    }

    if (dependencies !== undefined) {
      const validated: { taskId: string; dependsOnTaskId: string }[] = [];
      for (const edge of dependencies) {
        try {
          assertAcyclicDependency(edge.taskId, edge.dependsOnTaskId, validated);
        } catch {
          const task = tasks.find((item) => item.id === edge.taskId);
          if (task !== undefined)
            issues.push({
              taskId: task.id,
              title: task.title,
              status: task.status,
              finding: "invalid_task_dependency",
              severity: "inconsistent",
              summary: "blocking dependencies contain a cycle",
              suggestedCommand: null,
              repairOperation: null,
              repairable: false,
              refusalReason: "cycle requires explicit operator correction",
            });
        }
        validated.push(edge);
      }
    }

    const repairs = issues.filter((issue) => issue.repairable);
    return {
      projectId,
      generatedAt: this.clock.now().toISOString(),
      tasksInspected: tasks.length,
      issues,
      planHash: repairs.length === 0 ? null : planHash(projectId, repairs),
    };
  }

  /**
   * Applies only the repairs whose outcome existing code already defines, and
   * only against the exact plan the operator approved.
   *
   * One approved plan is one transaction. The operator approved a set of
   * repairs, not a prefix of one: committing repair A and then failing on
   * repair B would leave the project in a state nobody approved and no result
   * object describes, while the plan hash they hold would go on claiming
   * otherwise. So the whole batch commits or none of it does.
   *
   * The plan is re-derived *inside* that transaction and the approval is
   * checked against it, because the hash must describe the state actually being
   * mutated rather than a reading taken before the transaction opened.
   *
   * Every mutation still goes through the lifecycle service, so the domain
   * guard and the audit event are the same ones a manual command would use;
   * only transaction ownership moves out here. No status is written by this
   * command, in SQL or otherwise.
   */
  async repair(input: {
    projectId: string;
    approvedPlanHash: string;
    actorId: string;
  }): Promise<TaskRepairResult> {
    return this.transactions.run(async () => {
      const report = await this.inspect(input.projectId);
      if (
        report.planHash === null ||
        report.planHash !== input.approvedPlanHash
      )
        throw new TaskReconciliationApprovalError();

      // Narrowed once, from the same `repairable` flag the plan hash was
      // computed over, so the batch applied is exactly the batch approved.
      const repairs = report.issues.flatMap((issue) =>
        issue.repairable && issue.repairOperation !== null
          ? [{ issue, operation: issue.repairOperation }]
          : [],
      );
      if (repairs.length !== report.issues.filter((i) => i.repairable).length)
        throw new TaskReconciliationApprovalError();

      const applied: {
        taskId: string;
        from: TaskStatus;
        to: TaskStatus;
        operation: TaskLifecycleOperation;
      }[] = [];
      for (const { issue, operation } of repairs) {
        const to = await this.lifecycle.applyWithinCurrentTransaction({
          projectId: input.projectId,
          taskId: issue.taskId,
          actorId: input.actorId,
          operation,
          ...(operation === "cancel"
            ? { reason: "reconciled with terminal pipeline" }
            : {}),
        });
        applied.push({
          taskId: issue.taskId,
          from: issue.status,
          to,
          operation,
        });
      }
      return {
        applied,
        refused: report.issues.filter((issue) => !issue.repairable),
      };
    });
  }

  /**
   * Whether the lifecycle permits the repair without a second hop. A repair
   * that needed an intermediate transition would be inventing history, so it is
   * refused instead.
   */
  private lifecycleAllows(from: TaskStatus, to: TaskStatus): boolean {
    // Reads the domain's table rather than restating it, so a lifecycle change
    // cannot leave reconciliation proposing a transition that no longer exists.
    return allowedTaskTransitions(from).includes(to);
  }
}

/**
 * The explicit correction available from this state, or null when none is.
 *
 * Reconciliation never performs it — it is an operator attestation — but naming
 * it keeps the report's advice executable instead of leaving a dead end where
 * the lifecycle cannot help.
 */
function correctionCommandFor(from: TaskStatus, to: TaskStatus): string | null {
  return to === "completed" && isHistoricalCompletionApplicable(from)
    ? taskCompletionRecordCommand
    : null;
}

function similarTaskTitles(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/^[a-z]{1,12}-\d+[a-z]?:\s*/u, "")
      .replace(/[^a-z0-9]+/gu, " ")
      .trim();
  const a = normalize(left);
  const b = normalize(right);
  return (
    a.length >= 12 &&
    b.length >= 12 &&
    (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `))
  );
}

function planHash(
  projectId: string,
  repairs: readonly TaskReconciliationIssue[],
): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        projectId,
        repairs: repairs.map((issue) => ({
          taskId: issue.taskId,
          finding: issue.finding,
          from: issue.status,
          // The operation, not the human-facing suggestion: the hash must
          // cover what would be executed.
          operation: issue.repairOperation,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

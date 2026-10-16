import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import { blockingPrerequisites } from "@ai-office/domain/task/task-dependency.ts";
import { isTerminalTaskStatus } from "@ai-office/domain/task/task.ts";
import { isPrerequisiteRefusal } from "../commands/manage-task-dependencies.ts";
import {
  ConcurrentPipelineTransitionError,
  PipelineActorUnauthorizedError,
} from "../pipeline-errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type { TaskDependencyRepository } from "../ports/task-dependency-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type {
  ManagePipelineRuns,
  PipelineResumption,
} from "./manage-pipeline-runs.ts";

export type PipelineRecoveryOutcome =
  | "resumed"
  | "awaiting_prerequisites"
  | "superseded";

export interface SuspendedStageCandidate {
  readonly pipelineRunId: string;
  readonly pipelineStageRunId: string;
  readonly agentRunId: string;
  readonly taskId: string;
}

export interface SuspendedStageRecovery extends SuspendedStageCandidate {
  readonly outcome: PipelineRecoveryOutcome;
}

export interface PipelineRecoveryResult {
  readonly projectId: string;
  readonly trigger: PipelineResumption["trigger"];
  readonly recoveries: readonly SuspendedStageRecovery[];
}

/**
 * The durable artifact of a refused stage completion: an active pipeline run
 * whose current stage is still active with a completed AgentRun bound to it.
 * Nothing else is a candidate, so the scan never touches queued, running, or
 * terminal work. Ordered by pipeline run id so every trigger scans the same
 * sequence.
 */
export function findSuspendedStageCandidates(
  runs: readonly PipelineRun[],
  agentRuns: readonly AgentRun[],
): SuspendedStageCandidate[] {
  const completedRunByStage = new Map<string, string>();
  for (const agentRun of agentRuns) {
    const snapshot = agentRun.snapshot();
    if (
      snapshot.status === "completed" &&
      snapshot.pipelineStageRunId !== undefined &&
      !completedRunByStage.has(snapshot.pipelineStageRunId)
    )
      completedRunByStage.set(snapshot.pipelineStageRunId, snapshot.id);
  }
  const candidates: SuspendedStageCandidate[] = [];
  for (const run of runs) {
    const snapshot = run.snapshot();
    if (snapshot.status !== "active") continue;
    const stage = run.currentStage();
    if (stage === null || stage.status !== "active") continue;
    const agentRunId = completedRunByStage.get(stage.id);
    if (agentRunId === undefined) continue;
    candidates.push({
      pipelineRunId: snapshot.id,
      pipelineStageRunId: stage.id,
      agentRunId,
      taskId: snapshot.taskId,
    });
  }
  return candidates.sort((left, right) =>
    left.pipelineRunId.localeCompare(right.pipelineRunId),
  );
}

/**
 * Resumes pipelines whose stage completion was refused while a prerequisite
 * was still in review (the review-ready admission guard).
 *
 * Every trigger — the orchestration replay, a run tick, a task completion —
 * runs the same scan, and the resume itself goes through
 * `completeStageFromAgentRun`, whose version check and stage-binding
 * revalidation make concurrent or repeated triggers lose with a typed
 * refusal instead of a duplicate effect. A prerequisite that regressed
 * between the scan and the write is refused again inside the resume
 * transaction and reported as still awaiting, never forced.
 */
export class RecoverSuspendedPipelines {
  constructor(
    private readonly pipelines: PipelineRunRepository,
    private readonly agents: AgentRuntimeRepository,
    private readonly tasks: TaskRepository,
    private readonly taskDependencies: TaskDependencyRepository | undefined,
    private readonly pipelineManagement: Pick<
      ManagePipelineRuns,
      "completeStageFromAgentRun"
    >,
  ) {}

  async execute(input: {
    projectId: string;
    trigger: PipelineResumption["trigger"];
    triggerTaskId?: string;
  }): Promise<PipelineRecoveryResult> {
    const [runs, agentRuns, allTasks, edges] = await Promise.all([
      this.pipelines.listByProject(input.projectId),
      this.agents.listRuns(input.projectId),
      this.tasks.listByProject(input.projectId),
      this.taskDependencies === undefined
        ? Promise.resolve([])
        : this.taskDependencies.listByProject(input.projectId),
    ]);
    const statuses = new Map(
      allTasks.map(
        (task) => [task.snapshot().id, task.snapshot().status] as const,
      ),
    );
    const terminalTasks = new Set(
      allTasks
        .filter((task) => isTerminalTaskStatus(task.snapshot().status))
        .map((task) => task.snapshot().id),
    );

    const recoveries: SuspendedStageRecovery[] = [];
    for (const candidate of findSuspendedStageCandidates(runs, agentRuns)) {
      // A task that reached a terminal state while its pipeline was
      // suspended is a contradiction for reconciliation to surface, not
      // something recovery completes underneath.
      if (terminalTasks.has(candidate.taskId)) {
        recoveries.push({ ...candidate, outcome: "superseded" });
        continue;
      }
      const blockedBy = blockingPrerequisites(
        candidate.taskId,
        edges
          .filter((edge) => edge.taskId === candidate.taskId)
          .map((edge) => edge.dependsOnTaskId),
        statuses,
        "completion",
      );
      if (blockedBy.length > 0) {
        recoveries.push({ ...candidate, outcome: "awaiting_prerequisites" });
        continue;
      }
      try {
        await this.pipelineManagement.completeStageFromAgentRun({
          projectId: input.projectId,
          agentRunId: candidate.agentRunId,
          expectedPipelineRunId: candidate.pipelineRunId,
          resumption: {
            trigger: input.trigger,
            ...(input.triggerTaskId === undefined
              ? {}
              : { triggerTaskId: input.triggerTaskId }),
          },
        });
        recoveries.push({ ...candidate, outcome: "resumed" });
      } catch (error) {
        // The prerequisite regressed between the scan and the write, or a
        // concurrent trigger completed the stage first: both are legitimate
        // outcomes of an idempotent recovery, never failures.
        if (isPrerequisiteRefusal(error)) {
          recoveries.push({ ...candidate, outcome: "awaiting_prerequisites" });
          continue;
        }
        if (
          error instanceof ConcurrentPipelineTransitionError ||
          error instanceof PipelineActorUnauthorizedError
        ) {
          recoveries.push({ ...candidate, outcome: "superseded" });
          continue;
        }
        throw error;
      }
    }
    return { projectId: input.projectId, trigger: input.trigger, recoveries };
  }
}

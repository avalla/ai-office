import { createHash } from "node:crypto";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { isTaskRunnable } from "@ai-office/domain/agent/run-eligibility.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type {
  AgentExecutor,
  AgentExecutionResult,
  PreparedAgentExecution,
} from "@ai-office/agent-runtime/executor.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { WorkerAuthorityFence } from "../ports/agent-runtime-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type {
  GlobalMemoryRepository,
  MemorySearchResult,
} from "../ports/global-memory-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import {
  taskRunLeaseDurationMs,
  taskRunLeaseRenewalMs,
} from "../runtime/run-policy.ts";
import {
  WorkerRuntimeError,
  workerLimits,
  type WorkerContext,
  type WorkerRuntime,
} from "../ports/worker-runtime.port.ts";

/** Assemble and pin bounded authoritative context before dispatch is persisted. */
export class WorkerAgentExecutor implements AgentExecutor {
  constructor(
    private readonly worker: WorkerRuntime,
    private readonly runtime: AgentRuntimeRepository,
    private readonly tasks: TaskRepository,
    private readonly pipelines: PipelineRunRepository,
    private readonly clock: Clock,
    private readonly memory?: GlobalMemoryRepository,
  ) {}

  private async relevantMemory(input: {
    title: string;
    description: string | null;
    roleKey: string;
    objective: string | null;
  }): Promise<readonly MemorySearchResult[]> {
    if (this.memory === undefined) return [];
    const stopWords = new Set([
      "about",
      "from",
      "into",
      "that",
      "this",
      "with",
      "and",
      "the",
      "for",
      "use",
    ]);
    const terms = [
      input.title,
      input.description ?? "",
      input.roleKey,
      input.objective ?? "",
    ]
      .flatMap(
        (value) =>
          value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ??
          [],
      )
      .filter((term) => !stopWords.has(term));
    const uniqueTerms = [...new Set(terms)].slice(0, 12);
    if (uniqueTerms.length === 0) return [];
    const matches = await Promise.all(
      uniqueTerms.map((term) => this.memory!.search(term, 5)),
    );
    const byKey = new Map<string, MemorySearchResult>();
    for (const result of matches.flat()) {
      const key = `${result.type}:${result.id}:${result.version ?? "latest"}`;
      const current = byKey.get(key);
      if (current === undefined || result.score > current.score)
        byKey.set(key, result);
    }
    return [...byKey.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.type.localeCompare(right.type) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 8)
      .map((result) => ({
        ...result,
        id: result.id.slice(0, 128),
        name: result.name.slice(0, 256),
        summary: result.summary.slice(0, 2_000),
      }));
  }

  async prepare(run: AgentRun): Promise<PreparedAgentExecution> {
    const snapshot = run.snapshot();
    const task = await this.tasks.findById(snapshot.taskId);
    const agent = await this.runtime.findAgent(snapshot.agentId);
    if (
      task === null ||
      task.snapshot().projectId !== snapshot.projectId ||
      !isTaskRunnable(task.snapshot().status) ||
      agent === null ||
      agent.projectId !== snapshot.projectId ||
      !agent.enabled
    )
      throw new WorkerRuntimeError("WORKER_CONTEXT_INVALID");
    const role = await this.runtime.findRole(agent.roleId, snapshot.projectId);
    if (role === null) throw new WorkerRuntimeError("WORKER_CONTEXT_INVALID");
    const roleState = role.snapshot();
    if (roleState.limits.maxCostMicros === 0n)
      throw new WorkerRuntimeError("WORKER_BUDGET_EXHAUSTED");
    const pipeline = await this.pipelines.findActiveByTask(
      snapshot.taskId,
      snapshot.projectId,
    );
    const stage = pipeline?.currentStage();
    if (
      (pipeline?.snapshot().id ?? undefined) !== snapshot.pipelineRunId ||
      (pipeline !== null &&
        (stage?.status !== "active" ||
          stage.assignedAgentId !== agent.id ||
          stage.roleId !== roleState.key))
    )
      throw new WorkerRuntimeError("WORKER_CONTEXT_INVALID");
    const definition =
      stage == null
        ? undefined
        : pipeline?.snapshot().definition.stages[stage.stageIndex];
    const taskState = task.snapshot();
    const memory = await this.relevantMemory({
      title: taskState.title,
      description: taskState.description ?? null,
      roleKey: roleState.key,
      objective: definition?.objective ?? null,
    });
    const context: WorkerContext = {
      schemaVersion: 1,
      runId: snapshot.id,
      projectId: snapshot.projectId,
      task: {
        id: taskState.id,
        title: taskState.title,
        description: taskState.description ?? null,
        updatedAt: taskState.updatedAt.toISOString(),
      },
      agent: {
        id: agent.id,
        name: agent.name,
        roleId: roleState.id,
        roleKey: roleState.key,
        roleVersion: roleState.version,
      },
      stage:
        pipeline === null ||
        stage === null ||
        stage === undefined ||
        definition === undefined
          ? null
          : {
              pipelineRunId: pipeline.snapshot().id,
              manifestRevision: pipeline.snapshot().manifestRevision,
              stageId: stage.stageId,
              objective: definition.objective,
              checks: [...definition.checks],
            },
      memory: { results: memory },
    };
    const serialized = canonicalStringify(context);
    if (
      new TextEncoder().encode(serialized).byteLength >
      workerLimits.contextBytes
    )
      throw new WorkerRuntimeError("WORKER_CONTEXT_INVALID");
    const descriptor = await this.worker.inspect();
    const budget = roleState.limits.maxCostMicros;
    const limits = {
      timeoutMs: roleState.limits.timeoutSeconds * 1000,
      maxTurns: roleState.limits.maxIterations,
      maxEstimatedCostUsd: `${budget / 1000000n}.${String(budget % 1000000n).padStart(6, "0")}`,
    };
    if (
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs > 2147483647
    )
      throw new WorkerRuntimeError("WORKER_CONTEXT_INVALID");
    const fence: Omit<WorkerAuthorityFence, "runId"> = {
      projectId: snapshot.projectId,
      taskId: snapshot.taskId,
      taskStatus: taskState.status,
      taskUpdatedAt: taskState.updatedAt,
      agentId: snapshot.agentId,
      agentRoleId: agent.roleId,
      agentUpdatedAt: agent.updatedAt,
      roleId: roleState.id,
      roleKey: roleState.key,
      roleVersion: roleState.version,
      roleLimits: { ...roleState.limits },
      roleUpdatedAt: roleState.updatedAt,
      pipeline:
        pipeline === null || stage === null || stage === undefined
          ? null
          : {
              id: pipeline.snapshot().id,
              version: pipeline.snapshot().version,
              currentStageIndex: pipeline.snapshot().currentStageIndex,
              stageId: stage.stageId,
              stageRoleId: stage.roleId,
              assignedAgentId: stage.assignedAgentId!,
            },
      execution: {
        kind: "worker",
        adapterId: this.worker.id,
        adapterVersion: descriptor.version,
        inputHash: createHash("sha256").update(serialized).digest("hex"),
      },
    };
    return {
      provenance: {
        ...fence.execution,
      },
      usesWorktree: false,
      execute: async (signal) => {
        const control = new AbortController();
        const abort = () => control.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        let stopped = false;
        let leaseLost = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let renewing: Promise<void> = Promise.resolve();
        const renew = async () => {
          try {
            const currentTask = (
              await this.tasks.findById(snapshot.taskId)
            )?.snapshot();
            const currentAgent = await this.runtime.findAgent(snapshot.agentId);
            const currentRole = await this.runtime.findRole(
              agent.roleId,
              snapshot.projectId,
            );
            const currentPipeline = await this.pipelines.findActiveByTask(
              snapshot.taskId,
              snapshot.projectId,
            );
            if (
              currentTask === undefined ||
              !isTaskRunnable(currentTask.status) ||
              currentTask.updatedAt.getTime() !==
                taskState.updatedAt.getTime() ||
              currentAgent === null ||
              !currentAgent.enabled ||
              currentAgent.roleId !== agent.roleId ||
              currentAgent.updatedAt.getTime() !== agent.updatedAt.getTime() ||
              currentRole === null ||
              currentRole.snapshot().version !== roleState.version ||
              currentRole.snapshot().updatedAt.getTime() !==
                roleState.updatedAt.getTime() ||
              currentRole.snapshot().limits.maxCostMicros !==
                roleState.limits.maxCostMicros ||
              currentRole.snapshot().limits.maxIterations !==
                roleState.limits.maxIterations ||
              currentRole.snapshot().limits.timeoutSeconds !==
                roleState.limits.timeoutSeconds ||
              (currentPipeline?.snapshot().id ?? null) !==
                (pipeline?.snapshot().id ?? null) ||
              currentPipeline?.snapshot().version !==
                pipeline?.snapshot().version
            )
              throw new WorkerRuntimeError("WORKER_LEASE_LOST");
            const now = this.clock.now();
            const renewed = await this.runtime.renewTaskLock(
              snapshot.id,
              now,
              new Date(now.getTime() + taskRunLeaseDurationMs),
            );
            if (!renewed) throw new WorkerRuntimeError("WORKER_LEASE_LOST");
            if (!stopped)
              timer = setTimeout(() => {
                renewing = renew();
              }, taskRunLeaseRenewalMs);
          } catch {
            leaseLost = true;
            control.abort();
          }
        };
        try {
          if (control.signal.aborted)
            throw new DOMException("Execution cancelled", "AbortError");
          await renew();
          if (leaseLost) throw new WorkerRuntimeError("WORKER_LEASE_LOST");
          const output = await this.worker.execute(
            context,
            limits,
            control.signal,
          );
          return {
            summary: output.summary,
            artifacts: [],
            workerOutput: output,
          };
        } catch (error) {
          if (leaseLost) throw new WorkerRuntimeError("WORKER_LEASE_LOST");
          throw error;
        } finally {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          await renewing;
        }
      },
      accept: async (currentRun, result, acceptedAt) => {
        const accepted = await this.runtime.acceptWorkerResult({
          fence: { ...fence, runId: currentRun.snapshot().id },
          run: currentRun,
          result,
          acceptedAt,
        });
        if (!accepted) throw new WorkerRuntimeError("WORKER_LEASE_LOST");
      },
    };
  }

  async execute(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    return (await this.prepare(run)).execute(signal);
  }
}

import type {
  AgentExecutor,
  AgentControlledActionResult,
} from "@ai-office/agent-runtime/executor.ts";
import type { WorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";

export interface AgentRunExecutionError {
  message: string;
  code?: string;
}
export interface AgentRunExecutionResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  error?: AgentRunExecutionError;
  cleanupError?: AgentRunExecutionError;
  actions: AgentControlledActionResult[];
}

function executionError(
  _error: unknown,
  fallbackCode: string,
): AgentRunExecutionError {
  return {
    message:
      fallbackCode === "ABORTED"
        ? "Execution cancelled"
        : fallbackCode === "WORKTREE_RELEASE_FAILED"
          ? "Worktree cleanup failed"
          : fallbackCode === "TASK_LOCK_RELEASE_FAILED"
            ? "Task lock cleanup failed"
            : "Agent execution failed",
    code: fallbackCode,
  };
}
function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export class ExecuteAgentRun {
  constructor(
    private readonly runtime: AgentRuntimeRepository,
    private readonly executor: AgentExecutor,
    private readonly worktrees: WorktreeManager,
    private readonly clock: Clock,
  ) {}

  async execute(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<AgentRunExecutionResult> {
    let worktree: Awaited<ReturnType<WorktreeManager["prepare"]>> | undefined;
    let primaryError: AgentRunExecutionError | undefined;
    const cleanupErrors: AgentRunExecutionError[] = [];
    let actions: AgentControlledActionResult[] = [];
    try {
      if (signal?.aborted === true) {
        primaryError = { message: "Execution cancelled", code: "ABORTED" };
        run.transition("cancelled", this.clock.now(), { error: primaryError });
        await this.runtime.saveRun(run);
      } else {
        if (run.snapshot().status === "queued") {
          run.transition("preparing", this.clock.now());
          await this.runtime.saveRun(run);
        }
        worktree = await this.worktrees.prepare(run.snapshot().id);
        run.transition("running", this.clock.now(), {
          worktreePath: worktree.path,
        });
        await this.runtime.saveRun(run);
        const result = await this.executor.execute(run, signal);
        actions = result.actions ?? [];
        run.transition("reviewing", this.clock.now(), { result });
        await this.runtime.saveRun(run);
        run.transition("completed", this.clock.now(), { result });
        await this.runtime.saveRun(run);
      }
    } catch (error) {
      if (
        !["completed", "failed", "cancelled"].includes(run.snapshot().status)
      ) {
        const cancelled = isCancelled(error, signal);
        primaryError = executionError(
          error,
          cancelled ? "ABORTED" : "EXECUTION_FAILED",
        );
        run.transition(cancelled ? "cancelled" : "failed", this.clock.now(), {
          error: primaryError,
        });
        await this.runtime.saveRun(run);
      }
    } finally {
      if (worktree !== undefined) {
        try {
          await this.worktrees.release(worktree);
        } catch (error) {
          cleanupErrors.push(executionError(error, "WORKTREE_RELEASE_FAILED"));
        }
      }
      try {
        const released = await this.runtime.releaseTaskLock(run.snapshot().id);
        if (!released)
          cleanupErrors.push({
            message: "Task lock was not released by its owning run",
            code: "TASK_LOCK_RELEASE_FAILED",
          });
      } catch (error) {
        cleanupErrors.push(executionError(error, "TASK_LOCK_RELEASE_FAILED"));
      }
    }
    const snapshot = run.snapshot();
    const status = snapshot.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled")
      throw new Error(`Run ${snapshot.id} did not reach a terminal state`);
    const cleanupError =
      cleanupErrors.length === 0
        ? undefined
        : {
            message: cleanupErrors.map((value) => value.message).join("; "),
            code: "CLEANUP_FAILED",
          };
    return {
      runId: snapshot.id,
      status,
      actions,
      ...(primaryError === undefined ? {} : { error: primaryError }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    };
  }
}

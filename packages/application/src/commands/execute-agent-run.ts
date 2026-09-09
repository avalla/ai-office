import type {
  AgentExecutor,
  AgentControlledActionResult,
} from "@ai-office/agent-runtime/executor.ts";
import type { WorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import { AgentExecutorNotConfiguredError } from "@ai-office/agent-runtime/executor.ts";
import { WorkerRuntimeError } from "../ports/worker-runtime.port.ts";

export interface AgentRunExecutionError {
  message: string;
  code?: string;
}
export interface AgentRunExecutionResult {
  runId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  error?: AgentRunExecutionError;
  cleanupError?: AgentRunExecutionError;
  actions: AgentControlledActionResult[];
}

function executionError(
  error: unknown,
  fallbackCode: string,
): AgentRunExecutionError {
  if (error instanceof AgentExecutorNotConfiguredError)
    return { code: "WORKER_NOT_CONFIGURED", message: error.message };
  if (error instanceof WorkerRuntimeError)
    return { code: error.code, message: error.message };
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
    private readonly onRunChanged?: () => void,
  ) {}

  private async persist(run: AgentRun): Promise<void> {
    await this.runtime.saveRun(run);
    this.onRunChanged?.();
  }

  async execute(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<AgentRunExecutionResult> {
    let worktree: Awaited<ReturnType<WorktreeManager["prepare"]>> | undefined;
    let primaryError: AgentRunExecutionError | undefined;
    const cleanupErrors: AgentRunExecutionError[] = [];
    let actions: AgentControlledActionResult[] = [];
    let terminalPersisted = false;
    let persistenceInterrupted = false;
    try {
      if (signal?.aborted === true) {
        primaryError = { message: "Execution cancelled", code: "ABORTED" };
        run.transition("cancelled", this.clock.now(), { error: primaryError });
        await this.persist(run);
        terminalPersisted = true;
      } else {
        if (run.snapshot().status === "queued") {
          run.transition("preparing", this.clock.now());
          await this.persist(run);
        }
        const prepared = await this.executor.prepare?.(run);
        if (prepared?.usesWorktree !== false)
          worktree = await this.worktrees.prepare(run.snapshot().id);
        run.transition("running", this.clock.now(), {
          ...(worktree === undefined ? {} : { worktreePath: worktree.path }),
          ...(prepared === undefined ? {} : { execution: prepared.provenance }),
        });
        await this.persist(run);
        const result =
          prepared === undefined
            ? await this.executor.execute(run, signal)
            : await prepared.execute(signal);
        actions = result.actions ?? [];
        if (isCancelled(undefined, signal))
          throw new DOMException("Execution cancelled", "AbortError");
        const reviewingAt = this.clock.now();
        if (prepared?.accept !== undefined) {
          await prepared.accept(run, result, reviewingAt);
          // The acceptance fence persisted this exact transition atomically.
          run.transition("reviewing", reviewingAt, { result });
        } else {
          run.transition("reviewing", reviewingAt, { result });
          await this.persist(run);
        }
        run.transition("completed", this.clock.now(), { result });
        await this.persist(run);
        terminalPersisted = true;
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
        try {
          await this.persist(run);
          terminalPersisted = true;
        } catch {
          persistenceInterrupted = true;
        }
      } else if (!terminalPersisted) {
        persistenceInterrupted = true;
      }
    } finally {
      if (worktree !== undefined) {
        try {
          await this.worktrees.release(worktree);
        } catch (error) {
          cleanupErrors.push(executionError(error, "WORKTREE_RELEASE_FAILED"));
        }
      }
      if (terminalPersisted)
        try {
          const released = await this.runtime.releaseTaskLock(
            run.snapshot().id,
          );
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
    const cleanupError =
      cleanupErrors.length === 0
        ? undefined
        : {
            message: cleanupErrors.map((value) => value.message).join("; "),
            code: "CLEANUP_FAILED",
          };
    if (persistenceInterrupted)
      return {
        runId: snapshot.id,
        status: "interrupted",
        actions,
        error: {
          code: "RUN_STATE_PERSISTENCE_FAILED",
          message: "Run state could not be persisted; inspect run:reconcile",
        },
        ...(cleanupError === undefined ? {} : { cleanupError }),
      };
    const status = snapshot.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled")
      throw new Error(`Run ${snapshot.id} did not reach a terminal state`);
    return {
      runId: snapshot.id,
      status,
      actions,
      ...(primaryError === undefined ? {} : { error: primaryError }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    };
  }
}

import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import type { WorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";

export class ExecuteAgentRun {
  constructor(
    private readonly runtime: AgentRuntimeRepository,
    private readonly executor: AgentExecutor,
    private readonly worktrees: WorktreeManager,
    private readonly clock: Clock,
  ) {}

  async execute(run: AgentRun, signal?: AbortSignal): Promise<void> {
    let worktree: Awaited<ReturnType<WorktreeManager["prepare"]>> | undefined;
    try {
      run.transition("preparing", this.clock.now());
      await this.runtime.saveRun(run);
      worktree = await this.worktrees.prepare(run.snapshot().id);
      run.transition("running", this.clock.now(), {
        worktreePath: worktree.path,
      });
      await this.runtime.saveRun(run);
      const result = await this.executor.execute(run, signal);
      run.transition("reviewing", this.clock.now(), { result });
      await this.runtime.saveRun(run);
      run.transition("completed", this.clock.now(), { result });
      await this.runtime.saveRun(run);
    } catch (error) {
      if (
        !["completed", "failed", "cancelled"].includes(run.snapshot().status)
      ) {
        run.transition(
          signal?.aborted === true ? "cancelled" : "failed",
          this.clock.now(),
          {
            error: {
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown execution failure",
            },
          },
        );
        await this.runtime.saveRun(run);
      }
    } finally {
      if (worktree !== undefined) await this.worktrees.release(worktree);
      await this.runtime.releaseTaskLock(run.snapshot().id);
    }
  }
}

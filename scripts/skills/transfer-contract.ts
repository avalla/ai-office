/**
 * Executor-neutral continuity transfer contract (M19-T4): the facts every
 * task-delivery transfer carries, independent of the executor that moves it.
 * The per-executor adapters render these facts with only their own
 * question-mechanism phrasing differing; tests assert the core facts are
 * byte-identical across renderers.
 */

export interface TransferCoreFacts {
  /** Where a task's checkpoints live, relative to the task worktree. */
  readonly checkpointsLocation: string;
  /** Where the handoff packet lives, relative to the task worktree. */
  readonly handoffLocation: string;
  /** How a packet moves from the agent to a person, one sentence. */
  readonly agentToPerson: string;
}

export const transferCoreFacts: TransferCoreFacts = Object.freeze({
  checkpointsLocation: "`.task-delivery/<task>/checkpoints/`",
  handoffLocation: "`.task-delivery/<task>/handoff.md`",
  agentToPerson:
    "the agent writes both; a person moves the task directory or points the next session at it, and the resuming context re-validates head and tree before continuing",
});

/** The executors with a continuity transfer adapter. */
export const transferExecutors = ["Claude Code", "Codex"] as const;
export type TransferExecutor = (typeof transferExecutors)[number];

export interface Worktree {
  path: string;
  branch: string;
}
export interface WorktreeManager {
  prepare(runId: string): Promise<Worktree>;
  release(worktree: Worktree): Promise<void>;
}

export class InMemoryWorktreeManager implements WorktreeManager {
  private readonly active = new Map<string, Worktree>();
  async prepare(runId: string): Promise<Worktree> {
    const worktree = {
      path: `.ai-office/worktrees/${runId}`,
      branch: `ai-office/run-${runId}`,
    };
    this.active.set(runId, worktree);
    return worktree;
  }
  async release(worktree: Worktree): Promise<void> {
    this.active.delete(worktree.branch.replace("ai-office/run-", ""));
  }
}

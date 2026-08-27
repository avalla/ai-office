import type {
  ProjectBinding,
  ProjectBindingInspection,
  ProjectBindingRemovePlan,
  ProjectBindingWritePlan,
} from "../project-lifecycle/project-binding.ts";

export interface ProjectBindingAdapter {
  /** Resolve the managed ancestor, Git worktree root, or standalone directory. */
  resolveProjectRoot(inputPath: string): Promise<string>;
  inspect(
    inputPath: string,
    options?: { ancestors?: boolean; stopAt?: string },
  ): Promise<ProjectBindingInspection>;
  planWrite(
    rootPath: string,
    binding: ProjectBinding,
  ): Promise<ProjectBindingWritePlan>;
  applyWrite(plan: ProjectBindingWritePlan): Promise<void>;
  planRemove(rootPath: string): Promise<ProjectBindingRemovePlan>;
  applyRemove(plan: ProjectBindingRemovePlan): Promise<void>;
}

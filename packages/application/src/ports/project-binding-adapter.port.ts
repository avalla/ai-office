import type {
  ProjectBinding,
  ProjectBindingInspection,
  ProjectBindingRemovePlan,
  ProjectBindingWritePlan,
} from "../project-lifecycle/project-binding.ts";

export interface ProjectBindingAdapter {
  inspect(
    inputPath: string,
    options?: { ancestors?: boolean },
  ): Promise<ProjectBindingInspection>;
  planWrite(
    rootPath: string,
    binding: ProjectBinding,
  ): Promise<ProjectBindingWritePlan>;
  applyWrite(plan: ProjectBindingWritePlan): Promise<void>;
  planRemove(rootPath: string): Promise<ProjectBindingRemovePlan>;
  applyRemove(plan: ProjectBindingRemovePlan): Promise<void>;
}

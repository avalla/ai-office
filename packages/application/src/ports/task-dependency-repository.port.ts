/** Authoritative, project-scoped hard prerequisites for task scheduling. */
export interface TaskDependency {
  projectId: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: Date;
}

export interface TaskDependencyRepository {
  listByProject(projectId: string): Promise<TaskDependency[]>;
  /** True once any task start, pipeline run, or AgentRun has established execution authority. */
  hasExecutionHistory(projectId: string, taskId: string): Promise<boolean>;
  link(dependency: TaskDependency): Promise<boolean>;
  unlink(
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<boolean>;
}

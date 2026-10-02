/** Authoritative, project-scoped hard prerequisites for task scheduling. */
export interface TaskDependency {
  projectId: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: Date;
}

export interface TaskDependencyRepository {
  listByProject(projectId: string): Promise<TaskDependency[]>;
  /** True for executed or unknown lifetime history; only known pristine is editable. */
  hasExecutionHistory(projectId: string, taskId: string): Promise<boolean>;
  link(dependency: TaskDependency): Promise<boolean>;
  unlink(
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<boolean>;
}

import type { ProjectId } from "@ai-office/domain/project/project.ts";
import type { Task, TaskId } from "@ai-office/domain/task/task.ts";

export interface TaskRepository {
  findById(id: TaskId): Promise<Task | null>;
  listByProject(projectId: ProjectId): Promise<Task[]>;
  save(task: Task): Promise<void>;
}

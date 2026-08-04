import type { TaskProps } from "@ai-office/domain/task/task.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";

export class ListTasks {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(projectId: string): Promise<TaskProps[]> {
    const tasks = await this.tasks.listByProject(projectId);
    return tasks.map((task) => task.snapshot());
  }
}

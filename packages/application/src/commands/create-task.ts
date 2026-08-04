import { Task } from "@ai-office/domain/task/task.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";

export class CreateTask {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock
  ) {}

  async execute(input: {
    projectId: string;
    title: string;
    description?: string;
    priority?: number;
  }): Promise<string> {
    const project = await this.projects.findById(input.projectId);

    if (project === null) {
      throw new Error(`Project ${input.projectId} not found`);
    }

    const task = Task.create({
      id: this.ids.generate(),
      projectId: input.projectId,
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      now: this.clock.now()
    });

    await this.tasks.save(task);
    return task.snapshot().id;
  }
}

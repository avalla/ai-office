import { Project } from "@ai-office/domain/project/project.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";

export class CreateProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock
  ) {}

  async execute(input: { name: string; description?: string }): Promise<string> {
    const project = Project.create({
      id: this.ids.generate(),
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      now: this.clock.now()
    });

    await this.projects.save(project);
    return project.snapshot().id;
  }
}

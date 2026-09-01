import { Project } from "@ai-office/domain/project/project.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export class CreateProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly identities: RepositoryIdentityRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    name: string;
    description?: string;
  }): Promise<string> {
    const project = Project.create({
      id: this.ids.generate(),
      name: input.name,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      now: this.clock.now(),
    });

    const projectId = project.snapshot().id;
    await this.transactions.run(async () => {
      await this.projects.save(project);
      const association = await this.identities.associate({
        repositoryId: `repo_${projectId}`,
        projectId,
        createdAt: project.snapshot().createdAt,
      });
      if (association !== "created")
        throw new Error(`Portable identity for project ${projectId} conflicts`);
    });
    return projectId;
  }
}

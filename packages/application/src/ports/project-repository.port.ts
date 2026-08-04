import type { Project, ProjectId } from "@ai-office/domain/project/project.ts";

export interface ProjectRepository {
  findById(id: ProjectId): Promise<Project | null>;
  save(project: Project): Promise<void>;
}

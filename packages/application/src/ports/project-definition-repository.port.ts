import type { ProjectDefinitionState } from "../domain-pack/project-definition.ts";

export interface ProjectDefinitionRepository {
  get(projectId: string): Promise<ProjectDefinitionState>;
  /** Replace the authoritative entries under the caller's audit transaction. */
  replace(
    state: ProjectDefinitionState,
    expectedRevision: number,
    changedAt: Date,
  ): Promise<ProjectDefinitionState>;
}

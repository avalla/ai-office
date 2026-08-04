export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found`);
    this.name = "ProjectNotFoundError";
  }
}

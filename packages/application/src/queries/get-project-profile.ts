import type {
  ProjectProfileEntry,
  ProjectProfileSnapshot
} from "@ai-office/domain/project/project-profile.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";

function userEntries(entries: ProjectProfileEntry[], category: string): ProjectProfileEntry[] {
  return entries.filter((entry) => entry.origin === "user" && entry.category === category);
}

export class GetProjectProfile {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository
  ) {}

  async execute(projectId: string): Promise<ProjectProfileSnapshot> {
    const project = await this.projects.findById(projectId);
    if (project === null) throw new ProjectNotFoundError(projectId);

    const [entries, openQuestions] = await Promise.all([
      this.profiles.listActiveProfileEntries(projectId),
      this.profiles.listOpenQuestions(projectId)
    ]);
    const snapshot = project.snapshot();

    return {
      project: { id: snapshot.id, name: snapshot.name },
      detectedFacts: entries.filter((entry) => entry.origin === "detected"),
      inferences: entries.filter((entry) => entry.origin === "inferred"),
      confirmedPreferences: userEntries(entries, "preference"),
      constraints: userEntries(entries, "constraint"),
      goals: userEntries(entries, "goal"),
      permissions: userEntries(entries, "permission"),
      openQuestions
    };
  }
}

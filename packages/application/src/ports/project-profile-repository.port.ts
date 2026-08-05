import type { ProjectProfileEntry } from "@ai-office/domain/project/project-profile.ts";

export interface ProjectProfileRepository {
  saveMany(entries: ProjectProfileEntry[]): Promise<void>;
}

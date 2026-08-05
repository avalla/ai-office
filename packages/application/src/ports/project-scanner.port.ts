import type { ProjectScanSummary } from "@ai-office/domain/project/project-profile.ts";

export interface ProjectScanner {
  scan(rootPath: string): Promise<ProjectScanSummary>;
}

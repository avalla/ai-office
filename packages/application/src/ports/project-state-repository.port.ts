import type { PortableProjectState } from "../project-portability/project-snapshot.ts";

export interface ProjectStateRevision {
  id: string;
  projectId: string;
  parentRevisionId?: string;
  stateChecksum: string;
  origin: "local_export" | "portable_import";
  createdAt: Date;
}

export interface ProjectStateHead {
  revision: ProjectStateRevision;
  baseRevisionId?: string;
}

export interface ProjectStateRepository {
  loadPortableState(projectId: string): Promise<PortableProjectState>;
  restorePortableState(
    projectId: string,
    state: PortableProjectState,
  ): Promise<void>;
  findHead(projectId: string): Promise<ProjectStateHead | null>;
  saveRevision(
    revision: ProjectStateRevision,
    baseRevisionId?: string,
  ): Promise<void>;
}

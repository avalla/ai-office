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

export type ProjectPortabilityBlocker =
  | {
      kind: "task";
      taskId: string;
      status: "assigned" | "running" | "blocked" | "waiting_review";
    }
  | {
      kind: "agent_run";
      runId: string;
      taskId: string;
      status: "queued" | "preparing" | "running" | "reviewing";
    }
  | {
      kind: "pipeline_run";
      pipelineRunId: string;
      taskId: string;
      status: "active";
    }
  | {
      kind: "task_lock";
      runId: string;
      taskId: string;
      expiresAt: Date;
    };

export interface ProjectStateRepository {
  findPortabilityBlockers(
    projectId: string,
    at: Date,
  ): Promise<ProjectPortabilityBlocker[]>;
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

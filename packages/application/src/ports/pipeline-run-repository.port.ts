import type {
  PipelineOverrideRecord,
  PipelineRun,
} from "@ai-office/domain/pipeline/pipeline-run.ts";

export interface PipelineRunRepository {
  insert(run: PipelineRun): Promise<void>;
  findById(id: string, projectId: string): Promise<PipelineRun | null>;
  findActiveByTask(
    taskId: string,
    projectId: string,
  ): Promise<PipelineRun | null>;
  listByProject(projectId: string): Promise<PipelineRun[]>;
  listActiveByProject(projectId: string): Promise<PipelineRun[]>;
  save(run: PipelineRun, expectedVersion: number): Promise<boolean>;
  appendOverride(record: PipelineOverrideRecord): Promise<void>;
  listOverrides(
    pipelineRunId: string,
    projectId: string,
  ): Promise<PipelineOverrideRecord[]>;
}

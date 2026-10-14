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

/**
 * M16.5 Runtime activation, first slice: raised by a repository that cannot
 * persist a run's pack-configuration pin (PostgreSQL today), instead of
 * silently dropping it -- both for a run that carries a pin and for a run
 * whose project has a nonempty pack binding when the insert commits.
 */
export class PipelineRunConfigurationPinUnsupportedError extends Error {
  constructor(
    readonly pipelineRunId: string,
    readonly reason: "pin" | "bound_packs" = "pin",
  ) {
    super(
      reason === "pin"
        ? `PipelineRun ${pipelineRunId} has a configuration pin, which this ` +
            "project storage does not yet support persisting"
        : `PipelineRun ${pipelineRunId} belongs to a project with a pack ` +
            "binding, whose configuration pin this project storage does not " +
            "yet support persisting",
    );
    this.name = "PipelineRunConfigurationPinUnsupportedError";
  }
}

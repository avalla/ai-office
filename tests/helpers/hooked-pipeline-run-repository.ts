import type { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { PipelineRunRepository } from "@ai-office/application/ports/pipeline-run-repository.port.ts";

/**
 * Runs `beforeInsert` after the run-start transaction has resolved the
 * configuration pin and immediately before the run row is written, and
 * `afterInsert` once it is written but before that transaction commits --
 * deterministic interleaving points with no sleep or wall-clock timing.
 */
export class HookedPipelineRunRepository implements PipelineRunRepository {
  constructor(
    private readonly inner: PipelineRunRepository,
    private readonly hooks: {
      beforeInsert?: () => Promise<void>;
      afterInsert?: () => Promise<void>;
    },
  ) {}

  async insert(run: PipelineRun): Promise<void> {
    await this.hooks.beforeInsert?.();
    await this.inner.insert(run);
    await this.hooks.afterInsert?.();
  }

  findById: PipelineRunRepository["findById"] = (...args) =>
    this.inner.findById(...args);
  findActiveByTask: PipelineRunRepository["findActiveByTask"] = (...args) =>
    this.inner.findActiveByTask(...args);
  listByProject: PipelineRunRepository["listByProject"] = (...args) =>
    this.inner.listByProject(...args);
  listActiveByProject: PipelineRunRepository["listActiveByProject"] = (
    ...args
  ) => this.inner.listActiveByProject(...args);
  save: PipelineRunRepository["save"] = (...args) => this.inner.save(...args);
  appendOverride: PipelineRunRepository["appendOverride"] = (...args) =>
    this.inner.appendOverride(...args);
  listOverrides: PipelineRunRepository["listOverrides"] = (...args) =>
    this.inner.listOverrides(...args);
}

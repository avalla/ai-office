export class PipelineRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Pipeline run ${id} not found`);
    this.name = "PipelineRunNotFoundError";
  }
}

export class ActivePipelineRunExistsError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} already has an active pipeline run`);
    this.name = "ActivePipelineRunExistsError";
  }
}

export class PipelineDefinitionNotEnforcedError extends Error {
  constructor(id: string) {
    super(`Pipeline ${id} is guidance-only and cannot create an enforced run`);
    this.name = "PipelineDefinitionNotEnforcedError";
  }
}

/**
 * A pipeline ID names both a manifest pipeline and a pack workflow of a project
 * that selected packs (M16.5). The operator picks the source explicitly.
 */
export class PipelineDefinitionAmbiguousError extends Error {
  constructor(id: string) {
    super(
      `Pipeline ${id} is both a manifest pipeline and a pack workflow; pass --source manifest or --source pack`,
    );
    this.name = "PipelineDefinitionAmbiguousError";
  }
}

/** A pack workflow cannot start a run because the Runtime lacks a stage role. */
export class PipelineRoleUnavailableError extends Error {
  constructor(id: string, roles: readonly string[]) {
    super(
      `Pack workflow ${id} needs Runtime roles that do not exist: ${roles.join(", ")}`,
    );
    this.name = "PipelineRoleUnavailableError";
  }
}

/** A pack workflow cannot be expressed as an enforced pipeline unambiguously. */
export class PackPipelineUnsupportedError extends Error {
  constructor(id: string, reason: string) {
    super(`Pack workflow ${id} cannot start a run: ${reason}`);
    this.name = "PackPipelineUnsupportedError";
  }
}

export class ConcurrentPipelineTransitionError extends Error {
  constructor(id: string) {
    super(`Pipeline run ${id} changed concurrently`);
    this.name = "ConcurrentPipelineTransitionError";
  }
}

export class PipelineActorUnauthorizedError extends Error {
  constructor(operation: string) {
    super(`Pipeline ${operation} is not authorized for this actor type`);
    this.name = "PipelineActorUnauthorizedError";
  }
}

export class AgentRunProvenanceError extends Error {
  constructor(message = "Agent-run provenance is invalid") {
    super(message);
    this.name = "AgentRunProvenanceError";
  }
}

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

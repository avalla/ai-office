export class GlobalMemoryNotFoundError extends Error {
  constructor(type: string, id: string) {
    super(`Global memory ${type} not found: ${id}`);
    this.name = "GlobalMemoryNotFoundError";
  }
}

export class GlobalMemoryDeprecatedError extends Error {
  constructor(type: string, id: string) {
    super(`Global memory ${type} is deprecated: ${id}`);
    this.name = "GlobalMemoryDeprecatedError";
  }
}

export class GlobalMemoryVersionConflictError extends Error {
  constructor(
    type: string,
    id: string,
    version: number,
    latestVersion?: number,
  ) {
    super(
      latestVersion === undefined
        ? `Global memory ${type} ${id} version ${version} already exists`
        : `Global memory ${type} ${id} version ${version} conflicts with latest version ${latestVersion}`,
    );
    this.name = "GlobalMemoryVersionConflictError";
  }
}

export class GlobalMemorySourceMismatchError extends Error {
  constructor(taskId: string, projectId: string) {
    super(`Task ${taskId} does not belong to project ${projectId}`);
    this.name = "GlobalMemorySourceMismatchError";
  }
}

export class PostgresTenantScopeError extends Error {
  constructor(record: string, id: string) {
    super(`${record} ${id} is outside the PostgreSQL tenant context`);
    this.name = "PostgresTenantScopeError";
  }
}

export class PostgresTenantContextError extends Error {
  constructor() {
    super("PostgreSQL tenant context must be a non-empty, trimmed tenant ID");
    this.name = "PostgresTenantContextError";
  }
}

export class PostgresProjectTenantConflictError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} belongs to another PostgreSQL tenant`);
    this.name = "PostgresProjectTenantConflictError";
  }
}

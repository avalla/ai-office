export interface AgentDefinition {
  id: string;
  roleKey: string;
  role: string;
  version: number;
  capabilities: string[];
  tools: string[];
  modelPolicy: string;
  limits: {
    maxIterations: number;
    maxCostMicros: bigint;
    timeoutSeconds: number;
  };
}

export class InvalidAgentDefinitionError extends Error {
  constructor(path: string, detail: string) {
    super(`Invalid agent definition ${path}: ${detail}`);
    this.name = "InvalidAgentDefinitionError";
  }
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function positiveInteger(value: unknown, path: string, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidAgentDefinitionError(
      path,
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

function nonNegativeBigInt(
  value: unknown,
  path: string,
  field: string,
): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InvalidAgentDefinitionError(
        path,
        `${field} must be a non-negative safe integer or decimal string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
    return BigInt(value);
  throw new InvalidAgentDefinitionError(
    path,
    `${field} must be a non-negative safe integer or decimal string`,
  );
}

export function parseAgentDefinition(
  value: unknown,
  path: string,
): AgentDefinition {
  if (typeof value !== "object" || value === null)
    throw new InvalidAgentDefinitionError(path, "expected an object");
  const row = value as Record<string, unknown>;
  const limits = row.limits;
  if (typeof limits !== "object" || limits === null)
    throw new InvalidAgentDefinitionError(path, "limits are required");
  const limit = limits as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    row.id.trim() === "" ||
    typeof row.role_key !== "string" ||
    row.role_key.trim() === "" ||
    typeof row.role !== "string" ||
    row.role.trim() === "" ||
    !stringArray(row.capabilities) ||
    !stringArray(row.tools) ||
    typeof row.model_policy !== "string" ||
    row.model_policy.trim() === "" ||
    limit.max_iterations === undefined ||
    limit.max_cost_micros === undefined ||
    limit.timeout_seconds === undefined
  ) {
    throw new InvalidAgentDefinitionError(
      path,
      "one or more fields have an invalid type",
    );
  }
  return {
    id: row.id,
    roleKey: row.role_key,
    role: row.role,
    version: positiveInteger(row.version, path, "version"),
    capabilities: row.capabilities,
    tools: row.tools,
    modelPolicy: row.model_policy,
    limits: {
      maxIterations: positiveInteger(
        limit.max_iterations,
        path,
        "limits.max_iterations",
      ),
      maxCostMicros: nonNegativeBigInt(
        limit.max_cost_micros,
        path,
        "limits.max_cost_micros",
      ),
      timeoutSeconds: positiveInteger(
        limit.timeout_seconds,
        path,
        "limits.timeout_seconds",
      ),
    },
  };
}

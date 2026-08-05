export interface AgentDefinition {
  id: string;
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
    typeof row.role !== "string" ||
    typeof row.version !== "number" ||
    !stringArray(row.capabilities) ||
    !stringArray(row.tools) ||
    typeof row.model_policy !== "string" ||
    typeof limit.max_iterations !== "number" ||
    typeof limit.max_cost_micros !== "number" ||
    typeof limit.timeout_seconds !== "number"
  ) {
    throw new InvalidAgentDefinitionError(
      path,
      "one or more fields have an invalid type",
    );
  }
  return {
    id: row.id,
    role: row.role,
    version: row.version,
    capabilities: row.capabilities,
    tools: row.tools,
    modelPolicy: row.model_policy,
    limits: {
      maxIterations: limit.max_iterations,
      maxCostMicros: BigInt(limit.max_cost_micros),
      timeoutSeconds: limit.timeout_seconds,
    },
  };
}

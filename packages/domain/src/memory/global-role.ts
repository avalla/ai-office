import { DomainValidationError } from "../errors.ts";
import {
  memoryStatus,
  nonEmpty,
  positiveSafeInteger,
  stringList,
  validDate,
} from "./memory-validation.ts";

export type MemoryStatus = "active" | "deprecated";

export interface GlobalRoleLimits {
  readonly maxIterations: number;
  readonly maxCostMicros: string;
  readonly timeoutSeconds: number;
}

export interface GlobalRoleDefinition {
  readonly key: string;
  readonly description: string;
  readonly responsibilities: readonly string[];
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly modelPolicy: string;
  readonly limits: GlobalRoleLimits;
}

export interface GlobalRoleProps {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly definition: GlobalRoleDefinition;
  readonly status: MemoryStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function validateLimits(limits: GlobalRoleLimits): GlobalRoleLimits {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits))
    throw new DomainValidationError("Global role limits must be an object");
  if (!Number.isSafeInteger(limits.maxIterations) || limits.maxIterations < 1)
    throw new DomainValidationError(
      "Global role maxIterations must be a positive safe integer",
    );
  if (!/^\d+$/.test(limits.maxCostMicros))
    throw new DomainValidationError(
      "Global role maxCostMicros must be a non-negative integer string",
    );
  if (!Number.isSafeInteger(limits.timeoutSeconds) || limits.timeoutSeconds < 1)
    throw new DomainValidationError(
      "Global role timeoutSeconds must be a positive safe integer",
    );
  return { ...limits };
}

export function normalizeGlobalRoleDefinition(
  definition: GlobalRoleDefinition,
): GlobalRoleDefinition {
  if (
    typeof definition !== "object" ||
    definition === null ||
    Array.isArray(definition)
  )
    throw new DomainValidationError("Global role definition must be an object");
  if (typeof definition.description !== "string")
    throw new DomainValidationError("Global role description must be a string");
  return {
    key: nonEmpty(definition.key, "Global role key"),
    description: definition.description.trim(),
    responsibilities: stringList(
      definition.responsibilities,
      "Global role responsibilities",
    ),
    capabilities: stringList(
      definition.capabilities,
      "Global role capabilities",
    ),
    tools: stringList(definition.tools, "Global role tools"),
    modelPolicy: nonEmpty(definition.modelPolicy, "Global role modelPolicy"),
    limits: validateLimits(definition.limits),
  };
}

function validateProps(props: GlobalRoleProps): GlobalRoleProps {
  return {
    id: nonEmpty(props.id, "Global role id"),
    name: nonEmpty(props.name, "Global role name"),
    version: positiveSafeInteger(props.version, "Global role version"),
    definition: normalizeGlobalRoleDefinition(props.definition),
    status: memoryStatus(props.status, "Global role status"),
    createdAt: validDate(props.createdAt, "Global role createdAt"),
    updatedAt: validDate(props.updatedAt, "Global role updatedAt"),
  };
}

export class GlobalRole {
  private constructor(private props: GlobalRoleProps) {}

  static create(input: {
    id: string;
    name: string;
    version: number;
    definition: GlobalRoleDefinition;
    now: Date;
  }): GlobalRole {
    const now = validDate(input.now, "Global role timestamp");
    return new GlobalRole(
      validateProps({
        id: input.id,
        name: input.name,
        version: input.version,
        definition: input.definition,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  static restore(props: GlobalRoleProps): GlobalRole {
    return new GlobalRole(validateProps(props));
  }

  deprecate(now: Date): void {
    if (this.props.status === "deprecated") return;
    this.props = {
      ...this.props,
      status: "deprecated",
      updatedAt: validDate(now, "Global role deprecation timestamp"),
    };
  }

  snapshot(): GlobalRoleProps {
    return {
      ...this.props,
      definition: {
        ...this.props.definition,
        responsibilities: [...this.props.definition.responsibilities],
        capabilities: [...this.props.definition.capabilities],
        tools: [...this.props.definition.tools],
        limits: { ...this.props.definition.limits },
      },
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}

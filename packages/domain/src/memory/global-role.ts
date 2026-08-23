import { DomainValidationError } from "../errors.ts";
import { nonEmpty, stringList, validDate } from "./memory-validation.ts";

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

function validateDefinition(
  definition: GlobalRoleDefinition,
): GlobalRoleDefinition {
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

export class GlobalRole {
  private constructor(private props: GlobalRoleProps) {}

  static create(input: {
    id: string;
    name: string;
    version: number;
    definition: GlobalRoleDefinition;
    now: Date;
  }): GlobalRole {
    if (!Number.isSafeInteger(input.version) || input.version < 1)
      throw new DomainValidationError(
        "Global role version must be a positive safe integer",
      );
    const now = validDate(input.now, "Global role timestamp");
    return new GlobalRole({
      id: nonEmpty(input.id, "Global role id"),
      name: nonEmpty(input.name, "Global role name"),
      version: input.version,
      definition: validateDefinition(input.definition),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: GlobalRoleProps): GlobalRole {
    return new GlobalRole({
      ...props,
      definition: validateDefinition(props.definition),
      createdAt: validDate(props.createdAt, "Global role createdAt"),
      updatedAt: validDate(props.updatedAt, "Global role updatedAt"),
    });
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

import { DomainValidationError } from "../errors.ts";

export interface RoleLimits {
  maxIterations: number;
  maxCostMicros: bigint;
  timeoutSeconds: number;
}

export interface RoleProps {
  id: string;
  projectId: string;
  key: string;
  name: string;
  version: number;
  capabilities: string[];
  tools: string[];
  modelPolicy: string;
  limits: RoleLimits;
  sourcePath: string;
  createdAt: Date;
  updatedAt: Date;
}

export class Role {
  private constructor(private readonly props: RoleProps) {}

  static create(
    input: Omit<RoleProps, "createdAt" | "updatedAt"> & { now: Date },
  ): Role {
    if (input.key.trim() === "" || input.name.trim() === "") {
      throw new DomainValidationError("Role key and name cannot be empty");
    }
    if (!Number.isSafeInteger(input.version) || input.version < 1) {
      throw new DomainValidationError(
        "Role version must be a positive integer",
      );
    }
    if (
      !Number.isSafeInteger(input.limits.maxIterations) ||
      input.limits.maxIterations < 1
    ) {
      throw new DomainValidationError(
        "Role max iterations must be a positive integer",
      );
    }
    if (input.limits.maxCostMicros < 0n || input.limits.timeoutSeconds < 1) {
      throw new DomainValidationError("Role limits must be non-negative");
    }
    return new Role({
      ...input,
      key: input.key.trim(),
      name: input.name.trim(),
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: RoleProps): Role {
    return new Role(props);
  }

  snapshot(): RoleProps {
    return {
      ...this.props,
      capabilities: [...this.props.capabilities],
      tools: [...this.props.tools],
      limits: { ...this.props.limits },
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}

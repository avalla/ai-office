import { DomainValidationError } from "../errors.ts";
import { nonEmpty, validDate } from "./memory-validation.ts";

export type MemoryTargetType = "role" | "pattern" | "lesson";
export type MemoryReferenceType = "adopted";

export interface MemoryReferenceProps {
  readonly id: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetType: "pattern";
  readonly referenceType: MemoryReferenceType;
  readonly query?: string;
  readonly usageCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class MemoryReference {
  private constructor(private readonly props: MemoryReferenceProps) {}

  static create(input: {
    id: string;
    projectId: string;
    targetId: string;
    targetVersion: number;
    targetType: "pattern";
    referenceType: MemoryReferenceType;
    query?: string;
    now: Date;
  }): MemoryReference {
    if (!Number.isSafeInteger(input.targetVersion) || input.targetVersion < 1)
      throw new DomainValidationError(
        "Memory reference targetVersion must be a positive safe integer",
      );
    const now = validDate(input.now, "Memory reference timestamp");
    return new MemoryReference({
      id: nonEmpty(input.id, "Memory reference id"),
      projectId: nonEmpty(input.projectId, "Memory reference projectId"),
      targetId: nonEmpty(input.targetId, "Memory reference targetId"),
      targetVersion: input.targetVersion,
      targetType: input.targetType,
      referenceType: input.referenceType,
      ...(input.query === undefined ? {} : { query: input.query.trim() }),
      usageCount: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: MemoryReferenceProps): MemoryReference {
    return new MemoryReference({
      ...props,
      createdAt: validDate(props.createdAt, "Memory reference createdAt"),
      updatedAt: validDate(props.updatedAt, "Memory reference updatedAt"),
    });
  }

  snapshot(): MemoryReferenceProps {
    return {
      ...this.props,
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}

import { DomainValidationError } from "../errors.ts";
import {
  nonEmpty,
  positiveSafeInteger,
  validDate,
} from "./memory-validation.ts";

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

function validateProps(props: MemoryReferenceProps): MemoryReferenceProps {
  if (props.targetType !== "pattern")
    throw new DomainValidationError(
      "Memory reference targetType must be pattern",
    );
  if (props.referenceType !== "adopted")
    throw new DomainValidationError(
      "Memory reference referenceType must be adopted",
    );
  return {
    id: nonEmpty(props.id, "Memory reference id"),
    projectId: nonEmpty(props.projectId, "Memory reference projectId"),
    targetId: nonEmpty(props.targetId, "Memory reference targetId"),
    targetVersion: positiveSafeInteger(
      props.targetVersion,
      "Memory reference targetVersion",
    ),
    targetType: props.targetType,
    referenceType: props.referenceType,
    ...(props.query === undefined
      ? {}
      : { query: nonEmpty(props.query, "Memory reference query") }),
    usageCount: positiveSafeInteger(
      props.usageCount,
      "Memory reference usageCount",
    ),
    createdAt: validDate(props.createdAt, "Memory reference createdAt"),
    updatedAt: validDate(props.updatedAt, "Memory reference updatedAt"),
  };
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
    const now = validDate(input.now, "Memory reference timestamp");
    return new MemoryReference(
      validateProps({
        id: input.id,
        projectId: input.projectId,
        targetId: input.targetId,
        targetVersion: input.targetVersion,
        targetType: input.targetType,
        referenceType: input.referenceType,
        ...(input.query === undefined ? {} : { query: input.query }),
        usageCount: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  static restore(props: MemoryReferenceProps): MemoryReference {
    return new MemoryReference(validateProps(props));
  }

  snapshot(): MemoryReferenceProps {
    return {
      ...this.props,
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}

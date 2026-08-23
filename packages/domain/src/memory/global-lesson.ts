import { DomainValidationError } from "../errors.ts";
import type { MemoryStatus } from "./global-role.ts";
import { memoryStatus, nonEmpty, validDate } from "./memory-validation.ts";

export interface GlobalLessonProps {
  readonly id: string;
  readonly sourceProjectId?: string;
  readonly sourceTaskId?: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly status: MemoryStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function validateProps(props: GlobalLessonProps): GlobalLessonProps {
  if (
    !Number.isFinite(props.confidence) ||
    props.confidence < 0 ||
    props.confidence > 1
  )
    throw new DomainValidationError(
      "Global lesson confidence must be between 0 and 1",
    );
  if (props.sourceTaskId !== undefined && props.sourceProjectId === undefined)
    throw new DomainValidationError(
      "Global lesson sourceTaskId requires sourceProjectId",
    );
  return {
    id: nonEmpty(props.id, "Global lesson id"),
    ...(props.sourceProjectId === undefined
      ? {}
      : {
          sourceProjectId: nonEmpty(
            props.sourceProjectId,
            "Global lesson sourceProjectId",
          ),
        }),
    ...(props.sourceTaskId === undefined
      ? {}
      : {
          sourceTaskId: nonEmpty(
            props.sourceTaskId,
            "Global lesson sourceTaskId",
          ),
        }),
    title: nonEmpty(props.title, "Global lesson title"),
    content: nonEmpty(props.content, "Global lesson content"),
    confidence: props.confidence,
    status: memoryStatus(props.status, "Global lesson status"),
    createdAt: validDate(props.createdAt, "Global lesson createdAt"),
    updatedAt: validDate(props.updatedAt, "Global lesson updatedAt"),
  };
}

export class GlobalLesson {
  private constructor(private props: GlobalLessonProps) {}

  static create(input: {
    id: string;
    sourceProjectId?: string;
    sourceTaskId?: string;
    title: string;
    content: string;
    confidence: number;
    now: Date;
  }): GlobalLesson {
    const now = validDate(input.now, "Global lesson timestamp");
    return new GlobalLesson(
      validateProps({
        id: input.id,
        ...(input.sourceProjectId === undefined
          ? {}
          : {
              sourceProjectId: input.sourceProjectId,
            }),
        ...(input.sourceTaskId === undefined
          ? {}
          : {
              sourceTaskId: input.sourceTaskId,
            }),
        title: input.title,
        content: input.content,
        confidence: input.confidence,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  static restore(props: GlobalLessonProps): GlobalLesson {
    return new GlobalLesson(validateProps(props));
  }

  deprecate(now: Date): void {
    if (this.props.status === "deprecated") return;
    this.props = {
      ...this.props,
      status: "deprecated",
      updatedAt: validDate(now, "Global lesson deprecation timestamp"),
    };
  }

  snapshot(): GlobalLessonProps {
    return {
      ...this.props,
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}

import { DomainValidationError } from "../errors.ts";
import type { MemoryStatus } from "./global-role.ts";
import { nonEmpty, validDate } from "./memory-validation.ts";

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
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    )
      throw new DomainValidationError(
        "Global lesson confidence must be between 0 and 1",
      );
    if (input.sourceTaskId !== undefined && input.sourceProjectId === undefined)
      throw new DomainValidationError(
        "Global lesson sourceTaskId requires sourceProjectId",
      );
    const now = validDate(input.now, "Global lesson timestamp");
    return new GlobalLesson({
      id: nonEmpty(input.id, "Global lesson id"),
      ...(input.sourceProjectId === undefined
        ? {}
        : {
            sourceProjectId: nonEmpty(
              input.sourceProjectId,
              "Global lesson sourceProjectId",
            ),
          }),
      ...(input.sourceTaskId === undefined
        ? {}
        : {
            sourceTaskId: nonEmpty(
              input.sourceTaskId,
              "Global lesson sourceTaskId",
            ),
          }),
      title: nonEmpty(input.title, "Global lesson title"),
      content: nonEmpty(input.content, "Global lesson content"),
      confidence: input.confidence,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: GlobalLessonProps): GlobalLesson {
    return new GlobalLesson({
      ...props,
      createdAt: validDate(props.createdAt, "Global lesson createdAt"),
      updatedAt: validDate(props.updatedAt, "Global lesson updatedAt"),
    });
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

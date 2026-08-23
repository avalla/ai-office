import { DomainValidationError } from "../errors.ts";
import type { MemoryStatus } from "./global-role.ts";
import { nonEmpty, stringList, validDate } from "./memory-validation.ts";

export interface GlobalPatternProps {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly problem: string;
  readonly context: string;
  readonly solution: string;
  readonly applicability: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly status: MemoryStatus;
  readonly sourceProjectId?: string;
  readonly successCount: number;
  readonly failureCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class GlobalPattern {
  private constructor(private props: GlobalPatternProps) {}

  static create(input: {
    id: string;
    version: number;
    name: string;
    problem: string;
    context: string;
    solution: string;
    applicability?: readonly string[];
    constraints?: readonly string[];
    risks?: readonly string[];
    sourceProjectId?: string;
    now: Date;
  }): GlobalPattern {
    if (!Number.isSafeInteger(input.version) || input.version < 1)
      throw new DomainValidationError(
        "Global pattern version must be a positive safe integer",
      );
    const now = validDate(input.now, "Global pattern timestamp");
    return new GlobalPattern({
      id: nonEmpty(input.id, "Global pattern id"),
      version: input.version,
      name: nonEmpty(input.name, "Global pattern name"),
      problem: nonEmpty(input.problem, "Global pattern problem"),
      context: nonEmpty(input.context, "Global pattern context"),
      solution: nonEmpty(input.solution, "Global pattern solution"),
      applicability: stringList(
        input.applicability ?? [],
        "Global pattern applicability",
      ),
      constraints: stringList(
        input.constraints ?? [],
        "Global pattern constraints",
      ),
      risks: stringList(input.risks ?? [], "Global pattern risks"),
      status: "active",
      ...(input.sourceProjectId === undefined
        ? {}
        : {
            sourceProjectId: nonEmpty(
              input.sourceProjectId,
              "Global pattern sourceProjectId",
            ),
          }),
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: GlobalPatternProps): GlobalPattern {
    return new GlobalPattern({
      ...props,
      applicability: [...props.applicability],
      constraints: [...props.constraints],
      risks: [...props.risks],
      createdAt: validDate(props.createdAt, "Global pattern createdAt"),
      updatedAt: validDate(props.updatedAt, "Global pattern updatedAt"),
    });
  }

  deprecate(now: Date): void {
    if (this.props.status === "deprecated") return;
    this.props = {
      ...this.props,
      status: "deprecated",
      updatedAt: validDate(now, "Global pattern deprecation timestamp"),
    };
  }

  snapshot(): GlobalPatternProps {
    return {
      ...this.props,
      applicability: [...this.props.applicability],
      constraints: [...this.props.constraints],
      risks: [...this.props.risks],
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}

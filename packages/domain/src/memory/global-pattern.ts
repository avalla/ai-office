import type { MemoryStatus } from "./global-role.ts";
import {
  memoryStatus,
  nonEmpty,
  nonNegativeSafeInteger,
  positiveSafeInteger,
  stringList,
  validDate,
} from "./memory-validation.ts";

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

function validateProps(props: GlobalPatternProps): GlobalPatternProps {
  return {
    id: nonEmpty(props.id, "Global pattern id"),
    version: positiveSafeInteger(props.version, "Global pattern version"),
    name: nonEmpty(props.name, "Global pattern name"),
    problem: nonEmpty(props.problem, "Global pattern problem"),
    context: nonEmpty(props.context, "Global pattern context"),
    solution: nonEmpty(props.solution, "Global pattern solution"),
    applicability: stringList(
      props.applicability,
      "Global pattern applicability",
    ),
    constraints: stringList(props.constraints, "Global pattern constraints"),
    risks: stringList(props.risks, "Global pattern risks"),
    status: memoryStatus(props.status, "Global pattern status"),
    ...(props.sourceProjectId === undefined
      ? {}
      : {
          sourceProjectId: nonEmpty(
            props.sourceProjectId,
            "Global pattern sourceProjectId",
          ),
        }),
    successCount: nonNegativeSafeInteger(
      props.successCount,
      "Global pattern successCount",
    ),
    failureCount: nonNegativeSafeInteger(
      props.failureCount,
      "Global pattern failureCount",
    ),
    createdAt: validDate(props.createdAt, "Global pattern createdAt"),
    updatedAt: validDate(props.updatedAt, "Global pattern updatedAt"),
  };
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
    const now = validDate(input.now, "Global pattern timestamp");
    return new GlobalPattern(
      validateProps({
        id: input.id,
        version: input.version,
        name: input.name,
        problem: input.problem,
        context: input.context,
        solution: input.solution,
        applicability: input.applicability ?? [],
        constraints: input.constraints ?? [],
        risks: input.risks ?? [],
        status: "active",
        ...(input.sourceProjectId === undefined
          ? {}
          : { sourceProjectId: input.sourceProjectId }),
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  static restore(props: GlobalPatternProps): GlobalPattern {
    return new GlobalPattern(validateProps(props));
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

export type AgentReasoningStyle = "architecture_first";
export type AgentAutonomy = "guided" | "high";
export type ChangeAuthority = "autonomous" | "approval_required";
export type AdrAuthority = "allowed" | "approval_required";

export interface AgentOperatingPolicy {
  reasoning: AgentReasoningStyle;
  autonomy: AgentAutonomy;
  codeChanges: ChangeAuthority;
  architectureChanges: "approval_required";
  adrCreation: AdrAuthority;
  inspectBeforeNonTrivialWork: boolean;
  planBeforeNonTrivialWork: boolean;
  implementationReview: boolean;
  preserveInvariants: boolean;
}

export interface ProjectInstructionContract {
  schemaVersion: 1;
  policy: AgentOperatingPolicy;
  project: {
    name: string;
    mission: string;
    repositoryMap: readonly string[];
    invariants: readonly string[];
    workflow: readonly string[];
    testing: readonly string[];
    documentation: readonly string[];
    definitionOfDone: readonly string[];
    /** Task kinds this project's own office manifest declares a default pipeline for. */
    taskKinds: readonly string[];
  };
}

export class InvalidProjectInstructionContractError extends Error {
  constructor(path: string, detail: string) {
    super(`Invalid project instruction contract at ${path}: ${detail}`);
    this.name = "InvalidProjectInstructionContractError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidProjectInstructionContractError(
      path,
      "expected an object",
    );
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0"))
    throw new InvalidProjectInstructionContractError(
      path,
      `expected exactly: ${wanted.join(", ")}`,
    );
}

function keysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const actual = new Set(Object.keys(value));
  for (const key of required)
    if (!actual.has(key))
      throw new InvalidProjectInstructionContractError(
        path,
        `missing required field: ${key}`,
      );
  for (const key of actual)
    if (!required.includes(key) && !optional.includes(key))
      throw new InvalidProjectInstructionContractError(
        path,
        `unexpected field: ${key}`,
      );
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new InvalidProjectInstructionContractError(
      path,
      "expected non-empty text",
    );
  return value.trim();
}

function textList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new InvalidProjectInstructionContractError(
      path,
      "expected a non-empty text array",
    );
  return Object.freeze(
    value.map((item, index) => text(item, `${path}[${index}]`)),
  );
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    throw new InvalidProjectInstructionContractError(
      path,
      "expected a boolean",
    );
  return value;
}

function oneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.some((item) => item === value))
    throw new InvalidProjectInstructionContractError(
      path,
      `expected one of: ${allowed.join(", ")}`,
    );
  return value as T;
}

export function parseProjectInstructionContract(
  value: unknown,
): ProjectInstructionContract {
  const root = record(value, "$");
  exactKeys(root, ["schemaVersion", "policy", "project"], "$");
  if (root.schemaVersion !== 1)
    throw new InvalidProjectInstructionContractError(
      "$.schemaVersion",
      "only schema version 1 is supported",
    );

  const policy = record(root.policy, "$.policy");
  exactKeys(
    policy,
    [
      "reasoning",
      "autonomy",
      "codeChanges",
      "architectureChanges",
      "adrCreation",
      "inspectBeforeNonTrivialWork",
      "planBeforeNonTrivialWork",
      "implementationReview",
      "preserveInvariants",
    ],
    "$.policy",
  );
  const project = record(root.project, "$.project");
  keysWithOptional(
    project,
    [
      "name",
      "mission",
      "repositoryMap",
      "invariants",
      "workflow",
      "testing",
      "documentation",
      "definitionOfDone",
    ],
    // M16.5: optional for backward compatibility with contract JSON
    // written before task kinds became project-specific; absent means
    // "use the shipped default kinds" (see project-skill-compiler.ts).
    ["taskKinds"],
    "$.project",
  );

  return Object.freeze({
    schemaVersion: 1,
    policy: Object.freeze({
      reasoning: oneOf(
        policy.reasoning,
        ["architecture_first"],
        "$.policy.reasoning",
      ),
      autonomy: oneOf(policy.autonomy, ["guided", "high"], "$.policy.autonomy"),
      codeChanges: oneOf(
        policy.codeChanges,
        ["autonomous", "approval_required"],
        "$.policy.codeChanges",
      ),
      architectureChanges: oneOf(
        policy.architectureChanges,
        ["approval_required"],
        "$.policy.architectureChanges",
      ),
      adrCreation: oneOf(
        policy.adrCreation,
        ["allowed", "approval_required"],
        "$.policy.adrCreation",
      ),
      inspectBeforeNonTrivialWork: boolean(
        policy.inspectBeforeNonTrivialWork,
        "$.policy.inspectBeforeNonTrivialWork",
      ),
      planBeforeNonTrivialWork: boolean(
        policy.planBeforeNonTrivialWork,
        "$.policy.planBeforeNonTrivialWork",
      ),
      implementationReview: boolean(
        policy.implementationReview,
        "$.policy.implementationReview",
      ),
      preserveInvariants: boolean(
        policy.preserveInvariants,
        "$.policy.preserveInvariants",
      ),
    }),
    project: Object.freeze({
      name: text(project.name, "$.project.name"),
      mission: text(project.mission, "$.project.mission"),
      repositoryMap: textList(project.repositoryMap, "$.project.repositoryMap"),
      invariants: textList(project.invariants, "$.project.invariants"),
      workflow: textList(project.workflow, "$.project.workflow"),
      testing: textList(project.testing, "$.project.testing"),
      documentation: textList(project.documentation, "$.project.documentation"),
      definitionOfDone: textList(
        project.definitionOfDone,
        "$.project.definitionOfDone",
      ),
      taskKinds:
        project.taskKinds === undefined
          ? Object.freeze([])
          : textList(project.taskKinds, "$.project.taskKinds"),
    }),
  });
}

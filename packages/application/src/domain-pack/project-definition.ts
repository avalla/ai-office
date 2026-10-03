import {
  contributionKinds,
  parseContributionLocalId,
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
  type ContributionKind,
  type DomainPackDependency,
} from "../../../domain-pack-contracts/src/index.ts";

/** Only project_owned and project_override are mutable project authority. */
export type DefinitionOrigin =
  | "core_owned"
  | "pack_owned"
  | "project_owned"
  | "project_override"
  | "runtime_resolved";
export type AuthoritativeDefinitionOrigin = Exclude<
  DefinitionOrigin,
  "runtime_resolved"
>;

export interface ExactPackDefinitionSource extends DomainPackDependency {
  readonly kind: ContributionKind;
  readonly localId: string;
}

export interface DescriptiveDefinition {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
}

export interface WorkflowDefinition extends DescriptiveDefinition {
  readonly taskType: string;
  readonly stages: readonly { readonly id: string; readonly role: string }[];
}

export type ProjectDefinitionPayload =
  DescriptiveDefinition | WorkflowDefinition;

export interface ProjectOwnedDefinition {
  readonly origin: "project_owned";
  readonly kind: ContributionKind;
  readonly id: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly payload: ProjectDefinitionPayload;
  readonly actorId: string;
  readonly changedAt: string;
}

export type OverrideOperation = "replace" | "extend" | "disable";
export interface ProjectDefinitionOverride {
  readonly origin: "project_override";
  readonly source: ExactPackDefinitionSource;
  readonly operation: OverrideOperation;
  readonly revision: number;
  readonly payload?: DescriptiveDefinition;
  readonly actorId: string;
  readonly changedAt: string;
}

export interface ProjectDefinitionState {
  readonly projectId: string;
  readonly revision: number;
  readonly owned: readonly ProjectOwnedDefinition[];
  readonly overrides: readonly ProjectDefinitionOverride[];
}

export type ProjectDefinitionMutation =
  | {
      readonly action: "put_owned";
      readonly kind: ContributionKind;
      readonly id: string;
      readonly payload: ProjectDefinitionPayload;
      readonly enabled: boolean;
      readonly expectedEntryRevision?: number;
    }
  | {
      readonly action: "remove_owned";
      readonly kind: ContributionKind;
      readonly id: string;
    }
  | {
      readonly action: "put_override";
      readonly source: ExactPackDefinitionSource;
      readonly operation: OverrideOperation;
      readonly payload?: DescriptiveDefinition;
      readonly expectedEntryRevision?: number;
    }
  | {
      readonly action: "remove_override";
      readonly source: ExactPackDefinitionSource;
    };

export type DefinitionIssueCode =
  | "malformed_origin_reference"
  | "conflicting_ownership_metadata"
  | "duplicate_project_definition"
  | "duplicate_override_target"
  | "source_pack_not_selected"
  | "source_definition_missing"
  | "source_digest_mismatch"
  | "source_untrusted"
  | "source_incompatible_core"
  | "source_incompatible_contract"
  | "source_dependency_unavailable"
  | "source_dependency_conflict"
  | "unsupported_override_operation"
  | "protected_security_invariant"
  | "source_unavailable";

export class ProjectDefinitionConflictError extends Error {
  constructor(
    readonly code: DefinitionIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDefinitionConflictError";
  }
}

export class StaleProjectDefinitionError extends Error {
  constructor(
    readonly projectId: string,
    readonly actualRevision: number,
  ) {
    super(`Project definitions revision is stale (current: ${actualRevision})`);
    this.name = "StaleProjectDefinitionError";
  }
}

/** Shared with the portable archive schema so accepted state stays exportable. */
export const maximumWorkflowStages = 1_000;

const descriptiveKinds: readonly ContributionKind[] = [
  "roles",
  "taskTypes",
  "agents",
  "artifactTypes",
  "evidenceTypes",
  "knowledge",
  "prompts",
];
const projectOwnedKinds: readonly ContributionKind[] = [
  ...descriptiveKinds,
  "workflows",
];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      "Expected an object",
    );
  return value as Record<string, unknown>;
}

function localId(value: unknown): string {
  try {
    return parseContributionLocalId(value);
  } catch {
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      "Invalid local definition ID",
    );
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      `Expected only ${keys.join(", ")}`,
    );
}

export function parseDefinitionKind(value: unknown): ContributionKind {
  if (!contributionKinds.some((kind) => kind === value))
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      "Unknown definition kind",
    );
  return value as ContributionKind;
}

export function parseExactSource(value: unknown): ExactPackDefinitionSource {
  try {
    const item = record(value);
    exactKeys(item, ["id", "version", "manifestDigest", "kind", "localId"]);
    return {
      id: parseDomainPackId(item.id),
      version: parseDomainPackVersion(item.version),
      manifestDigest: parseManifestDigest(item.manifestDigest),
      kind: parseDefinitionKind(item.kind),
      localId: localId(item.localId),
    };
  } catch (error) {
    if (error instanceof ProjectDefinitionConflictError) throw error;
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      "Invalid exact pack definition source",
    );
  }
}

export function parseDefinitionPayload(
  value: unknown,
  id: string,
  partial = false,
): DescriptiveDefinition {
  const item = record(value);
  const allowed = partial
    ? ["title", "description"]
    : ["id", "title", "description"];
  if (
    Object.keys(item).some((key) => !allowed.includes(key)) ||
    (!partial && item.id !== id) ||
    (partial && Object.keys(item).length === 0)
  )
    throw new ProjectDefinitionConflictError(
      "protected_security_invariant",
      "Definition payload may contain only its exact ID and descriptive fields",
    );
  if (partial && item.id !== undefined)
    throw new ProjectDefinitionConflictError(
      "protected_security_invariant",
      "Extension cannot change definition identity",
    );
  for (const key of ["title", "description"])
    if (
      item[key] !== undefined &&
      (typeof item[key] !== "string" || item[key].length > 16_000)
    )
      throw new ProjectDefinitionConflictError(
        "malformed_origin_reference",
        `${key} must be bounded text`,
      );
  return item as unknown as DescriptiveDefinition;
}

function parseWorkflowPayload(value: unknown, id: string): WorkflowDefinition {
  const item = record(value);
  if (
    Object.keys(item).some(
      (key) =>
        !["id", "title", "description", "taskType", "stages"].includes(key),
    ) ||
    item.id !== id ||
    !Array.isArray(item.stages)
  )
    throw new ProjectDefinitionConflictError(
      "protected_security_invariant",
      "Workflow payload must use the typed schema-1 fields",
    );
  if (item.stages.length > maximumWorkflowStages)
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      `Workflow may declare at most ${maximumWorkflowStages} stages`,
    );
  const common = parseDefinitionPayload(
    {
      id: item.id,
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.description === undefined
        ? {}
        : { description: item.description }),
    },
    id,
  );
  try {
    const taskType = localId(item.taskType);
    const stageIds = new Set<string>();
    const stages = item.stages.map((stage) => {
      const value = record(stage);
      exactKeys(value, ["id", "role"]);
      const stageId = localId(value.id);
      if (stageIds.has(stageId))
        throw new ProjectDefinitionConflictError(
          "conflicting_ownership_metadata",
          "Duplicate workflow stage ID",
        );
      stageIds.add(stageId);
      return { id: stageId, role: localId(value.role) };
    });
    return { ...common, taskType, stages };
  } catch (error) {
    if (error instanceof ProjectDefinitionConflictError) throw error;
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      "Invalid workflow reference",
    );
  }
}

export function parseDefinitionMutation(
  value: unknown,
): ProjectDefinitionMutation {
  const item = record(value);
  const expectedEntryRevision = item.expectedEntryRevision;
  if (
    expectedEntryRevision !== undefined &&
    (!Number.isSafeInteger(expectedEntryRevision) ||
      (expectedEntryRevision as number) < 1)
  )
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      "expectedEntryRevision must be a positive integer",
    );
  switch (item.action) {
    case "put_owned": {
      exactKeys(item, [
        "action",
        "kind",
        "id",
        "payload",
        "enabled",
        ...(expectedEntryRevision === undefined
          ? []
          : ["expectedEntryRevision"]),
      ]);
      const kind = parseDefinitionKind(item.kind);
      if (!projectOwnedKinds.includes(kind))
        throw new ProjectDefinitionConflictError(
          "protected_security_invariant",
          `Project-owned ${kind} needs a typed security contract`,
        );
      const id = localId(item.id);
      if (typeof item.enabled !== "boolean")
        throw new ProjectDefinitionConflictError(
          "malformed_origin_reference",
          "enabled must be boolean",
        );
      return {
        action: "put_owned",
        kind,
        id,
        enabled: item.enabled,
        payload:
          kind === "workflows"
            ? parseWorkflowPayload(item.payload, id)
            : parseDefinitionPayload(item.payload, id),
        ...(expectedEntryRevision === undefined
          ? {}
          : { expectedEntryRevision: expectedEntryRevision as number }),
      };
    }
    case "remove_owned": {
      exactKeys(item, ["action", "kind", "id"]);
      return {
        action: "remove_owned",
        kind: parseDefinitionKind(item.kind),
        id: localId(item.id),
      };
    }
    case "put_override": {
      const source = parseExactSource(item.source);
      const operation = item.operation;
      if (
        operation !== "replace" &&
        operation !== "extend" &&
        operation !== "disable"
      )
        throw new ProjectDefinitionConflictError(
          "unsupported_override_operation",
          "Unknown override operation",
        );
      exactKeys(item, [
        ...(operation === "disable"
          ? ["action", "source", "operation"]
          : ["action", "source", "operation", "payload"]),
        ...(expectedEntryRevision === undefined
          ? []
          : ["expectedEntryRevision"]),
      ]);
      if (
        !descriptiveKinds.includes(source.kind) ||
        (operation === "disable" && source.kind !== "prompts")
      )
        throw new ProjectDefinitionConflictError(
          "unsupported_override_operation",
          `${operation} is unsupported for ${source.kind}`,
        );
      return {
        action: "put_override",
        source,
        operation,
        ...(operation === "disable"
          ? {}
          : {
              payload: parseDefinitionPayload(
                item.payload,
                source.localId,
                operation === "extend",
              ),
            }),
        ...(expectedEntryRevision === undefined
          ? {}
          : { expectedEntryRevision: expectedEntryRevision as number }),
      };
    }
    case "remove_override":
      exactKeys(item, ["action", "source"]);
      return {
        action: "remove_override",
        source: parseExactSource(item.source),
      };
    default:
      throw new ProjectDefinitionConflictError(
        "malformed_origin_reference",
        "Unknown definition mutation",
      );
  }
}

export function sourceKey(source: ExactPackDefinitionSource): string {
  return [
    source.id,
    source.version,
    source.manifestDigest,
    source.kind,
    source.localId,
  ].join("\u0000");
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Code-unit order, matching the repositories' `ORDER BY kind, local_id`. */
export function compareOwnedDefinitions(
  left: Pick<ProjectOwnedDefinition, "kind" | "id">,
  right: Pick<ProjectOwnedDefinition, "kind" | "id">,
): number {
  return compareText(left.kind, right.kind) || compareText(left.id, right.id);
}

/** Code-unit order over the exact source tuple, matching repository reads. */
export function compareExactSources(
  left: ExactPackDefinitionSource,
  right: ExactPackDefinitionSource,
): number {
  return (
    compareText(left.id, right.id) ||
    compareText(left.version, right.version) ||
    compareText(left.manifestDigest, right.manifestDigest) ||
    compareText(left.kind, right.kind) ||
    compareText(left.localId, right.localId)
  );
}

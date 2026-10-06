import {
  contributionKinds,
  maximumContributionReferences,
  parseContributionLocalId,
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
  type ContributionKind,
  type DomainPackDependency,
} from "../../../domain-pack-contracts/src/index.ts";
import { hasLoneSurrogate } from "../../../domain-pack-contracts/src/jcs.ts";

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

/**
 * The declarative references of an agent (GP-12): bare local IDs that resolve
 * in the agent's own namespace. `capabilities` are requested capabilities,
 * bounded by the role's declared set; only an override on a pack agent can
 * carry them. Each list is a set in ascending code-unit order, absent when
 * empty.
 */
export interface AgentDefinition extends DescriptiveDefinition {
  readonly role?: string;
  readonly prompts?: readonly string[];
  readonly knowledge?: readonly string[];
  readonly capabilities?: readonly string[];
}

export const agentReferenceFields = [
  "role",
  "prompts",
  "knowledge",
  "capabilities",
] as const;

/** Whether a payload carries any agent reference field. */
export function hasAgentReferences(payload: object): boolean {
  return agentReferenceFields.some((field) => Object.hasOwn(payload, field));
}

export type ProjectDefinitionPayload =
  DescriptiveDefinition | WorkflowDefinition | AgentDefinition;

/**
 * A `replace` on an agent carries the agent envelope and a `replace` on a
 * workflow the workflow envelope (GP-13); every other override payload is
 * descriptive.
 */
export type OverridePayload =
  DescriptiveDefinition | AgentDefinition | WorkflowDefinition;

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
  readonly payload?: OverridePayload;
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
      readonly payload?: OverridePayload;
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
  | "pack_definition_collision"
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
  | "agent_capability_exceeds_role"
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

/**
 * Bound of an agent's `prompts`, `knowledge` and `capabilities` lists: the
 * manifest contract's own bound, shared with the portable archive schema.
 */
export const maximumAgentReferences = maximumContributionReferences;

export const maximumDefinitionTextLength = 16_000;

/**
 * The one text rule for definition titles and descriptions, shared with the
 * portable archive schema. Text is bounded in UTF-16 code units and is not
 * normalized. Lone surrogates have no canonical JSON form; U+0000 cannot be
 * stored by every ProjectStorage provider.
 */
export function isDefinitionText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumDefinitionTextLength &&
    !value.includes("\u0000") &&
    !hasLoneSurrogate(value)
  );
}

const descriptiveKinds: readonly ContributionKind[] = [
  "roles",
  "taskTypes",
  "agents",
  "artifactTypes",
  "evidenceTypes",
  "knowledge",
  "prompts",
];
/**
 * Kinds a project may override: the descriptive kinds and, since GP-13,
 * workflows. Policies, capabilities and validators have no override contract.
 */
const overridableKinds: readonly ContributionKind[] = [
  ...descriptiveKinds,
  "workflows",
];
/**
 * Kinds a project may omit with a `disable` override. A role omission (GP-11)
 * removes the role from the resolved configuration; a workflow or an enabled
 * agent that still requires it fails resolution. A disabled agent (GP-12) or
 * workflow (GP-13) leaves the configuration together with its references.
 */
export const disableableKinds: readonly ContributionKind[] = [
  "prompts",
  "roles",
  "agents",
  "workflows",
];
export const projectOwnedKinds: readonly ContributionKind[] = [
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
    if (item[key] !== undefined && !isDefinitionText(item[key]))
      throw new ProjectDefinitionConflictError(
        "malformed_origin_reference",
        `${key} must be bounded text`,
      );
  return item as unknown as DescriptiveDefinition;
}

/** A non-empty set of local IDs, returned in ascending code-unit order. */
function referenceList(value: unknown, field: string): string[] {
  // "None" has one encoding: the absent field.
  if (!Array.isArray(value) || value.length === 0)
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      `${field} must be a non-empty list; omit the field instead`,
    );
  if (value.length > maximumAgentReferences)
    throw new ProjectDefinitionConflictError(
      "malformed_origin_reference",
      `${field} may hold at most ${maximumAgentReferences} references`,
    );
  const parsed = value.map(localId);
  if (new Set(parsed).size !== parsed.length)
    throw new ProjectDefinitionConflictError(
      "conflicting_ownership_metadata",
      `Duplicate ${field} reference`,
    );
  return parsed.sort(compareText);
}

/**
 * The complete agent envelope of a `replace` on a pack agent or of a
 * project-owned agent. Only shape is checked here; whether a reference
 * resolves, and whether a request stays within its role, is decided against
 * the definitions the agent can see.
 */
function parseAgentPayload(
  value: unknown,
  id: string,
  requestsCapabilities: boolean,
): AgentDefinition {
  const item = record(value);
  if (!requestsCapabilities && item.capabilities !== undefined)
    throw new ProjectDefinitionConflictError(
      "protected_security_invariant",
      "A project-owned agent cannot request capabilities",
    );
  if (
    Object.keys(item).some(
      (key) =>
        !["id", "title", "description", ...agentReferenceFields].includes(key),
    )
  )
    throw new ProjectDefinitionConflictError(
      "protected_security_invariant",
      "Agent payload may contain only its exact ID, descriptive fields and agent references",
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
  // With no role there is no declared set a request could stay within.
  if (item.capabilities !== undefined && item.role === undefined)
    throw new ProjectDefinitionConflictError(
      "agent_capability_exceeds_role",
      "Requested capabilities need a role",
    );
  return {
    ...common,
    ...(item.role === undefined ? {} : { role: localId(item.role) }),
    ...(item.prompts === undefined
      ? {}
      : { prompts: referenceList(item.prompts, "prompts") }),
    ...(item.knowledge === undefined
      ? {}
      : { knowledge: referenceList(item.knowledge, "knowledge") }),
    ...(item.capabilities === undefined
      ? {}
      : { capabilities: referenceList(item.capabilities, "capabilities") }),
  };
}

/**
 * The complete workflow envelope of a project-owned workflow or of a
 * `replace` on a pack workflow. Only shape is checked here; whether the task
 * type and the stage roles resolve is decided against the definitions the
 * workflow can see. Stage order is significant and is kept as given.
 */
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
            : kind === "agents"
              ? parseAgentPayload(item.payload, id, false)
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
        !overridableKinds.includes(source.kind) ||
        (operation === "disable" && !disableableKinds.includes(source.kind))
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
              // Only a replacement of an agent or of a workflow carries
              // references; an extension stays descriptive for every kind.
              payload:
                operation === "replace" && source.kind === "agents"
                  ? parseAgentPayload(item.payload, source.localId, true)
                  : operation === "replace" && source.kind === "workflows"
                    ? parseWorkflowPayload(item.payload, source.localId)
                    : parseDefinitionPayload(
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

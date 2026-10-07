import { createHash } from "node:crypto";
import { canonicalizeJcsJson, hasLoneSurrogate } from "./jcs.ts";

declare const domainPackIdBrand: unique symbol;
declare const domainPackVersionBrand: unique symbol;
declare const manifestDigestBrand: unique symbol;
declare const artifactDigestBrand: unique symbol;
declare const localIdBrand: unique symbol;

export type DomainPackId = string & { readonly [domainPackIdBrand]: true };
export type DomainPackVersion = string & {
  readonly [domainPackVersionBrand]: true;
};
export type ManifestDigest = string & { readonly [manifestDigestBrand]: true };
export type ArtifactDigest = string & { readonly [artifactDigestBrand]: true };
export type ContributionLocalId = string & { readonly [localIdBrand]: true };

export const contributionKinds = [
  "roles",
  "taskTypes",
  "workflows",
  "agents",
  "artifactTypes",
  "evidenceTypes",
  "policies",
  "knowledge",
  "capabilities",
  "prompts",
  "validators",
] as const;
export type ContributionKind = (typeof contributionKinds)[number];

export interface QualifiedContributionRef {
  readonly pack: DomainPackId;
  readonly kind: ContributionKind;
  readonly id: ContributionLocalId;
}

export interface CoreContractCompatibility {
  readonly minInclusive: number;
  readonly maxExclusive: number;
}

export interface DomainPackDependency {
  readonly id: DomainPackId;
  readonly version: DomainPackVersion;
  readonly manifestDigest: ManifestDigest;
}

export interface Contribution {
  readonly id: ContributionLocalId;
  readonly title?: string;
  readonly description?: string;
}

/**
 * A role archetype. `capabilities` names capability contributions of the same
 * manifest; it is a declarative association and grants nothing. The validated
 * list is a set in ascending code-unit order, absent when empty.
 */
export interface RoleContribution extends Contribution {
  readonly capabilities?: readonly ContributionLocalId[];
  /** Descriptive, ordered and never sorted (GP-10B-2). Absent when none. */
  readonly responsibilities?: readonly string[];
}

/** A prompt. `text` is its declarative body; nothing sends it anywhere. */
export interface PromptContribution extends Contribution {
  readonly text?: string;
}

/**
 * An agent archetype. `role`, `prompts` and `knowledge` name contributions of
 * the same manifest, and `capabilities` the capabilities the agent requests,
 * which must be among those its role declares. The references are declarative:
 * they create no Runtime agent and grant nothing. Each validated list is a set
 * in ascending code-unit order, absent when empty.
 */
export interface AgentContribution extends Contribution {
  readonly role?: ContributionLocalId;
  readonly prompts?: readonly ContributionLocalId[];
  readonly knowledge?: readonly ContributionLocalId[];
  readonly capabilities?: readonly ContributionLocalId[];
}

/** One operation a capability needs: a connector operation name and mode. */
export interface CapabilityOperation {
  readonly operation: string;
  readonly mode: "read" | "mutation";
}

export type CapabilityRequirement = "required" | "optional";

/**
 * A capability. With only an `id` it is a label. `operations` names the
 * operations it needs (GP-16); the validated list is a set in ascending
 * code-unit order of the operation name, and `requirement` is then always
 * present, `required` unless the manifest says `optional`. The declaration
 * states a need and grants nothing.
 */
export interface CapabilityContribution extends Contribution {
  readonly operations?: readonly CapabilityOperation[];
  readonly requirement?: CapabilityRequirement;
}

/**
 * `title`, `objective` and `checks` are descriptive (GP-10B-2): no approval,
 * guard or check is enforced because of them. `checks` keeps its order.
 */
export interface WorkflowStage {
  readonly id: ContributionLocalId;
  readonly role: ContributionLocalId;
  readonly title?: string;
  readonly objective?: string;
  readonly checks?: readonly string[];
}

/**
 * A workflow's routes are `taskType` and `additionalTaskTypes`, task types of
 * the same manifest. The validated list is a set in ascending code-unit order
 * that never holds `taskType`, absent when empty.
 */
export interface WorkflowContribution extends Contribution {
  readonly taskType: ContributionLocalId;
  readonly additionalTaskTypes?: readonly ContributionLocalId[];
  readonly stages: readonly WorkflowStage[];
}

/**
 * The clauses a policy declares for one stage of its target workflow (GP-25).
 * A flag is present only as `true`. `requiresDifferentAgentFrom` names earlier
 * stages of the workflow and `operations` the operation names admitted on the
 * stage; absent `operations` means that none is admitted. Each validated list
 * is a set in ascending code-unit order, absent when empty.
 */
export interface PolicyStageClause {
  readonly stage: ContributionLocalId;
  readonly requiresApproval?: true;
  readonly requiresIndependentApproval?: true;
  readonly requiresDifferentAgentFrom?: readonly ContributionLocalId[];
  readonly operations?: readonly string[];
}

/**
 * A policy. With `workflow` it is typed: it targets one workflow of the same
 * manifest and declares `enforcement` (absent means guidance), stage clauses,
 * or both. `stages` is a set in ascending code-unit order of `stage`. Without
 * `workflow` it is descriptive only and has no clause. The clauses are
 * declarations: this package enforces nothing and they grant nothing.
 */
export interface PolicyContribution extends Contribution {
  readonly workflow?: ContributionLocalId;
  readonly enforcement?: "enforced";
  readonly stages?: readonly PolicyStageClause[];
}

/**
 * A closed, purpose-built data schema (GP-14A), not JSON Schema. Every object
 * is closed: undeclared members are always rejected, so the form carries no
 * `additionalProperties`. There is no `$ref`, no pattern and nothing remote.
 * `enum` values and `required` are sets in ascending code-unit order, and
 * `properties` holds its names in the same order. The schema is data: nothing
 * in this package or in the Runtime validates a value against it.
 */
export type PackDataSchema =
  | {
      readonly type: "string";
      readonly minLength?: number;
      readonly maxLength?: number;
    }
  | {
      readonly type: "integer" | "number";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: "boolean" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | {
      readonly type: "array";
      readonly items: PackDataSchema;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly type: "object";
      readonly properties: { readonly [name: string]: PackDataSchema };
      readonly required?: readonly string[];
    };

/**
 * A domain artifact type (GP-14A). `mediaTypes` is a set in ascending
 * code-unit order. The fields are declarations: no artifact is stored,
 * validated or reviewed because of them, and a project cannot change them.
 */
export interface ArtifactTypeContribution extends Contribution {
  readonly mediaTypes?: readonly string[];
  readonly maximumBytes?: number;
  readonly contentSchema?: PackDataSchema;
}

/**
 * A domain evidence type (GP-14A). `subject` names an artifact type of the
 * same manifest. Declarative only: no evidence record exists.
 */
export interface EvidenceTypeContribution extends Contribution {
  readonly subject?: ContributionLocalId;
  readonly payloadSchema?: PackDataSchema;
}

/**
 * The trusted adapter a validator reference names. `id` is a name in a
 * grammar of its own and is never looked up: the reference is unchecked data
 * (GP-14A), and the exact `version` is `MAJOR.MINOR.PATCH`.
 */
export interface ValidatorAdapterReference {
  readonly id: string;
  readonly version: string;
}

/** An artifact or evidence type of the same manifest a validator accepts. */
export interface ValidatorInputReference {
  readonly kind: "artifactTypes" | "evidenceTypes";
  readonly id: ContributionLocalId;
}

/**
 * A validator reference (GP-14A). With only an `id` it is a label. With
 * `adapter` it is typed and every other member below is required. Nothing
 * runs: the adapter is not resolved, registered or executed, and
 * `failurePolicy` is only `fail_closed` until a later task enforces it.
 * `accepts` is a set in ascending order of `kind` then `id`.
 */
export interface ValidatorContribution extends Contribution {
  readonly adapter?: ValidatorAdapterReference;
  readonly accepts?: readonly ValidatorInputReference[];
  readonly inputSchema?: PackDataSchema;
  readonly produces?: ContributionLocalId;
  readonly outputSchema?: PackDataSchema;
  readonly failurePolicy?: "fail_closed";
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
}

export type DomainPackContributions = {
  readonly [K in ContributionKind]: readonly (K extends "workflows"
    ? WorkflowContribution
    : K extends "roles"
      ? RoleContribution
      : K extends "agents"
        ? AgentContribution
        : K extends "prompts"
          ? PromptContribution
          : K extends "policies"
            ? PolicyContribution
            : K extends "capabilities"
              ? CapabilityContribution
              : K extends "artifactTypes"
                ? ArtifactTypeContribution
                : K extends "evidenceTypes"
                  ? EvidenceTypeContribution
                  : K extends "validators"
                    ? ValidatorContribution
                    : Contribution)[];
};

export interface DomainPackManifest {
  readonly schemaVersion: 1;
  readonly id: DomainPackId;
  readonly version: DomainPackVersion;
  readonly manifestDigest: ManifestDigest;
  readonly coreContract: CoreContractCompatibility;
  readonly metadata: { readonly name: string; readonly description: string };
  readonly dependencies: readonly DomainPackDependency[];
  readonly contributions: DomainPackContributions;
}

export type ManifestErrorCode =
  | "malformed_input"
  | "unsupported_schema"
  | "invalid_identity"
  | "invalid_contribution"
  | "invalid_dependency"
  | "digest_mismatch"
  | "incompatible_core_contract";

export class DomainPackManifestError extends Error {
  constructor(
    readonly code: ManifestErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "DomainPackManifestError";
  }
}

function fail(code: ManifestErrorCode, path: string, message: string): never {
  throw new DomainPackManifestError(code, path, message);
}

const packIdPattern =
  /^(?:[a-z](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const versionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const localIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseDomainPackId(value: unknown): DomainPackId {
  if (typeof value !== "string" || !packIdPattern.test(value))
    return fail("invalid_identity", "id", "expected lower-case reverse-DNS ID");
  return value as DomainPackId;
}

export function parseDomainPackVersion(value: unknown): DomainPackVersion {
  if (typeof value !== "string" || !versionPattern.test(value))
    return fail(
      "invalid_identity",
      "version",
      "expected exact MAJOR.MINOR.PATCH",
    );
  return value as DomainPackVersion;
}

export function parseManifestDigest(value: unknown): ManifestDigest {
  if (typeof value !== "string" || !digestPattern.test(value))
    return fail(
      "invalid_identity",
      "manifestDigest",
      "expected sha256: and 64 lowercase hex digits",
    );
  return value as ManifestDigest;
}

export function parseArtifactDigest(value: unknown): ArtifactDigest {
  if (typeof value !== "string" || !digestPattern.test(value))
    return fail(
      "invalid_identity",
      "artifactDigest",
      "expected sha256: and 64 lowercase hex digits",
    );
  return value as ArtifactDigest;
}

export function parseContributionLocalId(value: unknown): ContributionLocalId {
  if (typeof value !== "string" || !localIdPattern.test(value))
    return fail("invalid_identity", "id", "expected ASCII local ID");
  return value as ContributionLocalId;
}

export function parseQualifiedContributionRef(
  value: unknown,
): QualifiedContributionRef {
  const record = object(value, "reference", "invalid_identity");
  keys(record, ["pack", "kind", "id"], "reference", "invalid_identity");
  const kind = record.kind;
  if (!contributionKinds.some((candidate) => candidate === kind))
    return fail(
      "invalid_identity",
      "reference.kind",
      "unknown contribution kind",
    );
  return {
    pack: parseDomainPackId(record.pack),
    kind: kind as ContributionKind,
    id: parseContributionLocalId(record.id),
  };
}

export function parseCoreContractCompatibility(
  value: unknown,
): CoreContractCompatibility {
  const record = object(value, "coreContract", "malformed_input");
  keys(
    record,
    ["minInclusive", "maxExclusive"],
    "coreContract",
    "malformed_input",
  );
  const minInclusive = record.minInclusive;
  const maxExclusive = record.maxExclusive;
  if (
    typeof minInclusive !== "number" ||
    !Number.isSafeInteger(minInclusive) ||
    minInclusive < 0 ||
    typeof maxExclusive !== "number" ||
    !Number.isSafeInteger(maxExclusive) ||
    maxExclusive <= minInclusive
  )
    return fail(
      "malformed_input",
      "coreContract",
      "expected non-empty integer interval",
    );
  return { minInclusive, maxExclusive };
}

export function checkCoreContract(
  compatibility: CoreContractCompatibility,
  version: number,
): void {
  const range = parseCoreContractCompatibility(compatibility);
  if (
    !Number.isSafeInteger(version) ||
    version < range.minInclusive ||
    version >= range.maxExclusive
  )
    fail(
      "incompatible_core_contract",
      "coreContract",
      `core contract ${version} is outside the declared interval`,
    );
}

function object(
  value: unknown,
  path: string,
  code: ManifestErrorCode,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail(code, path, "expected object");
  return value as Record<string, unknown>;
}

function keys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: ManifestErrorCode,
): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) fail(code, `${path}.${key}`, "unknown field");
  for (const key of allowed)
    if (!Object.hasOwn(record, key))
      fail(code, `${path}.${key}`, "missing field");
}

/**
 * The one rule for manifest text: metadata name and description, every
 * contribution title and description, and the descriptive text of GP-10B-2
 * (stage title and objective, list entries, prompt text; the last two must
 * also be non-empty). A lone surrogate has no canonical JSON
 * form. U+0000 is allowed by design (GP-23): manifest text is not written to
 * project storage, unlike project definition text, which rejects it.
 */
function string(value: unknown, path: string, code: ManifestErrorCode): string {
  if (typeof value !== "string" || hasLoneSurrogate(value))
    return fail(code, path, "expected Unicode string");
  return value;
}

function localId(
  value: unknown,
  path: string,
  code: ManifestErrorCode,
): ContributionLocalId {
  if (typeof value !== "string" || !localIdPattern.test(value))
    return fail(code, path, "expected ASCII local ID");
  return value as ContributionLocalId;
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * The most references one list may hold: a role's capabilities, or an agent's
 * prompts, knowledge or requested capabilities. Shared with the project
 * mutation contract and the portable archive, so every accepted list stays
 * storable and exportable.
 */
export const maximumContributionReferences = 1_000;

/**
 * Shape of a list of references to contributions of the same manifest: a
 * role's capabilities, or an agent's prompts, knowledge and requested
 * capabilities. Whether each one names a declared contribution is checked once
 * every section has been read.
 */
function referenceList(
  value: unknown,
  path: string,
  noun: string,
): readonly ContributionLocalId[] {
  if (!Array.isArray(value))
    return fail("invalid_contribution", path, "expected array");
  // "None" has one encoding: the absent field.
  if (value.length === 0)
    return fail(
      "invalid_contribution",
      path,
      `expected at least one ${noun}; omit the field instead`,
    );
  if (value.length > maximumContributionReferences)
    return fail(
      "invalid_contribution",
      path,
      `expected at most ${maximumContributionReferences} ${noun} references`,
    );
  const parsed = value.map((entry: unknown, index: number) =>
    localId(entry, `${path}[${index}]`, "invalid_contribution"),
  );
  if (new Set(parsed).size !== parsed.length)
    fail("invalid_contribution", path, `duplicate ${noun} reference`);
  return parsed;
}

/**
 * The most entries one descriptive list may hold: a stage's `checks` or a
 * role's `responsibilities`. Shared with the project mutation contract and
 * the portable archive, so every accepted list stays storable and exportable.
 */
export const maximumDescriptiveListEntries = 64;

/**
 * An ordered list of descriptive text: a stage's `checks` or a role's
 * `responsibilities`. Order is kept as written and duplicates are allowed.
 * Every entry is non-empty manifest text.
 */
function descriptiveList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value))
    return fail("invalid_contribution", path, "expected array");
  // "None" has one encoding: the absent field.
  if (value.length === 0)
    return fail(
      "invalid_contribution",
      path,
      "expected at least one entry; omit the field instead",
    );
  if (value.length > maximumDescriptiveListEntries)
    return fail(
      "invalid_contribution",
      path,
      `expected at most ${maximumDescriptiveListEntries} entries`,
    );
  return value.map((entry: unknown, index: number) =>
    nonEmptyString(entry, `${path}[${index}]`),
  );
}

/** Manifest text that must say something: a list entry or a prompt text. */
function nonEmptyString(value: unknown, path: string): string {
  const text = string(value, path, "invalid_contribution");
  if (text.length === 0)
    return fail("invalid_contribution", path, "expected non-empty string");
  return text;
}

/** The list fields of an agent, with the noun used in their diagnostics. */
const agentReferenceLists = [
  ["prompts", "prompt"],
  ["knowledge", "knowledge"],
  ["capabilities", "capability"],
] as const;

/** The most operation names one policy stage may admit. */
export const maximumPolicyStageOperations = 64;
/** The most characters of one policy operation name. */
export const maximumPolicyOperationLength = 128;
const policyOperationPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const policyStageFlags = [
  "requiresApproval",
  "requiresIndependentApproval",
] as const;

/**
 * Shape of a policy item (GP-25), in its written order. Whether the workflow,
 * the stages and the separation targets exist, and the one order of each set,
 * are settled once every section has been read.
 */
function policyContribution(
  record: Record<string, unknown>,
  path: string,
  common: Contribution,
): PolicyContribution {
  if (record.workflow === undefined) {
    // An untyped policy is descriptive: a clause needs a target.
    if (record.enforcement !== undefined || record.stages !== undefined)
      fail(
        "invalid_contribution",
        `${path}.workflow`,
        "policy clauses need a target workflow",
      );
    return common;
  }
  const workflow = localId(
    record.workflow,
    `${path}.workflow`,
    "invalid_contribution",
  );
  // Guidance has one encoding: the absent field.
  if (record.enforcement !== undefined && record.enforcement !== "enforced")
    fail(
      "invalid_contribution",
      `${path}.enforcement`,
      'expected "enforced"; omit the field for guidance',
    );
  if (record.enforcement === undefined && record.stages === undefined)
    fail(
      "invalid_contribution",
      path,
      "typed policy declares neither enforcement nor stages",
    );
  const typed = {
    ...common,
    workflow,
    ...(record.enforcement === undefined
      ? {}
      : { enforcement: "enforced" as const }),
  };
  if (record.stages === undefined) return typed;
  if (!Array.isArray(record.stages))
    return fail("invalid_contribution", `${path}.stages`, "expected array");
  if (record.stages.length === 0)
    return fail(
      "invalid_contribution",
      `${path}.stages`,
      "expected at least one stage entry; omit the field instead",
    );
  const seen = new Set<string>();
  const stages = record.stages.map(
    (entry: unknown, index: number): PolicyStageClause => {
      const stagePath = `${path}.stages[${index}]`;
      const item = object(entry, stagePath, "invalid_contribution");
      for (const key of Object.keys(item))
        if (
          ![
            "stage",
            ...policyStageFlags,
            "requiresDifferentAgentFrom",
            "operations",
          ].includes(key)
        )
          fail("invalid_contribution", `${stagePath}.${key}`, "unknown field");
      const stage = localId(
        item.stage,
        `${stagePath}.stage`,
        "invalid_contribution",
      );
      if (seen.has(stage))
        fail(
          "invalid_contribution",
          `${stagePath}.stage`,
          "duplicate stage entry",
        );
      seen.add(stage);
      // A flag has one encoding: present as true, or absent.
      for (const flag of policyStageFlags)
        if (item[flag] !== undefined && item[flag] !== true)
          fail(
            "invalid_contribution",
            `${stagePath}.${flag}`,
            "expected true; omit the field instead",
          );
      if (
        item.requiresIndependentApproval === true &&
        item.requiresApproval !== true
      )
        fail(
          "invalid_contribution",
          `${stagePath}.requiresIndependentApproval`,
          "independent approval requires requiresApproval",
        );
      const clause = {
        stage,
        ...(item.requiresApproval === true
          ? { requiresApproval: true as const }
          : {}),
        ...(item.requiresIndependentApproval === true
          ? { requiresIndependentApproval: true as const }
          : {}),
        ...(item.requiresDifferentAgentFrom === undefined
          ? {}
          : {
              requiresDifferentAgentFrom: referenceList(
                item.requiresDifferentAgentFrom,
                `${stagePath}.requiresDifferentAgentFrom`,
                "stage",
              ),
            }),
        ...(item.operations === undefined
          ? {}
          : {
              operations: policyOperations(
                item.operations,
                `${stagePath}.operations`,
              ),
            }),
      };
      if (Object.keys(clause).length === 1)
        fail("invalid_contribution", stagePath, "stage entry has no clause");
      return clause;
    },
  );
  return { ...typed, stages };
}

/**
 * Operation names admitted on a policy stage: opaque strings in the legacy
 * operation-name grammar. They are not references to capability
 * contributions and are compared exactly.
 */
function policyOperations(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value))
    return fail("invalid_contribution", path, "expected array");
  // "No operation admitted" has one encoding: the absent field.
  if (value.length === 0)
    return fail(
      "invalid_contribution",
      path,
      "expected at least one operation; omit the field instead",
    );
  if (value.length > maximumPolicyStageOperations)
    return fail(
      "invalid_contribution",
      path,
      `expected at most ${maximumPolicyStageOperations} operations`,
    );
  const parsed = value.map((entry: unknown, index: number): string => {
    if (
      typeof entry !== "string" ||
      entry.length > maximumPolicyOperationLength ||
      !policyOperationPattern.test(entry)
    )
      return fail(
        "invalid_contribution",
        `${path}[${index}]`,
        "expected operation name",
      );
    return entry;
  });
  if (new Set(parsed).size !== parsed.length)
    fail("invalid_contribution", path, "duplicate operation");
  return parsed;
}

/** The most operations one capability may declare. */
export const maximumCapabilityOperations = 100;

/**
 * A connector operation name, `<connectorId>.<name>`: two or more ASCII
 * segments. A wildcard is not a name.
 */
const operationNamePattern =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;
const maximumOperationNameLength = 128;
const capabilityRequirements: readonly CapabilityRequirement[] = [
  "required",
  "optional",
];

/** The operation contract of a capability entry (GP-16). */
function capabilityContract(
  record: Record<string, unknown>,
  path: string,
): Pick<CapabilityContribution, "operations" | "requirement"> {
  const requirement = capabilityRequirements.find(
    (candidate) => candidate === record.requirement,
  );
  if (record.requirement !== undefined && requirement === undefined)
    return fail(
      "invalid_contribution",
      `${path}.requirement`,
      "expected required or optional",
    );
  if (record.operations === undefined) {
    // A requirement states nothing without an operation to require.
    if (requirement !== undefined)
      fail(
        "invalid_contribution",
        `${path}.requirement`,
        "requirement needs operations",
      );
    return {};
  }
  const list = record.operations;
  const listPath = `${path}.operations`;
  if (!Array.isArray(list))
    return fail("invalid_contribution", listPath, "expected array");
  // "None" has one encoding: the absent field.
  if (list.length === 0)
    return fail(
      "invalid_contribution",
      listPath,
      "expected at least one operation; omit the field instead",
    );
  if (list.length > maximumCapabilityOperations)
    return fail(
      "invalid_contribution",
      listPath,
      `expected at most ${maximumCapabilityOperations} operations`,
    );
  const operations = list.map(
    (entry: unknown, index: number): CapabilityOperation => {
      const entryPath = `${listPath}[${index}]`;
      const item = object(entry, entryPath, "invalid_contribution");
      keys(item, ["operation", "mode"], entryPath, "invalid_contribution");
      const { operation, mode } = item;
      if (
        typeof operation !== "string" ||
        operation.length > maximumOperationNameLength ||
        !operationNamePattern.test(operation)
      )
        return fail(
          "invalid_contribution",
          `${entryPath}.operation`,
          "expected operation name <connector>.<name>",
        );
      if (mode !== "read" && mode !== "mutation")
        return fail(
          "invalid_contribution",
          `${entryPath}.mode`,
          "expected read or mutation",
        );
      return { operation, mode };
    },
  );
  if (new Set(operations.map((entry) => entry.operation)).size !== list.length)
    fail("invalid_contribution", listPath, "duplicate operation");
  return {
    // A set: one order, so the digest does not depend on the written order.
    operations: operations.sort((left, right) =>
      compareCodeUnits(left.operation, right.operation),
    ),
    // The default has one canonical form.
    requirement: requirement ?? "required",
  };
}

/*
 * Ceilings of the GP-14A contract are part of the published contract: a pack
 * that declares a value at a ceiling stays valid only while the ceiling holds.
 * Raising a ceiling is compatible; lowering one is not.
 */
/** The deepest nesting of a data schema; the root is depth 1 (GP-14A). */
export const maximumSchemaDepth = 4;
/** The most properties one object schema may declare. */
export const maximumSchemaProperties = 64;
/** The most schema nodes one data schema may hold, the root included. */
export const maximumSchemaNodes = 256;
/** The most values one enum schema may list, and the longest of them. */
export const maximumSchemaEnumValues = 64;
export const maximumSchemaEnumValueLength = 128;
/** Ceilings for the optional string length and array size bounds. */
export const maximumSchemaStringLength = 65_536;
export const maximumSchemaArrayItems = 10_000;
const schemaPropertyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Names that would shadow an object member; rejected by name as well. */
const reservedSchemaPropertyNames = ["__proto__", "constructor", "prototype"];
const schemaMembers: Readonly<Record<string, readonly string[]>> = {
  string: ["type", "minLength", "maxLength"],
  integer: ["type", "minimum", "maximum"],
  number: ["type", "minimum", "maximum"],
  boolean: ["type"],
  enum: ["type", "values"],
  array: ["type", "items", "minItems", "maxItems"],
  object: ["type", "properties", "required"],
};

/**
 * Text inside a data schema (an enum value): the project definition rule
 * without its length bound. A lone surrogate has no canonical JSON form and
 * U+0000 is not stored by every provider, so schemas, unlike manifest text
 * (GP-23), exclude it. The check lives here because this package cannot
 * depend on the application layer that owns `isDefinitionText`.
 */
function schemaText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\u0000") &&
    !hasLoneSurrogate(value)
  );
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return fail(
      "invalid_contribution",
      path,
      `expected integer from ${minimum} to ${maximum}`,
    );
  return value;
}

/** A set of names in ascending code-unit order, duplicates rejected. */
function sortedUnique(values: readonly string[], path: string): string[] {
  if (new Set(values).size !== values.length)
    fail("invalid_contribution", path, "duplicate entry");
  return [...values].sort(compareCodeUnits);
}

/**
 * Shape of a data schema (GP-14A): the closed subset described by
 * `PackDataSchema`. `budget` counts nodes across the whole schema.
 */
function dataSchema(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): PackDataSchema {
  const record = object(value, path, "invalid_contribution");
  budget.nodes += 1;
  if (budget.nodes > maximumSchemaNodes)
    fail(
      "invalid_contribution",
      path,
      `schema may hold at most ${maximumSchemaNodes} nodes`,
    );
  if (depth > maximumSchemaDepth)
    fail(
      "invalid_contribution",
      path,
      `schema may nest at most ${maximumSchemaDepth} levels`,
    );
  const type = record.type;
  const allowed =
    typeof type === "string" && Object.hasOwn(schemaMembers, type)
      ? schemaMembers[type]!
      : undefined;
  if (allowed === undefined)
    return fail(
      "invalid_contribution",
      `${path}.type`,
      "expected string, integer, number, boolean, enum, array or object",
    );
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      fail(
        "invalid_contribution",
        `${path}.${key}`,
        key === "additionalProperties"
          ? "unknown field; an object schema is always closed"
          : "unknown field",
      );
  switch (type) {
    case "boolean":
      return { type };
    case "string": {
      const minLength =
        record.minLength === undefined
          ? undefined
          : boundedInteger(
              record.minLength,
              `${path}.minLength`,
              0,
              maximumSchemaStringLength,
            );
      const maxLength =
        record.maxLength === undefined
          ? undefined
          : boundedInteger(
              record.maxLength,
              `${path}.maxLength`,
              0,
              maximumSchemaStringLength,
            );
      if (
        minLength !== undefined &&
        maxLength !== undefined &&
        minLength > maxLength
      )
        fail(
          "invalid_contribution",
          `${path}.minLength`,
          "minLength exceeds maxLength",
        );
      return {
        type,
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
      };
    }
    case "integer":
    case "number": {
      const bound = (field: "minimum" | "maximum"): number | undefined => {
        const entry = record[field];
        if (entry === undefined) return undefined;
        if (
          typeof entry !== "number" ||
          !Number.isFinite(entry) ||
          (type === "integer" && !Number.isSafeInteger(entry))
        )
          return fail(
            "invalid_contribution",
            `${path}.${field}`,
            type === "integer" ? "expected safe integer" : "expected number",
          );
        return entry;
      };
      const minimum = bound("minimum");
      const maximum = bound("maximum");
      if (minimum !== undefined && maximum !== undefined && minimum > maximum)
        fail(
          "invalid_contribution",
          `${path}.minimum`,
          "minimum exceeds maximum",
        );
      return {
        type,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
    }
    case "enum": {
      const values = record.values;
      const valuesPath = `${path}.values`;
      if (!Array.isArray(values))
        return fail("invalid_contribution", valuesPath, "expected array");
      if (values.length === 0 || values.length > maximumSchemaEnumValues)
        return fail(
          "invalid_contribution",
          valuesPath,
          `expected 1 to ${maximumSchemaEnumValues} values`,
        );
      const parsed = values.map((entry: unknown, index: number): string => {
        if (
          !schemaText(entry) ||
          entry.length === 0 ||
          entry.length > maximumSchemaEnumValueLength
        )
          return fail(
            "invalid_contribution",
            `${valuesPath}[${index}]`,
            `expected non-empty text of at most ${maximumSchemaEnumValueLength} characters without U+0000 or a lone surrogate`,
          );
        return entry;
      });
      return { type, values: sortedUnique(parsed, valuesPath) };
    }
    case "array": {
      if (record.items === undefined)
        return fail("invalid_contribution", `${path}.items`, "missing field");
      const minItems =
        record.minItems === undefined
          ? undefined
          : boundedInteger(
              record.minItems,
              `${path}.minItems`,
              0,
              maximumSchemaArrayItems,
            );
      const maxItems =
        record.maxItems === undefined
          ? undefined
          : boundedInteger(
              record.maxItems,
              `${path}.maxItems`,
              0,
              maximumSchemaArrayItems,
            );
      if (
        minItems !== undefined &&
        maxItems !== undefined &&
        minItems > maxItems
      )
        fail(
          "invalid_contribution",
          `${path}.minItems`,
          "minItems exceeds maxItems",
        );
      return {
        type,
        items: dataSchema(record.items, `${path}.items`, depth + 1, budget),
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems }),
      };
    }
    default: {
      const propertiesPath = `${path}.properties`;
      const members = object(
        record.properties,
        propertiesPath,
        "invalid_contribution",
      );
      const names = Object.keys(members);
      if (names.length === 0 || names.length > maximumSchemaProperties)
        return fail(
          "invalid_contribution",
          propertiesPath,
          `expected 1 to ${maximumSchemaProperties} properties`,
        );
      for (const name of names)
        if (
          !schemaPropertyPattern.test(name) ||
          reservedSchemaPropertyNames.includes(name)
        )
          fail(
            "invalid_contribution",
            `${propertiesPath}.${name}`,
            "expected property name of a letter, then letters, digits, _ or -",
          );
      // A null prototype: an inherited name such as `toString` can never be
      // read as a declared property.
      const properties: { [name: string]: PackDataSchema } = Object.assign(
        Object.create(null) as object,
        Object.fromEntries(
          names
            .sort(compareCodeUnits)
            .map((name) => [
              name,
              dataSchema(
                members[name],
                `${propertiesPath}.${name}`,
                depth + 1,
                budget,
              ),
            ]),
        ),
      );
      if (record.required === undefined) return { type: "object", properties };
      const requiredPath = `${path}.required`;
      if (!Array.isArray(record.required))
        return fail("invalid_contribution", requiredPath, "expected array");
      // "None required" has one encoding: the absent field.
      if (record.required.length === 0)
        return fail(
          "invalid_contribution",
          requiredPath,
          "expected at least one name; omit the field instead",
        );
      const required = record.required.map(
        (entry: unknown, index: number): string => {
          if (typeof entry !== "string" || !Object.hasOwn(properties, entry))
            return fail(
              "invalid_contribution",
              `${requiredPath}[${index}]`,
              "required name is not a declared property",
            );
          return entry;
        },
      );
      return {
        type: "object",
        properties,
        required: sortedUnique(required, requiredPath),
      };
    }
  }
}

/** A data schema member of a contribution, with a fresh node budget. */
function contractSchema(value: unknown, path: string): PackDataSchema {
  return dataSchema(value, path, 1, { nodes: 0 });
}

/** The most media types one artifact type may declare. */
export const maximumArtifactMediaTypes = 16;
/** The most characters of one media type. */
export const maximumMediaTypeLength = 127;
/** Core ceiling of an artifact type's `maximumBytes`: 64 MiB. */
export const maximumArtifactTypeBytes = 67_108_864;
/**
 * `type/subtype` with the RFC 6838 restricted-name characters and no
 * parameter or wildcard. Lower case only, so a media type has one encoding.
 */
const mediaTypePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The typed members of an artifact type entry (GP-14A). */
function artifactTypeContract(
  record: Record<string, unknown>,
  path: string,
): Pick<
  ArtifactTypeContribution,
  "mediaTypes" | "maximumBytes" | "contentSchema"
> {
  let mediaTypes: readonly string[] | undefined;
  if (record.mediaTypes !== undefined) {
    const listPath = `${path}.mediaTypes`;
    if (!Array.isArray(record.mediaTypes))
      return fail("invalid_contribution", listPath, "expected array");
    if (
      record.mediaTypes.length === 0 ||
      record.mediaTypes.length > maximumArtifactMediaTypes
    )
      return fail(
        "invalid_contribution",
        listPath,
        `expected 1 to ${maximumArtifactMediaTypes} media types; omit the field for none`,
      );
    mediaTypes = sortedUnique(
      record.mediaTypes.map((entry: unknown, index: number): string => {
        if (
          typeof entry !== "string" ||
          entry.length > maximumMediaTypeLength ||
          !mediaTypePattern.test(entry)
        )
          return fail(
            "invalid_contribution",
            `${listPath}[${index}]`,
            "expected lower-case type/subtype media type",
          );
        return entry;
      }),
      listPath,
    );
  }
  return {
    ...(mediaTypes === undefined ? {} : { mediaTypes }),
    ...(record.maximumBytes === undefined
      ? {}
      : {
          maximumBytes: boundedInteger(
            record.maximumBytes,
            `${path}.maximumBytes`,
            1,
            maximumArtifactTypeBytes,
          ),
        }),
    ...(record.contentSchema === undefined
      ? {}
      : {
          contentSchema: contractSchema(
            record.contentSchema,
            `${path}.contentSchema`,
          ),
        }),
  };
}

/** Core ceilings of a validator reference's declared limits. */
export const maximumValidatorTimeoutMs = 60_000;
export const maximumValidatorInputBytes = 16_777_216;
export const maximumValidatorOutputBytes = 16_777_216;
/** The most input references one validator may accept. */
export const maximumValidatorAccepts = 64;
/** The most characters of an adapter ID. */
export const maximumValidatorAdapterIdLength = 128;
/**
 * An adapter name, a grammar of its own: lower-case segments separated by
 * `.`, `_` or `-`. It is not a connector operation name, a path or a URL.
 */
const validatorAdapterIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
/** Members that would make a validator look like something that runs. */
const executableValidatorKeys = ["command", "entry", "module", "url", "script"];
const validatorTypedMembers = [
  "accepts",
  "inputSchema",
  "produces",
  "outputSchema",
  "failurePolicy",
  "timeoutMs",
  "maxInputBytes",
  "maxOutputBytes",
] as const;
const validatorInputKinds = ["artifactTypes", "evidenceTypes"] as const;

/**
 * The typed members of a validator entry (GP-14A). Without `adapter` the
 * entry is a label and carries no other member; with it, every member is
 * required, so a typed validator has one complete encoding. Whether `accepts`
 * and `produces` name declared types is settled once every section has been
 * read.
 */
function validatorContract(
  record: Record<string, unknown>,
  path: string,
): Omit<ValidatorContribution, keyof Contribution> {
  if (record.adapter === undefined) {
    for (const member of validatorTypedMembers)
      if (record[member] !== undefined)
        fail(
          "invalid_contribution",
          `${path}.${member}`,
          "needs an adapter reference",
        );
    return {};
  }
  for (const member of validatorTypedMembers)
    if (record[member] === undefined)
      fail("invalid_contribution", `${path}.${member}`, "missing field");
  const adapterPath = `${path}.adapter`;
  const adapter = object(record.adapter, adapterPath, "invalid_contribution");
  for (const key of Object.keys(adapter))
    if (!["id", "version"].includes(key))
      fail(
        "invalid_contribution",
        `${adapterPath}.${key}`,
        executableValidatorKeys.includes(key)
          ? "unknown field; an adapter is named, never executed"
          : "unknown field",
      );
  if (
    typeof adapter.id !== "string" ||
    adapter.id.length > maximumValidatorAdapterIdLength ||
    !validatorAdapterIdPattern.test(adapter.id)
  )
    fail(
      "invalid_contribution",
      `${adapterPath}.id`,
      "expected lower-case adapter name of segments joined by . _ or -",
    );
  if (
    typeof adapter.version !== "string" ||
    !versionPattern.test(adapter.version)
  )
    fail(
      "invalid_contribution",
      `${adapterPath}.version`,
      "expected exact MAJOR.MINOR.PATCH",
    );
  const acceptsPath = `${path}.accepts`;
  if (!Array.isArray(record.accepts))
    return fail("invalid_contribution", acceptsPath, "expected array");
  if (
    record.accepts.length === 0 ||
    record.accepts.length > maximumValidatorAccepts
  )
    return fail(
      "invalid_contribution",
      acceptsPath,
      `expected 1 to ${maximumValidatorAccepts} references`,
    );
  const accepts = record.accepts.map(
    (entry: unknown, index: number): ValidatorInputReference => {
      const entryPath = `${acceptsPath}[${index}]`;
      const item = object(entry, entryPath, "invalid_contribution");
      keys(item, ["kind", "id"], entryPath, "invalid_contribution");
      const kind = validatorInputKinds.find(
        (candidate) => candidate === item.kind,
      );
      if (kind === undefined)
        return fail(
          "invalid_contribution",
          `${entryPath}.kind`,
          "expected artifactTypes or evidenceTypes",
        );
      return {
        kind,
        id: localId(item.id, `${entryPath}.id`, "invalid_contribution"),
      };
    },
  );
  if (
    new Set(accepts.map((entry) => `${entry.kind}\u0000${entry.id}`)).size !==
    accepts.length
  )
    fail("invalid_contribution", acceptsPath, "duplicate reference");
  if (record.failurePolicy !== "fail_closed")
    fail(
      "invalid_contribution",
      `${path}.failurePolicy`,
      'expected "fail_closed"',
    );
  return {
    adapter: { id: adapter.id as string, version: adapter.version as string },
    accepts,
    inputSchema: contractSchema(record.inputSchema, `${path}.inputSchema`),
    produces: localId(
      record.produces,
      `${path}.produces`,
      "invalid_contribution",
    ),
    outputSchema: contractSchema(record.outputSchema, `${path}.outputSchema`),
    failurePolicy: "fail_closed",
    timeoutMs: boundedInteger(
      record.timeoutMs,
      `${path}.timeoutMs`,
      1,
      maximumValidatorTimeoutMs,
    ),
    maxInputBytes: boundedInteger(
      record.maxInputBytes,
      `${path}.maxInputBytes`,
      1,
      maximumValidatorInputBytes,
    ),
    maxOutputBytes: boundedInteger(
      record.maxOutputBytes,
      `${path}.maxOutputBytes`,
      1,
      maximumValidatorOutputBytes,
    ),
  };
}

function contribution(
  value: unknown,
  path: string,
  kind: ContributionKind,
):
  | Contribution
  | RoleContribution
  | AgentContribution
  | PromptContribution
  | CapabilityContribution
  | WorkflowContribution
  | PolicyContribution
  | ArtifactTypeContribution
  | EvidenceTypeContribution
  | ValidatorContribution {
  const record = object(value, path, "invalid_contribution");
  const workflow = kind === "workflows";
  const allowed = workflow
    ? [
        "id",
        "title",
        "description",
        "taskType",
        "additionalTaskTypes",
        "stages",
      ]
    : kind === "roles"
      ? ["id", "title", "description", "capabilities", "responsibilities"]
      : kind === "agents"
        ? [
            "id",
            "title",
            "description",
            "role",
            "prompts",
            "knowledge",
            "capabilities",
          ]
        : kind === "prompts"
          ? ["id", "title", "description", "text"]
          : kind === "policies"
            ? [
                "id",
                "title",
                "description",
                "workflow",
                "enforcement",
                "stages",
              ]
            : ["id", "title", "description"];
  // GP-16: a capability entry may also carry its operation contract.
  if (kind === "capabilities") allowed.push("operations", "requirement");
  // GP-14A: typed artifact, evidence and validator declarations.
  if (kind === "artifactTypes")
    allowed.push("mediaTypes", "maximumBytes", "contentSchema");
  if (kind === "evidenceTypes") allowed.push("subject", "payloadSchema");
  if (kind === "validators") allowed.push("adapter", ...validatorTypedMembers);
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      fail(
        "invalid_contribution",
        `${path}.${key}`,
        kind === "validators" && executableValidatorKeys.includes(key)
          ? "unknown field; a validator is referenced, never executed"
          : "unknown field",
      );
  const id = localId(record.id, `${path}.id`, "invalid_contribution");
  const common: Contribution = {
    id,
    ...(record.title === undefined
      ? {}
      : {
          title: string(record.title, `${path}.title`, "invalid_contribution"),
        }),
    ...(record.description === undefined
      ? {}
      : {
          description: string(
            record.description,
            `${path}.description`,
            "invalid_contribution",
          ),
        }),
  };
  if (kind === "roles")
    return {
      ...common,
      ...(record.capabilities === undefined
        ? {}
        : {
            capabilities: referenceList(
              record.capabilities,
              `${path}.capabilities`,
              "capability",
            ),
          }),
      ...(record.responsibilities === undefined
        ? {}
        : {
            responsibilities: descriptiveList(
              record.responsibilities,
              `${path}.responsibilities`,
            ),
          }),
    };
  if (kind === "prompts")
    return record.text === undefined
      ? common
      : { ...common, text: nonEmptyString(record.text, `${path}.text`) };
  if (kind === "agents")
    return {
      ...common,
      ...(record.role === undefined
        ? {}
        : {
            role: localId(record.role, `${path}.role`, "invalid_contribution"),
          }),
      ...Object.fromEntries(
        agentReferenceLists.flatMap(([field, noun]) =>
          record[field] === undefined
            ? []
            : [[field, referenceList(record[field], `${path}.${field}`, noun)]],
        ),
      ),
    };
  if (kind === "policies") return policyContribution(record, path, common);
  if (kind === "capabilities")
    return { ...common, ...capabilityContract(record, path) };
  if (kind === "artifactTypes")
    return { ...common, ...artifactTypeContract(record, path) };
  if (kind === "evidenceTypes")
    return {
      ...common,
      ...(record.subject === undefined
        ? {}
        : {
            subject: localId(
              record.subject,
              `${path}.subject`,
              "invalid_contribution",
            ),
          }),
      ...(record.payloadSchema === undefined
        ? {}
        : {
            payloadSchema: contractSchema(
              record.payloadSchema,
              `${path}.payloadSchema`,
            ),
          }),
    };
  if (kind === "validators")
    return { ...common, ...validatorContract(record, path) };
  if (!workflow) return common;
  if (!Array.isArray(record.stages))
    return fail("invalid_contribution", `${path}.stages`, "expected array");
  const stages = record.stages.map(
    (entry: unknown, index: number): WorkflowStage => {
      const stagePath = `${path}.stages[${index}]`;
      const stage = object(entry, stagePath, "invalid_contribution");
      for (const key of Object.keys(stage))
        if (!["id", "role", "title", "objective", "checks"].includes(key))
          fail("invalid_contribution", `${stagePath}.${key}`, "unknown field");
      for (const key of ["id", "role"])
        if (!Object.hasOwn(stage, key))
          fail("invalid_contribution", `${stagePath}.${key}`, "missing field");
      return {
        id: localId(stage.id, `${stagePath}.id`, "invalid_contribution"),
        role: localId(stage.role, `${stagePath}.role`, "invalid_contribution"),
        ...Object.fromEntries(
          (["title", "objective"] as const).flatMap((field) =>
            stage[field] === undefined
              ? []
              : [
                  [
                    field,
                    string(
                      stage[field],
                      `${stagePath}.${field}`,
                      "invalid_contribution",
                    ),
                  ],
                ],
          ),
        ),
        ...(stage.checks === undefined
          ? {}
          : {
              checks: descriptiveList(stage.checks, `${stagePath}.checks`),
            }),
      };
    },
  );
  const stageIds = new Set(stages.map((stage) => stage.id));
  if (stageIds.size !== stages.length)
    fail("invalid_contribution", `${path}.stages`, "duplicate stage ID");
  return {
    ...common,
    taskType: localId(
      record.taskType,
      `${path}.taskType`,
      "invalid_contribution",
    ),
    ...(record.additionalTaskTypes === undefined
      ? {}
      : {
          additionalTaskTypes: referenceList(
            record.additionalTaskTypes,
            `${path}.additionalTaskTypes`,
            "task type",
          ),
        }),
    stages,
  };
}

function dependencies(value: unknown): readonly DomainPackDependency[] {
  if (!Array.isArray(value))
    return fail("invalid_dependency", "dependencies", "expected array");
  const parsed = value.map(
    (entry: unknown, index: number): DomainPackDependency => {
      const path = `dependencies[${index}]`;
      const record = object(entry, path, "invalid_dependency");
      keys(
        record,
        ["id", "version", "manifestDigest"],
        path,
        "invalid_dependency",
      );
      try {
        return {
          id: parseDomainPackId(record.id),
          version: parseDomainPackVersion(record.version),
          manifestDigest: parseManifestDigest(record.manifestDigest),
        };
      } catch (error) {
        if (error instanceof DomainPackManifestError)
          return fail("invalid_dependency", path, error.message);
        throw error;
      }
    },
  );
  if (new Set(parsed.map((dependency) => dependency.id)).size !== parsed.length)
    fail("invalid_dependency", "dependencies", "duplicate dependency ID");
  return parsed;
}

export function validateDomainPackManifest(value: unknown): DomainPackManifest {
  const record = object(value, "$", "malformed_input");
  if (Object.hasOwn(record, "schemaVersion") && record.schemaVersion !== 1)
    return fail(
      "unsupported_schema",
      "schemaVersion",
      "only schema version 1 is supported",
    );
  keys(
    record,
    [
      "schemaVersion",
      "id",
      "version",
      "manifestDigest",
      "coreContract",
      "metadata",
      "dependencies",
      "contributions",
    ],
    "$",
    "malformed_input",
  );
  const metadata = object(record.metadata, "metadata", "malformed_input");
  keys(metadata, ["name", "description"], "metadata", "malformed_input");
  const source = object(
    record.contributions,
    "contributions",
    "invalid_contribution",
  );
  keys(source, contributionKinds, "contributions", "invalid_contribution");
  const contributions = {} as Record<ContributionKind, readonly Contribution[]>;
  for (const kind of contributionKinds) {
    const items = source[kind];
    if (!Array.isArray(items))
      return fail(
        "invalid_contribution",
        `contributions.${kind}`,
        "expected array",
      );
    const parsed = items.map((entry: unknown, index: number) =>
      contribution(entry, `contributions.${kind}[${index}]`, kind),
    );
    if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length)
      fail(
        "invalid_contribution",
        `contributions.${kind}`,
        "duplicate contribution ID",
      );
    contributions[kind] = parsed;
  }
  // Schema-1 references are bare local IDs: a role can only name a capability
  // this manifest declares, never one of another pack.
  const declared = new Set(contributions.capabilities.map((entry) => entry.id));
  contributions.roles = (
    contributions.roles as readonly RoleContribution[]
  ).map((role, index) => {
    if (role.capabilities === undefined) return role;
    for (const [position, capability] of role.capabilities.entries())
      if (!declared.has(capability))
        fail(
          "invalid_contribution",
          `contributions.roles[${index}].capabilities[${position}]`,
          "capability is not declared by this manifest",
        );
    // A set: one order, so the digest does not depend on the written order.
    return {
      ...role,
      capabilities: [...role.capabilities].sort(compareCodeUnits),
    };
  });
  // An agent's references follow the same rule: bare local IDs of this
  // manifest, each list a set in one order.
  const roleSets = new Map(
    (contributions.roles as readonly RoleContribution[]).map((role) => [
      role.id,
      role.capabilities ?? [],
    ]),
  );
  contributions.agents = (
    contributions.agents as readonly AgentContribution[]
  ).map((agent, index) => {
    const path = `contributions.agents[${index}]`;
    const roleSet =
      agent.role === undefined ? undefined : roleSets.get(agent.role);
    if (agent.role !== undefined && roleSet === undefined)
      fail(
        "invalid_contribution",
        `${path}.role`,
        "role is not declared by this manifest",
      );
    const lists: {
      prompts?: ContributionLocalId[];
      knowledge?: ContributionLocalId[];
      capabilities?: ContributionLocalId[];
    } = {};
    for (const [field, noun] of agentReferenceLists) {
      const references = agent[field];
      if (references === undefined) continue;
      // The limit: a request needs a role and stays inside that role's set.
      if (field === "capabilities" && roleSet === undefined)
        fail(
          "invalid_contribution",
          `${path}.capabilities`,
          "requested capabilities need a role",
        );
      const known = new Set(contributions[field].map((entry) => entry.id));
      for (const [position, reference] of references.entries()) {
        if (!known.has(reference))
          fail(
            "invalid_contribution",
            `${path}.${field}[${position}]`,
            `${noun} is not declared by this manifest`,
          );
        if (field === "capabilities" && !roleSet?.includes(reference))
          fail(
            "invalid_contribution",
            `${path}.capabilities[${position}]`,
            "capability is not declared by the agent's role",
          );
      }
      lists[field] = [...references].sort(compareCodeUnits);
    }
    return { ...agent, ...lists };
  });
  // A workflow's additional routes follow the same rule: bare local IDs of
  // task types this manifest declares, a set in one order. The task type
  // itself is not an additional one.
  const taskTypes = new Set(contributions.taskTypes.map((entry) => entry.id));
  contributions.workflows = (
    contributions.workflows as readonly WorkflowContribution[]
  ).map((workflow, index) => {
    if (workflow.additionalTaskTypes === undefined) return workflow;
    const path = `contributions.workflows[${index}].additionalTaskTypes`;
    for (const [
      position,
      reference,
    ] of workflow.additionalTaskTypes.entries()) {
      if (reference === workflow.taskType)
        fail(
          "invalid_contribution",
          `${path}[${position}]`,
          "the task type is not an additional task type",
        );
      if (!taskTypes.has(reference))
        fail(
          "invalid_contribution",
          `${path}[${position}]`,
          "task type is not declared by this manifest",
        );
    }
    return {
      ...workflow,
      additionalTaskTypes: [...workflow.additionalTaskTypes].sort(
        compareCodeUnits,
      ),
    };
  });
  // A typed policy governs one workflow of this manifest, and a workflow has
  // at most one policy. Stage and separation references are checked in the
  // written order; each set is then held in one order.
  const workflowStages = new Map(
    (contributions.workflows as readonly WorkflowContribution[]).map(
      (workflow) => [
        workflow.id as string,
        workflow.stages.map((stage) => stage.id as string),
      ],
    ),
  );
  const governed = new Set<string>();
  contributions.policies = (
    contributions.policies as readonly PolicyContribution[]
  ).map((policy, index) => {
    if (policy.workflow === undefined) return policy;
    const path = `contributions.policies[${index}]`;
    const order = workflowStages.get(policy.workflow);
    if (order === undefined)
      return fail(
        "invalid_contribution",
        `${path}.workflow`,
        "workflow is not declared by this manifest",
      );
    if (governed.has(policy.workflow))
      fail(
        "invalid_contribution",
        `${path}.workflow`,
        "workflow already has a policy in this manifest",
      );
    governed.add(policy.workflow);
    if (policy.stages === undefined) return policy;
    const stages = policy.stages.map((clause, position) => {
      const stagePath = `${path}.stages[${position}]`;
      const at = order.indexOf(clause.stage);
      if (at < 0)
        fail(
          "invalid_contribution",
          `${stagePath}.stage`,
          "stage is not declared by the target workflow",
        );
      for (const [entry, predecessor] of (
        clause.requiresDifferentAgentFrom ?? []
      ).entries()) {
        const before = order.indexOf(predecessor);
        if (before < 0 || before >= at)
          fail(
            "invalid_contribution",
            `${stagePath}.requiresDifferentAgentFrom[${entry}]`,
            "separation target is not an earlier stage of the target workflow",
          );
      }
      return {
        ...clause,
        ...(clause.requiresDifferentAgentFrom === undefined
          ? {}
          : {
              requiresDifferentAgentFrom: [
                ...clause.requiresDifferentAgentFrom,
              ].sort(compareCodeUnits),
            }),
        ...(clause.operations === undefined
          ? {}
          : { operations: [...clause.operations].sort(compareCodeUnits) }),
      };
    });
    return {
      ...policy,
      stages: stages.sort((left, right) =>
        compareCodeUnits(left.stage, right.stage),
      ),
    };
  });
  // GP-14A references are bare local IDs of this manifest as well: an
  // evidence type's subject is an artifact type, and a validator accepts
  // artifact or evidence types and produces an evidence type.
  const artifactTypeIds = new Set(
    contributions.artifactTypes.map((entry) => entry.id),
  );
  const evidenceTypeIds = new Set(
    contributions.evidenceTypes.map((entry) => entry.id),
  );
  for (const [index, entry] of (
    contributions.evidenceTypes as readonly EvidenceTypeContribution[]
  ).entries())
    if (entry.subject !== undefined && !artifactTypeIds.has(entry.subject))
      fail(
        "invalid_contribution",
        `contributions.evidenceTypes[${index}].subject`,
        "artifact type is not declared by this manifest",
      );
  contributions.validators = (
    contributions.validators as readonly ValidatorContribution[]
  ).map((entry, index) => {
    const path = `contributions.validators[${index}]`;
    for (const [position, input] of (entry.accepts ?? []).entries())
      if (
        !(
          input.kind === "artifactTypes" ? artifactTypeIds : evidenceTypeIds
        ).has(input.id)
      )
        fail(
          "invalid_contribution",
          `${path}.accepts[${position}].id`,
          `${input.kind === "artifactTypes" ? "artifact" : "evidence"} type is not declared by this manifest`,
        );
    if (entry.produces !== undefined && !evidenceTypeIds.has(entry.produces))
      fail(
        "invalid_contribution",
        `${path}.produces`,
        "evidence type is not declared by this manifest",
      );
    return entry.accepts === undefined
      ? entry
      : {
          ...entry,
          accepts: [...entry.accepts].sort(
            (left, right) =>
              compareCodeUnits(left.kind, right.kind) ||
              compareCodeUnits(left.id, right.id),
          ),
        };
  });
  return {
    schemaVersion: 1,
    id: parseDomainPackId(record.id),
    version: parseDomainPackVersion(record.version),
    manifestDigest: parseManifestDigest(record.manifestDigest),
    coreContract: parseCoreContractCompatibility(record.coreContract),
    metadata: {
      name: string(metadata.name, "metadata.name", "malformed_input"),
      description: string(
        metadata.description,
        "metadata.description",
        "malformed_input",
      ),
    },
    dependencies: dependencies(record.dependencies),
    contributions: contributions as unknown as DomainPackContributions,
  };
}

/** A strict JSON reader keeps duplicate decoded keys visible until they are rejected. */
class StrictJsonReader {
  private index = 0;

  constructor(private readonly source: string) {}

  read(): unknown {
    const value = this.value(0);
    this.space();
    if (this.index !== this.source.length)
      fail("malformed_input", "$", "trailing JSON content");
    return value;
  }

  private space(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.source[this.index] ?? "!"))
      this.index += 1;
  }

  private value(depth: number): unknown {
    if (depth > 128)
      return fail("malformed_input", "$", "JSON nesting limit exceeded");
    this.space();
    const next = this.source[this.index];
    if (next === "{") return this.object(depth + 1);
    if (next === "[") return this.array(depth + 1);
    if (next === '"') return this.quoted();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.source.startsWith(word, this.index)) {
        this.index += word.length;
        return value;
      }
    }
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.index;
    const number = match.exec(this.source);
    if (number) {
      this.index = match.lastIndex;
      const value = Number(number[0]);
      if (
        !Number.isFinite(value) ||
        (/^-?(?:0|[1-9][0-9]*)$/.test(number[0]) &&
          !Number.isSafeInteger(value))
      )
        return fail(
          "malformed_input",
          "$",
          "number is outside interoperable JSON range",
        );
      return value;
    }
    return fail("malformed_input", "$", `invalid JSON at offset ${this.index}`);
  }

  private quoted(): string {
    const start = this.index++;
    let escaped = false;
    for (; this.index < this.source.length; this.index += 1) {
      const char = this.source[this.index]!;
      if (!escaped && char === '"') {
        this.index += 1;
        let value: string;
        try {
          value = JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          return fail("malformed_input", "$", "invalid JSON string escape");
        }
        if (hasLoneSurrogate(value))
          return fail("malformed_input", "$", "lone Unicode surrogate");
        return value;
      }
      if (!escaped && char.charCodeAt(0) < 0x20)
        return fail("malformed_input", "$", "unescaped control character");
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    return fail("malformed_input", "$", "unterminated JSON string");
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    this.space();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.index] !== '"')
        return fail("malformed_input", "$", "object key must be a string");
      let key: string;
      try {
        key = this.quoted();
      } catch (error) {
        return this.rethrowSyntax(error);
      }
      if (Object.hasOwn(result, key))
        return fail("malformed_input", "$", `duplicate JSON member ${key}`);
      this.space();
      if (this.source[this.index++] !== ":")
        return fail("malformed_input", "$", "expected colon");
      result[key] = this.value(depth);
      this.space();
      const separator = this.source[this.index++];
      if (separator === "}") return result;
      if (separator !== ",")
        return fail("malformed_input", "$", "expected comma or object end");
    }
  }

  private array(depth: number): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth));
      this.space();
      const separator = this.source[this.index++];
      if (separator === "]") return result;
      if (separator !== ",")
        return fail("malformed_input", "$", "expected comma or array end");
    }
  }

  private rethrowSyntax(error: unknown): never {
    if (error instanceof SyntaxError)
      return fail("malformed_input", "$", "invalid JSON string escape");
    throw error;
  }
}

export function parseDomainPackManifest(bytes: Uint8Array): DomainPackManifest {
  if (!(bytes instanceof Uint8Array))
    return fail("malformed_input", "$", "expected UTF-8 bytes");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return fail("malformed_input", "$", "UTF-8 BOM is forbidden");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail("malformed_input", "$", "invalid UTF-8");
  }
  return validateDomainPackManifest(new StrictJsonReader(source).read());
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalizeDomainPackManifest(
  manifest: DomainPackManifest,
): Uint8Array {
  const valid = validateDomainPackManifest(manifest);
  const normalized = {
    schemaVersion: valid.schemaVersion,
    id: valid.id,
    version: valid.version,
    coreContract: valid.coreContract,
    metadata: valid.metadata,
    dependencies: [...valid.dependencies].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    contributions: Object.fromEntries(
      contributionKinds.map((kind) => [
        kind,
        [...valid.contributions[kind]].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      ]),
    ),
  };
  return new TextEncoder().encode(
    canonicalizeJcsJson(
      normalized as unknown as Parameters<typeof canonicalizeJcsJson>[0],
    ),
  );
}

export function computeManifestDigest(
  manifest: DomainPackManifest,
): ManifestDigest {
  return digest(canonicalizeDomainPackManifest(manifest)) as ManifestDigest;
}

export function computeArtifactDigest(bytes: Uint8Array): ArtifactDigest {
  return digest(bytes) as ArtifactDigest;
}

export function verifyDomainPackManifest(
  bytes: Uint8Array,
  coreContractVersion?: number,
): DomainPackManifest {
  const manifest = parseDomainPackManifest(bytes);
  if (computeManifestDigest(manifest) !== manifest.manifestDigest)
    fail(
      "digest_mismatch",
      "manifestDigest",
      "declared digest differs from canonical manifest",
    );
  if (coreContractVersion !== undefined)
    checkCoreContract(manifest.coreContract, coreContractVersion);
  return manifest;
}

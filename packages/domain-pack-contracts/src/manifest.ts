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

export interface WorkflowStage {
  readonly id: ContributionLocalId;
  readonly role: ContributionLocalId;
}

export interface WorkflowContribution extends Contribution {
  readonly taskType: ContributionLocalId;
  readonly stages: readonly WorkflowStage[];
}

export type DomainPackContributions = {
  readonly [K in ContributionKind]: readonly (K extends "workflows"
    ? WorkflowContribution
    : K extends "roles"
      ? RoleContribution
      : K extends "agents"
        ? AgentContribution
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
 * The one rule for manifest text: metadata name and description, and every
 * contribution title and description. A lone surrogate has no canonical JSON
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

/** The list fields of an agent, with the noun used in their diagnostics. */
const agentReferenceLists = [
  ["prompts", "prompt"],
  ["knowledge", "knowledge"],
  ["capabilities", "capability"],
] as const;

function contribution(
  value: unknown,
  path: string,
  kind: ContributionKind,
): Contribution | RoleContribution | AgentContribution | WorkflowContribution {
  const record = object(value, path, "invalid_contribution");
  const workflow = kind === "workflows";
  const allowed = workflow
    ? ["id", "title", "description", "taskType", "stages"]
    : kind === "roles"
      ? ["id", "title", "description", "capabilities"]
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
        : ["id", "title", "description"];
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      fail("invalid_contribution", `${path}.${key}`, "unknown field");
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
    return record.capabilities === undefined
      ? common
      : {
          ...common,
          capabilities: referenceList(
            record.capabilities,
            `${path}.capabilities`,
            "capability",
          ),
        };
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
  if (!workflow) return common;
  if (!Array.isArray(record.stages))
    return fail("invalid_contribution", `${path}.stages`, "expected array");
  const stages = record.stages.map(
    (entry: unknown, index: number): WorkflowStage => {
      const stagePath = `${path}.stages[${index}]`;
      const stage = object(entry, stagePath, "invalid_contribution");
      keys(stage, ["id", "role"], stagePath, "invalid_contribution");
      return {
        id: localId(stage.id, `${stagePath}.id`, "invalid_contribution"),
        role: localId(stage.role, `${stagePath}.role`, "invalid_contribution"),
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

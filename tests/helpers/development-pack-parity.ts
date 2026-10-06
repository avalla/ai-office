import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyDevelopmentProfile } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { ResolvedProjectConfiguration } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

/**
 * GP-10A, test only. The development pack is a committed reference artifact
 * that no production code reads. These helpers read it, install it in a
 * catalog that exists only in a test, and project the two sides of
 * expressible-subset parity into one shape: the resolved configuration of a
 * project bound to the pack, and the GP-09 legacy development profile of the
 * same project. Nothing here is a Runtime mapping.
 */
export const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const developmentPackDirectory = join(
  repositoryRoot,
  "packages",
  "domain-pack-development",
);
export const developmentPackManifestPath = join(
  developmentPackDirectory,
  "manifest.json",
);
export const outsidePackVocabularyPath = join(
  developmentPackDirectory,
  "outside-pack-vocabulary.json",
);
export const shippedAgentsDirectory = join(repositoryRoot, "agents");
export const shippedOfficeManifestPath = join(
  repositoryRoot,
  ".agents",
  "skills",
  "ai-office",
  "assets",
  "default-office-manifest.json",
);

export const developmentPackId = "org.ai-office.development";
export const developmentPackVersion = "0.1.0";
/** Pinned: it moves only with the pack version. */
export const developmentPackManifestDigest =
  "sha256:cda1c5fc48b5e04d75905d00f0f5d2b41a69e497eb4cc009a3aa77cfc2dac567";
/** The follow-up Runtime task that owns execution parity. */
export const executionParityTaskId = "a45ddb12-3159-4b60-9b8b-c26516720834";

export const legacyRoleIds = [
  "architect",
  "developer",
  "qa",
  "reviewer",
] as const;

/** The exact committed bytes of the pack manifest. */
export function developmentPackBytes(): Uint8Array {
  return new Uint8Array(readFileSync(developmentPackManifestPath));
}

export interface RawPackManifest {
  version: string;
  manifestDigest: string;
  contributions: Record<
    string,
    {
      id: string;
      title?: string;
      description?: string;
      role?: string;
      capabilities?: string[];
    }[]
  >;
}

/**
 * A copy of the pack with one change and a recomputed digest, so that it is a
 * valid manifest that differs from the committed one in exactly that change.
 */
export function mutatedDevelopmentPackBytes(
  mutate: (manifest: RawPackManifest) => void,
): Uint8Array {
  const encoder = new TextEncoder();
  const manifest = JSON.parse(
    new TextDecoder().decode(developmentPackBytes()),
  ) as RawPackManifest;
  mutate(manifest);
  manifest.manifestDigest = computeManifestDigest(
    parseDomainPackManifest(encoder.encode(JSON.stringify(manifest))),
  );
  return encoder.encode(JSON.stringify(manifest));
}

/** A catalog that exists only in the test, holding the given manifest. */
export function testCatalogWith(bytes: Uint8Array): {
  catalog: InMemoryInstalledDomainPackCatalog;
  pack: PackIdentity;
} {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, ["gp10a-test"]);
  const pack = catalog.register({
    bytes,
    artifactDigest: computeArtifactDigest(bytes),
    provenance: { installerId: "gp10a-test", reference: "development-pack" },
  });
  return { catalog, pack };
}

/**
 * The comparison shape of expressible-subset parity: what a schema-1 pack can
 * say about a role, an agent and a task type, and nothing else. Lists are in
 * code-unit order; a capability list is a set.
 */
export interface ExpressibleSubset {
  readonly roles: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly capabilities: readonly string[];
  }[];
  readonly agents: readonly {
    readonly id: string;
    readonly role: string | null;
  }[];
  readonly taskTypes: readonly string[];
}

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function byId<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => byCodeUnits(left.id, right.id));
}

/**
 * The legacy side. A role is the office role with the capabilities of the
 * Runtime role of the same key as a set; `purpose` is the description. An
 * agent is its name and the office role it serves. Roles and agents outside
 * the office manifest (`runtimeOnly`) are not development defaults and are
 * not projected.
 */
export function projectLegacyProfile(
  profile: Pick<LegacyDevelopmentProfile, "roles" | "agents" | "taskKinds">,
): ExpressibleSubset {
  return {
    roles: byId(
      profile.roles.map((role) => ({
        id: role.id,
        title: role.title,
        description: role.purpose,
        capabilities: [...new Set(role.runtime?.capabilities ?? [])].sort(
          byCodeUnits,
        ),
      })),
    ),
    agents: byId(
      profile.agents.map((agent) => ({ id: agent.name, role: agent.roleId })),
    ),
    taskTypes: profile.taskKinds.map((route) => route.kind).sort(byCodeUnits),
  };
}

/** The local ID of a pack-stable ID such as `pack:<pack>/roles/<id>`. */
function localIdOf(stableId: string, kind: string): string {
  const marker = `/${kind}/`;
  const index = stableId.indexOf(marker);
  if (!stableId.startsWith("pack:") || index === -1)
    throw new Error(`Not a pack ${kind} ID: ${stableId}`);
  return stableId.slice(index + marker.length);
}

/**
 * The pack side: every enabled role, agent and task type of the resolved
 * configuration, whatever its origin, named by its local ID.
 */
export function projectResolvedConfiguration(
  configuration: Pick<
    ResolvedProjectConfiguration,
    "roles" | "agents" | "effectiveDefinitions" | "origins"
  >,
): ExpressibleSubset {
  const local = (effectiveId: string): string => {
    const origin = configuration.origins[effectiveId];
    if (origin === undefined) throw new Error(`No origin for ${effectiveId}`);
    return origin.localId;
  };
  const roleLocalIds = new Map(
    configuration.roles.map((role) => [role.roleId, local(role.effectiveId)]),
  );
  return {
    roles: byId(
      configuration.roles.map((role) => ({
        id: local(role.effectiveId),
        title: role.title ?? null,
        description: role.description ?? null,
        capabilities: role.capabilities
          .map((capability) => localIdOf(capability, "capabilities"))
          .sort(byCodeUnits),
      })),
    ),
    agents: byId(
      configuration.agents.map((agent) => ({
        id: local(agent.effectiveId),
        role:
          agent.roleId === undefined
            ? null
            : (roleLocalIds.get(agent.roleId) ?? agent.roleId),
      })),
    ),
    taskTypes: configuration.effectiveDefinitions.taskTypes
      .filter((definition) => definition.enabled)
      .map((definition) => definition.localId)
      .sort(byCodeUnits),
  };
}

export const outsideVocabularyOwners = [
  "GP-10B",
  "GP-10C",
  executionParityTaskId,
] as const;
export type OutsideVocabularyOwner = (typeof outsideVocabularyOwners)[number];

export const outsideVocabularySubjects = [
  "office_role",
  "runtime_role",
  "agent",
  "task_kind",
  "pipeline",
  "stage",
] as const;
export type OutsideVocabularySubject =
  (typeof outsideVocabularySubjects)[number];

export interface OutsideVocabularyEntry {
  readonly subject: OutsideVocabularySubject;
  readonly field: string;
  /** Present when only one aspect of the field is outside the vocabulary. */
  readonly aspect?: string;
  readonly owner: OutsideVocabularyOwner;
  /**
   * The GP-09 `vocabularyGaps` code that reports the field in a state that
   * uses it, or null.
   */
  readonly gp09Gap: string | null;
  /**
   * Whether the default legacy state uses the field. False marks a legacy
   * field the pack vocabulary cannot express that the defaults do not use:
   * it is listed so that its owner is on record, not because it was observed.
   */
  readonly inDefaultState: boolean;
  readonly reason: string;
}

export interface OutsidePackVocabulary {
  readonly schemaVersion: 1;
  readonly pack: { readonly id: string; readonly version: string };
  readonly claim: string;
  readonly description: string;
  readonly owners: Readonly<Record<string, string>>;
  readonly entries: readonly OutsideVocabularyEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rejects any shape other than the one documented in the plan. */
export function parseOutsidePackVocabulary(
  value: unknown,
): OutsidePackVocabulary {
  if (!isRecord(value) || !Array.isArray(value.entries))
    throw new Error("outside-pack-vocabulary: expected an entries list");
  if (
    Object.keys(value).sort().join() !==
    "claim,description,entries,owners,pack,schemaVersion"
  )
    throw new Error("outside-pack-vocabulary: unexpected top-level keys");
  for (const [index, entry] of value.entries.entries()) {
    const fail = (detail: string): never => {
      throw new Error(`outside-pack-vocabulary entry ${index}: ${detail}`);
    };
    if (!isRecord(entry)) return fail("expected an object");
    const allowed = [
      "subject",
      "field",
      "aspect",
      "owner",
      "gp09Gap",
      "inDefaultState",
      "reason",
    ];
    for (const key of Object.keys(entry))
      if (!allowed.includes(key)) fail(`unknown key ${key}`);
    if (!outsideVocabularySubjects.some((subject) => subject === entry.subject))
      fail("unknown subject");
    if (typeof entry.field !== "string" || entry.field === "")
      fail("missing field");
    if (
      entry.aspect !== undefined &&
      (typeof entry.aspect !== "string" || entry.aspect === "")
    )
      fail("invalid aspect");
    if (!outsideVocabularyOwners.some((owner) => owner === entry.owner))
      fail("missing or unknown owner");
    if (entry.gp09Gap !== null && typeof entry.gp09Gap !== "string")
      fail("gp09Gap must be a code or null");
    if (typeof entry.inDefaultState !== "boolean")
      fail("inDefaultState must be true or false");
    if (typeof entry.reason !== "string" || entry.reason === "")
      fail("missing reason");
  }
  return value as unknown as OutsidePackVocabulary;
}

/** The committed list of legacy fields outside the pack vocabulary. */
export function outsidePackVocabulary(): OutsidePackVocabulary {
  return parseOutsidePackVocabulary(
    JSON.parse(readFileSync(outsidePackVocabularyPath, "utf8")),
  );
}

/** `subject.field`, with `#aspect` when only an aspect is outside. */
export function entryKey(
  entry: Pick<OutsideVocabularyEntry, "subject" | "field" | "aspect">,
): string {
  return `${entry.subject}.${entry.field}${entry.aspect === undefined ? "" : `#${entry.aspect}`}`;
}

type ProfileSections = Pick<
  LegacyDevelopmentProfile,
  "roles" | "agents" | "taskKinds"
>;

function changed(value: unknown): unknown {
  if (typeof value === "string") return `${value}-gp10a`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return [...(value as unknown[]), "gp10a"];
  if (isRecord(value)) return { ...value, gp10a: true };
  return "gp10a";
}

/**
 * Every legacy field of the profile's office roles, their Runtime roles, its
 * agents and its task kinds, each with whether the projection reads it. That
 * is decided by changing the field in a copy and comparing the projections,
 * so the answer cannot disagree with `projectLegacyProfile`.
 */
export function classifyLegacyFields(
  profile: ProfileSections,
): { readonly key: string; readonly projected: boolean }[] {
  const baseline = JSON.stringify(projectLegacyProfile(profile));
  const fields = new Map<string, boolean>();
  const visit = (
    subject: OutsideVocabularySubject,
    pick: (copy: ProfileSections) => Record<string, unknown> | null,
  ) => {
    const record = pick(profile);
    if (record === null) return;
    for (const field of Object.keys(record)) {
      if (subject === "office_role" && field === "runtime") continue;
      const copy = structuredClone(profile);
      const target = pick(copy)!;
      target[field] = changed(target[field]);
      const projected = JSON.stringify(projectLegacyProfile(copy)) !== baseline;
      const key = `${subject}.${field}`;
      fields.set(key, (fields.get(key) ?? false) || projected);
    }
  };
  const record = (value: unknown) => value as Record<string, unknown>;
  profile.roles.forEach((_role, index) => {
    visit("office_role", (copy) => record(copy.roles[index]));
    visit("runtime_role", (copy) =>
      copy.roles[index]!.runtime === null
        ? null
        : record(copy.roles[index]!.runtime),
    );
  });
  profile.agents.forEach((_agent, index) =>
    visit("agent", (copy) => record(copy.agents[index])),
  );
  profile.taskKinds.forEach((_kind, index) =>
    visit("task_kind", (copy) => record(copy.taskKinds[index])),
  );
  return [...fields]
    .map(([key, projected]) => ({ key, projected }))
    .sort((left, right) => byCodeUnits(left.key, right.key));
}

const classifiedSubjects: readonly string[] = [
  "office_role",
  "runtime_role",
  "agent",
  "task_kind",
];

/**
 * Violations of "every legacy field is in the projection or in the list,
 * never both and never neither", and list entries that name no legacy field.
 */
export function completenessViolations(
  profile: ProfileSections,
  vocabulary: OutsidePackVocabulary,
): string[] {
  const fields = classifyLegacyFields(profile);
  const whole = new Set(
    vocabulary.entries
      .filter((entry) => entry.aspect === undefined)
      .map(entryKey),
  );
  const known = new Map(fields.map((field) => [field.key, field.projected]));
  return [
    ...fields
      .filter((field) => field.projected === whole.has(field.key))
      .map(
        (field) =>
          `${field.key} is ${field.projected ? "in both the projection and the list" : "in neither the projection nor the list"}`,
      ),
    ...vocabulary.entries
      .filter((entry) => classifiedSubjects.includes(entry.subject))
      .flatMap((entry) => {
        const projected = known.get(`${entry.subject}.${entry.field}`);
        if (projected === undefined)
          return [`${entryKey(entry)} names no legacy field`];
        // An aspect entry covers part of a field the projection reads.
        return entry.aspect !== undefined && !projected
          ? [`${entryKey(entry)} is an aspect of a field that is not projected`]
          : [];
      }),
  ];
}

const gapSubjects: Readonly<Record<string, OutsideVocabularySubject>> = {
  pipeline_routes_several_task_kinds: "pipeline",
  pipeline_fields_not_expressible: "pipeline",
  stage_fields_not_expressible: "stage",
  role_fields_not_expressible: "office_role",
  runtime_role_fields_not_expressible: "runtime_role",
};

/** GP-09 `vocabularyGaps` fields of the profile that the list does not carry. */
export function missingGp09Gaps(
  profile: Pick<LegacyDevelopmentProfile, "vocabularyGaps">,
  vocabulary: OutsidePackVocabulary,
): string[] {
  const listed = new Set(
    vocabulary.entries.map((entry) => `${entry.gp09Gap}:${entryKey(entry)}`),
  );
  const missing = new Set<string>();
  for (const gap of profile.vocabularyGaps)
    for (const field of gap.fields) {
      const key = `${gap.code}:${gapSubjects[gap.code]}.${field}`;
      if (!listed.has(key)) missing.add(key);
    }
  return [...missing].sort(byCodeUnits);
}

/**
 * Entries whose `inDefaultState` disagrees with the profile. An entry that
 * cites a GP-09 code is in the default state exactly when GP-09 reports its
 * field under that code. An entry that cites none has nothing to show it
 * unused, so it must be marked as in the default state; for a role, agent or
 * task-kind field `completenessViolations` then proves that it exists.
 */
export function defaultStateViolations(
  profile: Pick<LegacyDevelopmentProfile, "vocabularyGaps">,
  vocabulary: OutsidePackVocabulary,
): string[] {
  const reported = new Set(
    profile.vocabularyGaps.flatMap((gap) =>
      gap.fields.map(
        (field) => `${gap.code}:${gapSubjects[gap.code]}.${field}`,
      ),
    ),
  );
  return vocabulary.entries.flatMap((entry) => {
    const key = entryKey(entry);
    if (entry.gp09Gap === null)
      return entry.inDefaultState
        ? []
        : [`${key} is marked unused and cites no GP-09 code`];
    const used = reported.has(`${entry.gp09Gap}:${key}`);
    if (entry.inDefaultState === used) return [];
    return [
      used
        ? `${key} is marked unused and the state uses it`
        : `${key} is marked as used and ${entry.gp09Gap} does not report it`,
    ];
  });
}

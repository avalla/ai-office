import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyDevelopmentProfile } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { ResolvedProjectConfiguration } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { legacyRoleGuidanceDigest } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

/**
 * GP-10A, GP-10B-1, GP-10B-2 (pack 0.3.0) and GP-25 PR 2 (pack 0.4.0), test only. The development pack is a committed
 * reference artifact that no production code reads. These helpers read it,
 * install it in a catalog that exists only in a test, and project the two
 * sides of expressible-subset parity into one shape: the resolved
 * configuration of a project bound to the pack, and the GP-09 legacy
 * development profile of the same project. Nothing here is a Runtime mapping.
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
export const developmentPackVersion = "0.5.0";
/** Pinned: it moves only with the pack version. */
export const developmentPackManifestDigest =
  "sha256:a8f9c9e083b7c76437392b990583d3c675074c1e1d7e0f3394a73a1fbb8864fd";
/** The follow-up Runtime task that owns execution parity. */
export const executionParityTaskId = "a45ddb12-3159-4b60-9b8b-c26516720834";
/** The Runtime task of GP-10B-2, the descriptive contract extension. */
export const descriptiveExtensionTaskId =
  "e890324a-ecd4-4fcc-b1f8-37fdbdaca319";
/** The Runtime task of the policy task, provisionally numbered GP-25. */
export const policyTaskId = "1a883c04-0905-4b36-a57b-12d45fdfd59f";

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
      responsibilities?: string[];
      prompts?: string[];
      text?: string;
      taskType?: string;
      additionalTaskTypes?: string[];
      /** A workflow's stages, or the governed stages of a policy. */
      stages?: {
        id: string;
        role: string;
        title?: string;
        objective?: string;
        checks?: string[];
      }[];
      /** Policy item (GP-25). */
      workflow?: string;
      enforcement?: string;
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

export interface ExpressedRoute {
  readonly taskType: string;
  readonly workflow: string;
}

/**
 * The comparison shape of expressible-subset parity: what a schema-1 pack can
 * say about a role, an agent, a task type and a workflow, and nothing else.
 * Lists are in code-unit order and a capability list is a set. The stages of
 * a workflow are the exception: their order is compared.
 */
export interface ExpressibleSubset {
  readonly roles: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly capabilities: readonly string[];
    /** Ordered: the legacy office role's responsibilities (GP-10B-2). */
    readonly responsibilities: readonly string[];
  }[];
  readonly agents: readonly {
    readonly id: string;
    readonly role: string | null;
  }[];
  readonly taskTypes: readonly string[];
  readonly workflows: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly description: string | null;
    /** Every task type the workflow routes: the legacy `defaultFor`. */
    readonly taskTypes: readonly string[];
    readonly stages: readonly {
      readonly id: string;
      readonly role: string;
      /** The legacy stage `name`. */
      readonly title: string | null;
      readonly objective: string | null;
      /** Ordered. */
      readonly checks: readonly string[];
    }[];
  }[];
  /** Each task type with the workflow it routes to. */
  readonly routes: readonly ExpressedRoute[];
  /**
   * The governance of every workflow (GP-25 PR 2): its `enforcement` and the
   * stages that carry a clause. The legacy side reads `enforcement`,
   * `requiresApproval`, `requiresIndependentApproval`,
   * `requiresDifferentAgentFrom` and `capabilities`; the pack side reads the
   * resolved `policies` view. Both are declarations here.
   */
  readonly governance: readonly {
    readonly id: string;
    readonly enforcement: "enforced" | "guidance";
    /** In ascending order of stage ID; a stage with no clause is not listed. */
    readonly stages: readonly GovernedStage[];
  }[];
}

/** The clauses of one stage with every fact stated; lists are sets. */
export interface GovernedStage {
  readonly id: string;
  readonly requiresApproval: boolean;
  readonly requiresIndependentApproval: boolean;
  readonly requiresDifferentAgentFrom: readonly string[];
  /** The legacy stage `capabilities`; absent and empty are equal. */
  readonly operations: readonly string[];
}

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function byId<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => byCodeUnits(left.id, right.id));
}

function sortedRoutes(routes: readonly ExpressedRoute[]): ExpressedRoute[] {
  return [...routes].sort(
    (left, right) =>
      byCodeUnits(left.taskType, right.taskType) ||
      byCodeUnits(left.workflow, right.workflow),
  );
}

const carriesClause = (stage: GovernedStage): boolean =>
  stage.requiresApproval ||
  stage.requiresIndependentApproval ||
  stage.requiresDifferentAgentFrom.length > 0 ||
  stage.operations.length > 0;

const governedStages = (stages: readonly GovernedStage[]): GovernedStage[] =>
  stages
    .filter(carriesClause)
    .sort((left, right) => byCodeUnits(left.id, right.id));

type ProfileSections = Pick<
  LegacyDevelopmentProfile,
  "roles" | "agents" | "taskKinds" | "pipelines"
>;

/** Every route of the legacy state: each task kind that has a pipeline. */
export function legacyRoutes(
  profile: Pick<LegacyDevelopmentProfile, "taskKinds">,
): ExpressedRoute[] {
  return sortedRoutes(
    profile.taskKinds.flatMap((route) =>
      route.pipelineId === null
        ? []
        : [{ taskType: route.kind, workflow: route.pipelineId }],
    ),
  );
}

/**
 * The legacy side. A role is the office role with the capabilities of the
 * Runtime role of the same key as a set; `purpose` is the description. An
 * agent is its name and the office role it serves. Roles and agents outside
 * the office manifest (`runtimeOnly`) are not development defaults and are
 * not projected.
 *
 * A workflow is a pipeline: `name` is the title, `roleId` the stage role, and
 * `defaultFor` the task types. A stage is its ID, role, name as title,
 * objective and ordered checks. The legacy state holds routing twice, as
 * `defaultFor` of a pipeline and as the pipeline of a task kind, and both are
 * read, for every task kind (GP-10B-2).
 */
export function projectLegacyProfile(
  profile: ProfileSections,
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
        responsibilities: [...role.responsibilities],
      })),
    ),
    agents: byId(
      profile.agents.map((agent) => ({ id: agent.name, role: agent.roleId })),
    ),
    taskTypes: profile.taskKinds.map((route) => route.kind).sort(byCodeUnits),
    workflows: byId(
      profile.pipelines.map((pipeline) => ({
        id: pipeline.id,
        title: pipeline.name,
        description: pipeline.description,
        taskTypes: [...pipeline.defaultFor].sort(byCodeUnits),
        stages: pipeline.stages.map((stage) => ({
          id: stage.id,
          role: stage.roleId,
          title: stage.name,
          objective: stage.objective,
          checks: [...stage.checks],
        })),
      })),
    ),
    routes: legacyRoutes(profile),
    governance: byId(
      profile.pipelines.map((pipeline) => ({
        id: pipeline.id,
        enforcement:
          pipeline.enforcement === "enforced"
            ? ("enforced" as const)
            : ("guidance" as const),
        stages: governedStages(
          pipeline.stages.map((stage) => ({
            id: stage.id,
            requiresApproval: stage.requiresApproval,
            requiresIndependentApproval:
              stage.requiresIndependentApproval === true,
            requiresDifferentAgentFrom: [
              ...(stage.requiresDifferentAgentFrom ?? []),
            ].sort(byCodeUnits),
            operations: [...(stage.capabilities ?? [])].sort(byCodeUnits),
          })),
        ),
      })),
    ),
  };
}

/** One role's guidance, compared apart from the shared shape. */
export interface GuidanceDigest {
  readonly role: string;
  readonly digest: string | null;
}

/**
 * The legacy guidance digest of each default role. It is not part of
 * `ExpressibleSubset`: the GP-09 fixture carries synthetic guidance, so the
 * comparison is made on the shipped defaults only.
 */
export function projectLegacyGuidance(
  profile: Pick<LegacyDevelopmentProfile, "roles">,
): GuidanceDigest[] {
  return profile.roles
    .map((role) => ({
      role: role.id,
      digest: role.runtime?.guidance?.digest ?? null,
    }))
    .sort((left, right) => byCodeUnits(left.role, right.role));
}

/**
 * The local ID of a stable ID: `pack:<pack>/<kind>/<id>` or
 * `project:<kind>/<id>`.
 */
function localIdOf(stableId: string, kind: string): string {
  const projectPrefix = `project:${kind}/`;
  if (stableId.startsWith(projectPrefix))
    return stableId.slice(projectPrefix.length);
  const marker = `/${kind}/`;
  const index = stableId.indexOf(marker);
  if (!stableId.startsWith("pack:") || index === -1)
    throw new Error(`Not a ${kind} ID: ${stableId}`);
  return stableId.slice(index + marker.length);
}

/**
 * The pack side: every enabled role, agent, task type and workflow of the
 * resolved configuration, whatever its origin, named by its local ID. A
 * workflow names one task type, which is its one route.
 */
export function projectResolvedConfiguration(
  configuration: Pick<
    ResolvedProjectConfiguration,
    | "roles"
    | "agents"
    | "workflows"
    | "policies"
    | "effectiveDefinitions"
    | "origins"
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
  const workflows = byId(
    configuration.workflows.map((workflow) => ({
      id: local(workflow.effectiveId),
      title: workflow.title ?? null,
      description: workflow.description ?? null,
      taskTypes: [
        workflow.taskTypeId,
        ...(workflow.additionalTaskTypeIds ?? []),
      ]
        .map((taskTypeId) => localIdOf(taskTypeId, "taskTypes"))
        .sort(byCodeUnits),
      stages: workflow.stages.map((stage) => ({
        id: stage.id,
        role: roleLocalIds.get(stage.roleId) ?? stage.roleId,
        title: stage.title ?? null,
        objective: stage.objective ?? null,
        checks: [...(stage.checks ?? [])],
      })),
    })),
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
        responsibilities: [...(role.responsibilities ?? [])],
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
    workflows,
    routes: sortedRoutes(
      workflows.flatMap((workflow) =>
        workflow.taskTypes.map((taskType) => ({
          taskType,
          workflow: workflow.id,
        })),
      ),
    ),
    governance: byId(
      configuration.workflows.map((workflow) => {
        const policy = configuration.policies.find(
          (candidate) => candidate.workflowId === workflow.workflowId,
        );
        return {
          id: local(workflow.effectiveId),
          enforcement: policy?.enforcement ?? ("guidance" as const),
          stages: governedStages(
            (policy?.stages ?? []).map((stage) => ({
              id: stage.stage,
              requiresApproval: stage.requiresApproval,
              requiresIndependentApproval: stage.requiresIndependentApproval,
              requiresDifferentAgentFrom: [
                ...stage.requiresDifferentAgentFrom,
              ].sort(byCodeUnits),
              operations: [...stage.operations].sort(byCodeUnits),
            })),
          ),
        };
      }),
    ),
  };
}

/**
 * The pack side of guidance: for each role, the digest of the text of the one
 * prompt that the agent of the role references, or null when the role has no
 * agent or the agent does not name exactly one prompt.
 */
export function projectResolvedGuidance(
  configuration: Pick<
    ResolvedProjectConfiguration,
    "roles" | "agents" | "effectiveDefinitions" | "origins"
  >,
): GuidanceDigest[] {
  // An agent names a prompt by its stable ID, which carries no pack version.
  const stable = (effectiveId: string): string => {
    const origin = configuration.origins[effectiveId];
    if (origin === undefined) throw new Error(`No origin for ${effectiveId}`);
    return origin.origin === "pack_owned"
      ? `pack:${origin.pack.id}/prompts/${origin.localId}`
      : `project:prompts/${origin.localId}`;
  };
  const texts = new Map(
    configuration.effectiveDefinitions.prompts.map((prompt) => [
      stable(prompt.effectiveId),
      (prompt.payload as { text?: string }).text,
    ]),
  );
  return configuration.roles
    .map((role) => {
      const origin = configuration.origins[role.effectiveId];
      if (origin === undefined)
        throw new Error(`No origin for ${role.effectiveId}`);
      const prompts = configuration.agents
        .filter((agent) => agent.roleId === role.roleId)
        .flatMap((agent) => agent.prompts);
      const text = prompts.length === 1 ? texts.get(prompts[0]!) : undefined;
      return {
        role: origin.localId,
        digest: text === undefined ? null : legacyRoleGuidanceDigest(text),
      };
    })
    .sort((left, right) => byCodeUnits(left.role, right.role));
}

export const outsideVocabularyOwners = [
  "GP-10B-2",
  "GP-25",
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
  /** The task that owns the residue next. */
  readonly owner: OutsideVocabularyOwner;
  /**
   * The part of the field the pack carries, or null when it carries none of
   * it.
   */
  readonly delivered: string | null;
  /**
   * What stays outside the pack, or null when the pack carries the whole
   * field (GP-10B-2 PR 2). An entry with no residue still names its owner:
   * the task that delivered it.
   */
  readonly residue: string | null;
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
  readonly schemaVersion: 3;
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
  if (value.schemaVersion !== 3)
    throw new Error("outside-pack-vocabulary: expected schemaVersion 3");
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
      "delivered",
      "residue",
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
    if (
      entry.delivered !== null &&
      (typeof entry.delivered !== "string" || entry.delivered === "")
    )
      fail("delivered must be a statement or null");
    if (
      entry.residue !== null &&
      (typeof entry.residue !== "string" || entry.residue === "")
    )
      fail("residue must be a statement or null");
    if (entry.residue === null && entry.delivered === null)
      fail("an entry with nothing delivered must state its residue");
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

function changed(value: unknown): unknown {
  if (typeof value === "string") return `${value}-gp10a`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return [...(value as unknown[]), "gp10a"];
  // Role guidance is read through its digest.
  if (isRecord(value) && typeof value.digest === "string")
    return { ...value, digest: `${value.digest}-gp10a` };
  if (isRecord(value)) return { ...value, gp10a: true };
  return "gp10a";
}

/**
 * Fields of the profile that are not legacy fields of their own: the two
 * containers, whose content is visited as its own subject, and the agents
 * GP-09 derives for a stage from the agents' role and enablement.
 */
const structuralFields: readonly string[] = [
  "office_role.runtime",
  "pipeline.stages",
  "stage.eligibleAgents",
];

/**
 * Every legacy field of the profile's office roles, their Runtime roles, its
 * agents, its task kinds, its pipelines and their stages, each with whether
 * the projection reads it. That is decided by changing the field in a copy
 * and comparing the projections, so the answer cannot disagree with
 * `projectLegacyProfile` and `projectLegacyGuidance`. A field counts as read
 * when the change shows on any record.
 */
export function classifyLegacyFields(
  profile: ProfileSections,
): { readonly key: string; readonly projected: boolean }[] {
  const projection = (state: ProfileSections) =>
    JSON.stringify([projectLegacyProfile(state), projectLegacyGuidance(state)]);
  const baseline = projection(profile);
  const fields = new Map<string, boolean>();
  const visit = (
    subject: OutsideVocabularySubject,
    pick: (copy: ProfileSections) => Record<string, unknown> | null,
  ) => {
    const record = pick(profile);
    if (record === null) return;
    for (const field of Object.keys(record)) {
      if (structuralFields.includes(`${subject}.${field}`)) continue;
      const copy = structuredClone(profile);
      const target = pick(copy)!;
      target[field] = changed(target[field]);
      const projected = projection(copy) !== baseline;
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
  profile.pipelines.forEach((pipeline, index) => {
    visit("pipeline", (copy) => record(copy.pipelines[index]));
    pipeline.stages.forEach((_stage, stageIndex) =>
      visit("stage", (copy) =>
        record(copy.pipelines[index]!.stages[stageIndex]),
      ),
    );
  });
  return [...fields]
    .map(([key, projected]) => ({ key, projected }))
    .sort((left, right) => byCodeUnits(left.key, right.key));
}

/**
 * Subjects with optional fields, which a state that does not use them does
 * not hold.
 */
const optionalFieldSubjects: readonly OutsideVocabularySubject[] = [
  "pipeline",
  "stage",
];

/**
 * Violations of "every legacy field is in the projection or in the list,
 * never both and never neither", and list entries that name no legacy field.
 *
 * An entry covers a whole field when it names no aspect and delivers
 * nothing: that field must not be read by the projection. An entry that
 * names an aspect or a delivered part covers the rest of a field the
 * projection does read. A pipeline or stage entry marked as unused by the
 * default state names an optional field the state does not hold, so it
 * cannot be looked up here; `defaultStateViolations` checks it. Every other
 * entry is looked up, marked as unused or not: every state holds every field
 * of a role, an agent and a task kind.
 */
export function completenessViolations(
  profile: ProfileSections,
  vocabulary: OutsidePackVocabulary,
): string[] {
  const fields = classifyLegacyFields(profile);
  const whole = new Set(
    vocabulary.entries
      .filter((entry) => entry.aspect === undefined && entry.delivered === null)
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
      .filter(
        (entry) =>
          entry.inDefaultState ||
          !optionalFieldSubjects.includes(entry.subject),
      )
      .flatMap((entry) => {
        const projected = known.get(`${entry.subject}.${entry.field}`);
        if (projected === undefined)
          return [`${entryKey(entry)} names no legacy field`];
        if (projected)
          return entry.residue === null && entry.aspect !== undefined
            ? [`${entryKey(entry)} names an aspect and states no residue`]
            : [];
        // A partial entry covers the rest of a field the projection reads.
        return [
          ...(entry.aspect === undefined
            ? []
            : [
                `${entryKey(entry)} is an aspect of a field that is not projected`,
              ]),
          ...(entry.delivered === null
            ? []
            : [
                `${entryKey(entry)} states a delivered part of a field that is not projected`,
              ]),
        ];
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

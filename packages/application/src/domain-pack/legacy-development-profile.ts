import { createHash } from "node:crypto";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { RoleProps } from "@ai-office/domain/agent/role.ts";
import {
  officeTaskKinds,
  type OfficeManifest,
  type OfficePipeline,
  type OfficePipelineStage,
  type OfficeTaskKind,
  type VirtualOfficeRole,
} from "@ai-office/domain/office/office-manifest.ts";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";

/**
 * GP-09 legacy development profile: a derived, read-only description of the
 * office, role, agent, task-kind and pipeline state the Runtime reads from a
 * legacy project today (legacy-state parity). It is not a Domain Pack, not a
 * resolved configuration and not executable: nothing is bound, persisted or
 * scheduled from it. Any change to the mapping or to the digest material is a
 * new profile version.
 */
export const legacyDevelopmentProfileId =
  "ai-office.legacy-development" as const;
export const legacyDevelopmentProfileVersion = 1 as const;
export const legacyDevelopmentProfileStatement =
  "Legacy-state profile: it describes the office, role, agent and pipeline state the Runtime reads today. It is not an executable resolved configuration, and nothing is bound or scheduled from it." as const;

/**
 * `stale_legacy_state` is raised by `ReadLegacyDevelopmentProfile`, never by
 * the derivation: the state changed during the read, which may be repeated.
 */
export type LegacyDevelopmentProfileIssueCode =
  "legacy_state_invariant" | "profile_not_canonical" | "stale_legacy_state";

export class LegacyDevelopmentProfileError extends Error {
  constructor(
    readonly code: LegacyDevelopmentProfileIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyDevelopmentProfileError";
  }
}

/** The Runtime role fields the derivation reads; `id` only joins agents. */
export type LegacyRuntimeRoleState = Pick<
  RoleProps,
  | "id"
  | "key"
  | "name"
  | "version"
  | "capabilities"
  | "tools"
  | "modelPolicy"
  | "limits"
  | "guidanceText"
  | "guidanceVersion"
>;

export type LegacyRuntimeAgentState = Pick<
  Agent,
  "name" | "roleId" | "enabled"
>;

export interface LegacyDevelopmentProfileInput {
  /** Latest office manifest revision, or null for a project with no office. */
  readonly office: {
    readonly revision: number;
    readonly manifest: OfficeManifest;
  } | null;
  readonly roles: readonly LegacyRuntimeRoleState[];
  readonly agents: readonly LegacyRuntimeAgentState[];
  /** Whether the project currently selects at least one Domain Pack. */
  readonly packBindingPresent: boolean;
}

/** Digest and version of the role guidance; the text is never carried. */
export interface LegacyRoleGuidance {
  readonly version: number;
  readonly digest: string;
}

/** Runtime `Role` fields as stored, without row ID, source path or times. */
export interface LegacyRuntimeRole {
  readonly name: string;
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly modelPolicy: string;
  readonly limits: {
    readonly maxIterations: number;
    /** Decimal string: the stored value is a 64-bit integer. */
    readonly maxCostMicros: string;
    readonly timeoutSeconds: number;
  };
  readonly guidance: LegacyRoleGuidance | null;
}

/** A manifest role, verbatim, joined to the Runtime role of the same key. */
export interface LegacyOfficeRole extends VirtualOfficeRole {
  readonly runtime: LegacyRuntimeRole | null;
}

/** A Runtime agent whose role key is a manifest role ID. */
export interface LegacyOfficeAgent {
  readonly name: string;
  readonly roleId: string;
  readonly enabled: boolean;
}

/** A manifest stage, verbatim, with the agents the orchestrator considers. */
export interface LegacyPipelineStage extends OfficePipelineStage {
  /** Names of enabled agents whose role key equals `roleId`. */
  readonly eligibleAgents: readonly string[];
}

export interface LegacyPipeline extends Omit<OfficePipeline, "stages"> {
  readonly stages: readonly LegacyPipelineStage[];
}

export interface LegacyTaskKindRoute {
  readonly kind: OfficeTaskKind;
  /** The pipeline `office:pipeline` returns, or null when it has none. */
  readonly pipelineId: string | null;
}

export interface LegacyRuntimeOnlyRole extends LegacyRuntimeRole {
  readonly provenance: "runtime_role_outside_office_manifest";
  readonly key: string;
}

export interface LegacyRuntimeOnlyAgent {
  readonly provenance: "runtime_agent_outside_office_manifest";
  readonly name: string;
  readonly roleKey: string;
  readonly enabled: boolean;
}

export type LegacyProfileDiagnosticCode =
  | "manifest_role_without_runtime_role"
  | "runtime_role_outside_manifest"
  | "runtime_role_without_agent"
  | "task_kind_unrouted"
  | "stage_without_eligible_agent";

export interface LegacyProfileDiagnostic {
  readonly code: LegacyProfileDiagnosticCode;
  readonly subject: string;
}

/** Legacy state that the schema-1 pack vocabulary cannot express. */
export type LegacyVocabularyGapCode =
  | "pipeline_routes_several_task_kinds"
  | "pipeline_fields_not_expressible"
  | "stage_fields_not_expressible"
  | "role_fields_not_expressible"
  | "runtime_role_fields_not_expressible";

export interface LegacyVocabularyGap {
  readonly code: LegacyVocabularyGapCode;
  readonly subject: string;
  readonly fields: readonly string[];
}

export interface LegacyDevelopmentProfile {
  readonly profileId: typeof legacyDevelopmentProfileId;
  readonly profileVersion: typeof legacyDevelopmentProfileVersion;
  readonly source: "legacy_state";
  readonly executable: false;
  readonly statement: typeof legacyDevelopmentProfileStatement;
  readonly profileDigest: string;
  /** Facts about the read, not about the profile. Not digest material. */
  readonly metadata: {
    readonly officeManifestRevision: number | null;
    readonly packBinding: { readonly present: boolean };
  };
  readonly office: { readonly name: string } | null;
  readonly roles: readonly LegacyOfficeRole[];
  readonly agents: readonly LegacyOfficeAgent[];
  readonly taskKinds: readonly LegacyTaskKindRoute[];
  readonly pipelines: readonly LegacyPipeline[];
  /** Runtime state the office manifest does not name. Never pack content. */
  readonly runtimeOnly: {
    readonly roles: readonly LegacyRuntimeOnlyRole[];
    readonly agents: readonly LegacyRuntimeOnlyAgent[];
  };
  /** Determined by the sections above. Not digest material. */
  readonly diagnostics: readonly LegacyProfileDiagnostic[];
  /** Determined by the sections above. Not digest material. */
  readonly vocabularyGaps: readonly LegacyVocabularyGap[];
}

/** UTF-16 code-unit order, independent of locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(prefix: string, text: string): string {
  return `sha256:${createHash("sha256").update(`${prefix}\n${text}`).digest("hex")}`;
}

/** Digest of the exact guidance text; no normalization. */
export function legacyRoleGuidanceDigest(text: string): string {
  return sha256("ai-office-legacy-role-guidance-v1", text);
}

function runtimeRole(role: LegacyRuntimeRoleState): LegacyRuntimeRole {
  return {
    name: role.name,
    version: role.version,
    capabilities: [...role.capabilities],
    tools: [...role.tools],
    modelPolicy: role.modelPolicy,
    limits: {
      maxIterations: role.limits.maxIterations,
      maxCostMicros: role.limits.maxCostMicros.toString(),
      timeoutSeconds: role.limits.timeoutSeconds,
    },
    guidance:
      role.guidanceText === undefined || role.guidanceText === ""
        ? null
        : {
            version: role.guidanceVersion ?? 1,
            digest: legacyRoleGuidanceDigest(role.guidanceText),
          },
  };
}

function invariant(message: string): LegacyDevelopmentProfileError {
  return new LegacyDevelopmentProfileError("legacy_state_invariant", message);
}

function stage(
  value: OfficePipelineStage,
  eligibleAgents: readonly string[],
): LegacyPipelineStage {
  return {
    id: value.id,
    name: value.name,
    roleId: value.roleId,
    objective: value.objective,
    checks: [...value.checks],
    requiresApproval: value.requiresApproval,
    ...(value.requiresIndependentApproval === undefined
      ? {}
      : { requiresIndependentApproval: value.requiresIndependentApproval }),
    ...(value.capabilities === undefined
      ? {}
      : { capabilities: [...value.capabilities] }),
    ...(value.requiresDifferentAgentFrom === undefined
      ? {}
      : { requiresDifferentAgentFrom: [...value.requiresDifferentAgentFrom] }),
    eligibleAgents,
  };
}

const expressibleStageFields = new Set(["id", "roleId", "eligibleAgents"]);

/**
 * Derives profile version 1. Pure: no clock, no storage, no project ID. The
 * order of `roles`, `agents`, manifest roles and manifest pipelines does not
 * change the result; stage order and every authored list are kept as given.
 */
export function deriveLegacyDevelopmentProfile(
  input: LegacyDevelopmentProfileInput,
): LegacyDevelopmentProfile {
  const rolesById = new Map<string, LegacyRuntimeRoleState>();
  const rolesByKey = new Map<string, LegacyRuntimeRoleState>();
  for (const role of input.roles) {
    if (rolesById.has(role.id) || rolesByKey.has(role.key))
      throw invariant("Runtime role keys are not unique in the project");
    rolesById.set(role.id, role);
    rolesByKey.set(role.key, role);
  }
  const agentNames = new Set<string>();
  const agents = input.agents.map((agent) => {
    const role = rolesById.get(agent.roleId);
    if (role === undefined)
      throw invariant("A Runtime agent names a role outside the project");
    if (agentNames.has(agent.name))
      throw invariant("Runtime agent names are not unique in the project");
    agentNames.add(agent.name);
    return { name: agent.name, roleKey: role.key, enabled: agent.enabled };
  });
  agents.sort((left, right) => compareCodeUnits(left.name, right.name));

  const manifest = input.office?.manifest ?? null;
  const manifestRoleIds = new Set(
    manifest?.office.roles.map((role) => role.id) ?? [],
  );
  /** The orchestrator's candidate rule: enabled, and role key equals stage role. */
  const eligible = (roleId: string): string[] =>
    agents
      .filter((agent) => agent.enabled && agent.roleKey === roleId)
      .map((agent) => agent.name);

  const roles: LegacyOfficeRole[] = (manifest?.office.roles ?? [])
    .map((role) => {
      const runtime = rolesByKey.get(role.id);
      return {
        id: role.id,
        title: role.title,
        purpose: role.purpose,
        responsibilities: [...role.responsibilities],
        runtime: runtime === undefined ? null : runtimeRole(runtime),
      };
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  const pipelines: LegacyPipeline[] = (manifest?.pipelines ?? [])
    .map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      defaultFor: [...pipeline.defaultFor],
      ...(pipeline.enforcement === undefined
        ? {}
        : { enforcement: pipeline.enforcement }),
      stages: pipeline.stages.map((value) =>
        stage(value, eligible(value.roleId)),
      ),
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  // Same rule as `GetOfficeContext.resolvePipeline`: the first pipeline, in
  // manifest order, whose `defaultFor` names the kind.
  const taskKinds: LegacyTaskKindRoute[] =
    manifest === null
      ? []
      : officeTaskKinds.map((kind) => ({
          kind,
          pipelineId:
            manifest.pipelines.find((pipeline) =>
              pipeline.defaultFor.includes(kind),
            )?.id ?? null,
        }));

  const runtimeOnlyRoles: LegacyRuntimeOnlyRole[] = input.roles
    .filter((role) => !manifestRoleIds.has(role.key))
    .map((role) => ({
      provenance: "runtime_role_outside_office_manifest" as const,
      key: role.key,
      ...runtimeRole(role),
    }))
    .sort((left, right) => compareCodeUnits(left.key, right.key));
  const runtimeOnlyAgents: LegacyRuntimeOnlyAgent[] = agents
    .filter((agent) => !manifestRoleIds.has(agent.roleKey))
    .map((agent) => ({
      provenance: "runtime_agent_outside_office_manifest" as const,
      name: agent.name,
      roleKey: agent.roleKey,
      enabled: agent.enabled,
    }));

  const usedRoleKeys = new Set(agents.map((agent) => agent.roleKey));
  const diagnostics: LegacyProfileDiagnostic[] = [
    ...roles
      .filter((role) => role.runtime === null)
      .map((role) => ({
        code: "manifest_role_without_runtime_role" as const,
        subject: role.id,
      })),
    ...runtimeOnlyRoles.map((role) => ({
      code: "runtime_role_outside_manifest" as const,
      subject: role.key,
    })),
    ...[...rolesByKey.keys()]
      .filter((key) => !usedRoleKeys.has(key))
      .sort(compareCodeUnits)
      .map((key) => ({
        code: "runtime_role_without_agent" as const,
        subject: key,
      })),
    ...taskKinds
      .filter((route) => route.pipelineId === null)
      .map((route) => ({
        code: "task_kind_unrouted" as const,
        subject: route.kind,
      })),
    ...pipelines.flatMap((pipeline) =>
      pipeline.stages
        .filter((value) => value.eligibleAgents.length === 0)
        .map((value) => ({
          code: "stage_without_eligible_agent" as const,
          subject: `${pipeline.id}/${value.id}`,
        })),
    ),
  ];

  const vocabularyGaps: LegacyVocabularyGap[] = [
    ...pipelines
      .filter((pipeline) => pipeline.defaultFor.length > 1)
      .map((pipeline) => ({
        code: "pipeline_routes_several_task_kinds" as const,
        subject: pipeline.id,
        fields: ["defaultFor"],
      })),
    ...pipelines
      .filter((pipeline) => pipeline.enforcement !== undefined)
      .map((pipeline) => ({
        code: "pipeline_fields_not_expressible" as const,
        subject: pipeline.id,
        fields: ["enforcement"],
      })),
    ...pipelines.map((pipeline) => ({
      code: "stage_fields_not_expressible" as const,
      subject: pipeline.id,
      fields: [
        ...new Set(
          pipeline.stages.flatMap((value) =>
            Object.keys(value).filter(
              (field) => !expressibleStageFields.has(field),
            ),
          ),
        ),
      ].sort(compareCodeUnits),
    })),
    ...roles
      .filter((role) => role.responsibilities.length > 0)
      .map((role) => ({
        code: "role_fields_not_expressible" as const,
        subject: role.id,
        fields: ["responsibilities"],
      })),
    ...[...rolesByKey.values()]
      .sort((left, right) => compareCodeUnits(left.key, right.key))
      .map((role) => ({
        code: "runtime_role_fields_not_expressible" as const,
        subject: role.key,
        fields: [
          ...(runtimeRole(role).guidance === null ? [] : ["guidance"]),
          "limits",
          "modelPolicy",
          "tools",
          "version",
        ],
      })),
  ];

  const material = {
    profileId: legacyDevelopmentProfileId,
    profileVersion: legacyDevelopmentProfileVersion,
    source: "legacy_state" as const,
    office: manifest === null ? null : { name: manifest.office.name },
    roles,
    agents: agents
      .filter((agent) => manifestRoleIds.has(agent.roleKey))
      .map((agent) => ({
        name: agent.name,
        roleId: agent.roleKey,
        enabled: agent.enabled,
      })),
    taskKinds,
    pipelines,
    runtimeOnly: { roles: runtimeOnlyRoles, agents: runtimeOnlyAgents },
  };
  let profileDigest: string;
  try {
    profileDigest = sha256(
      "ai-office-legacy-development-profile-v1",
      canonicalizeJcsJson(
        material as unknown as Parameters<typeof canonicalizeJcsJson>[0],
      ),
    );
  } catch {
    throw new LegacyDevelopmentProfileError(
      "profile_not_canonical",
      "Legacy development profile digest could not be computed",
    );
  }

  return {
    profileId: material.profileId,
    profileVersion: material.profileVersion,
    source: material.source,
    executable: false,
    statement: legacyDevelopmentProfileStatement,
    profileDigest,
    metadata: {
      officeManifestRevision: input.office?.revision ?? null,
      packBinding: { present: input.packBindingPresent },
    },
    office: material.office,
    roles: material.roles,
    agents: material.agents,
    taskKinds: material.taskKinds,
    pipelines: material.pipelines,
    runtimeOnly: material.runtimeOnly,
    diagnostics,
    vocabularyGaps,
  };
}

/** The exact bytes a caller compares or stores: RFC 8785 of the whole view. */
export function canonicalLegacyDevelopmentProfile(
  profile: LegacyDevelopmentProfile,
): string {
  return canonicalizeJcsJson(
    profile as unknown as Parameters<typeof canonicalizeJcsJson>[0],
  );
}

import type { AgentOperation } from "../project/project-profile.ts";

/** The shipped office manifest's default task kinds, not an exhaustive set. */
export const officeTaskKinds = [
  "feature",
  "bugfix",
  "maintenance",
  "research",
  "release",
] as const;

/**
 * Open by design (M16.5): a project's own office manifest names the task
 * kinds its pipelines route, so the generic core does not enumerate or
 * branch on any domain's vocabulary. `officeTaskKinds` above remains only
 * the default set the shipped manifest and the legacy development profile
 * use; it is not a membership check for this type.
 */
export type OfficeTaskKind = string;

/** Shape of every manifest identifier, including task kinds. */
export const officeIdentifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const officeIdentifierMaxLength = 64;

export interface OfficeManifestProvenance {
  host: string;
  skill: "ai-office";
  skillVersion: string;
}

export interface OfficeProjectModel {
  mission: string;
  goals: readonly string[];
  constraints: readonly string[];
  preferences: readonly string[];
  permissionPreferences: readonly AgentOperation[];
}

export interface VirtualOfficeRole {
  id: string;
  title: string;
  purpose: string;
  responsibilities: readonly string[];
}

export interface VirtualOfficeModel {
  name: string;
  roles: readonly VirtualOfficeRole[];
}

export interface OfficePipelineStage {
  id: string;
  name: string;
  roleId: string;
  objective: string;
  checks: readonly string[];
  requiresApproval: boolean;
  requiresIndependentApproval?: boolean | undefined;
  capabilities?: readonly string[] | undefined;
  requiresDifferentAgentFrom?: readonly string[] | undefined;
}

export interface OfficePipeline {
  id: string;
  name: string;
  description: string;
  defaultFor: readonly OfficeTaskKind[];
  enforcement?: "guidance" | "enforced" | undefined;
  stages: readonly OfficePipelineStage[];
}

export interface OfficeManifest {
  schemaVersion: 1;
  provenance: OfficeManifestProvenance;
  project: OfficeProjectModel;
  office: VirtualOfficeModel;
  pipelines: readonly OfficePipeline[];
}

export interface OfficeManifestRevision {
  id: string;
  projectId: string;
  revision: number;
  manifest: OfficeManifest;
  appliedAt: Date;
}

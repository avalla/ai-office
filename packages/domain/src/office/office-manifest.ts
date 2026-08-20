import type { AgentOperation } from "../project/project-profile.ts";

export const officeTaskKinds = [
  "feature",
  "bugfix",
  "maintenance",
  "research",
  "release",
] as const;

export type OfficeTaskKind = (typeof officeTaskKinds)[number];

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
}

export interface OfficePipeline {
  id: string;
  name: string;
  description: string;
  defaultFor: readonly OfficeTaskKind[];
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

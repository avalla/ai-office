import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";

export const projectBindingFile = ".ai-office/project.json";

export interface LegacyProjectBinding {
  schemaVersion: 1;
  managedBy: "ai-office";
  projectId: string;
}

export interface ProjectBinding {
  schemaVersion: 2;
  managedBy: "ai-office";
  repositoryId: string;
}

export type ParsedProjectBinding = LegacyProjectBinding | ProjectBinding;

export type ProjectBindingStatus = "missing" | "valid" | "invalid";

export interface ProjectBindingInspection {
  status: ProjectBindingStatus;
  searchedFrom: string;
  rootPath: string;
  bindingPath: string;
  binding?: ParsedProjectBinding;
  sha256?: string;
  issue?: string;
}

export interface ProjectBindingWritePlan {
  contractVersion: 1;
  action: "create" | "update" | "none";
  rootPath: string;
  relativePath: typeof projectBindingFile;
  expectedSha256: string | null;
  binding: ProjectBinding;
  planHash: string;
}

export interface ProjectBindingRemovePlan {
  contractVersion: 1;
  action: "delete" | "none";
  rootPath: string;
  relativePath: typeof projectBindingFile;
  expectedSha256: string | null;
  planHash: string;
}

export class ProjectBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectBindingError";
  }
}

function bindingRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProjectBindingError("Project binding must be a JSON object");
  return value as Record<string, unknown>;
}

function validIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 256
  )
    throw new ProjectBindingError(
      `Project binding ${field} must be non-empty text`,
    );
  return value;
}

export function parseProjectBinding(value: unknown): ParsedProjectBinding {
  const record = bindingRecord(value);
  const keys = Object.keys(record).sort();
  if (record.managedBy !== "ai-office")
    throw new ProjectBindingError("Project binding is not owned by AI Office");

  if (record.schemaVersion === 1) {
    if (
      keys.join("\0") !==
      ["managedBy", "projectId", "schemaVersion"].join("\0")
    )
      throw new ProjectBindingError(
        "Legacy project binding must contain exactly managedBy, projectId, and schemaVersion",
      );
    return Object.freeze({
      schemaVersion: 1,
      managedBy: "ai-office",
      projectId: validIdentity(record.projectId, "projectId"),
    });
  }

  if (record.schemaVersion !== 2)
    throw new ProjectBindingError(
      "Project binding schema version is not supported",
    );
  if (
    keys.join("\0") !==
    ["managedBy", "repositoryId", "schemaVersion"].join("\0")
  )
    throw new ProjectBindingError(
      "Project binding must contain exactly managedBy, repositoryId, and schemaVersion",
    );
  return Object.freeze({
    schemaVersion: 2,
    managedBy: "ai-office",
    repositoryId: validIdentity(record.repositoryId, "repositoryId"),
  });
}

export function serializeProjectBinding(binding: ProjectBinding): string {
  return `${JSON.stringify(binding, null, 2)}\n`;
}

export function projectBindingPlanHash(value: Readonly<object>): string {
  return createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

export function repositoryIdFromLegacyProjectId(projectId: string): string {
  return `repo_${createHash("sha256")
    .update(`ai-office-repository-binding-v2\0${projectId}`, "utf8")
    .digest("hex")}`;
}

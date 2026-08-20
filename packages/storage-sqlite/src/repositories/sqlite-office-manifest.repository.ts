import type { Database } from "bun:sqlite";
import type { OfficeManifestRevision } from "@ai-office/domain/office/office-manifest.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import type { OfficeManifestRepository } from "@ai-office/application/ports/office-manifest-repository.port.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";

interface OfficeManifestRevisionRow {
  id: string;
  project_id: string;
  revision: number;
  manifest_json: string;
  applied_at: string;
}

function restore(row: OfficeManifestRevisionRow): OfficeManifestRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    manifest: parseOfficeManifestJson(row.manifest_json),
    appliedAt: new Date(row.applied_at),
  };
}

export class SqliteOfficeManifestRepository implements OfficeManifestRepository {
  constructor(private readonly database: Database) {}

  async findLatest(projectId: string): Promise<OfficeManifestRevision | null> {
    const row = this.database
      .query<OfficeManifestRevisionRow, [string]>(
        `SELECT id, project_id, revision, manifest_json, applied_at
         FROM office_manifest_revision
         WHERE project_id = ?
         ORDER BY revision DESC
         LIMIT 1`,
      )
      .get(projectId);
    return row === null ? null : restore(row);
  }

  async save(revision: OfficeManifestRevision): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO office_manifest_revision(
           id, project_id, revision, schema_version, manifest_json,
           source_host, source_skill, source_skill_version, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.id,
        revision.projectId,
        revision.revision,
        revision.manifest.schemaVersion,
        canonicalStringify(revision.manifest),
        revision.manifest.provenance.host,
        revision.manifest.provenance.skill,
        revision.manifest.provenance.skillVersion,
        revision.appliedAt.toISOString(),
      );
  }
}

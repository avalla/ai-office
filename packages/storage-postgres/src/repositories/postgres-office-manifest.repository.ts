import type { OfficeManifestRepository } from "@ai-office/application/ports/office-manifest-repository.port.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";
import type { OfficeManifestRevision } from "@ai-office/domain/office/office-manifest.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { PostgresClient } from "../database/postgres-client.ts";

interface ManifestRow {
  id: string;
  project_id: string;
  revision: number | string;
  manifest_json: unknown;
  applied_at: Date | string;
}

function restore(row: ManifestRow): OfficeManifestRevision {
  const manifestJson =
    typeof row.manifest_json === "string"
      ? row.manifest_json
      : JSON.stringify(row.manifest_json);
  return {
    id: row.id,
    projectId: row.project_id,
    revision: Number(row.revision),
    manifest: parseOfficeManifestJson(manifestJson),
    appliedAt:
      row.applied_at instanceof Date
        ? new Date(row.applied_at)
        : new Date(row.applied_at),
  };
}

export class PostgresOfficeManifestRepository implements OfficeManifestRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async findLatest(projectId: string): Promise<OfficeManifestRevision | null> {
    const [row] = await this.database.query<ManifestRow>(
      `
        SELECT manifest.id, manifest.project_id, manifest.revision,
               manifest.manifest_json, manifest.applied_at
        FROM core.office_manifest_revision AS manifest
        JOIN core.project AS project
          ON project.id = manifest.project_id AND project.tenant_id = $1
        WHERE manifest.project_id = $2
        ORDER BY manifest.revision DESC, manifest.id DESC
        LIMIT 1
      `,
      [this.tenantId, projectId],
    );
    return row === undefined ? null : restore(row);
  }

  async save(revision: OfficeManifestRevision): Promise<void> {
    const value = revision.manifest;
    const rows = await this.database.query<{ id: string }>(
      `
        INSERT INTO core.office_manifest_revision(
          id, project_id, revision, schema_version, manifest_json,
          source_host, source_skill, source_skill_version, applied_at
        )
        SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9
        FROM core.project AS project
        WHERE project.id = $2 AND project.tenant_id = $10
        RETURNING id
      `,
      [
        revision.id,
        revision.projectId,
        revision.revision,
        value.schemaVersion,
        JSON.parse(canonicalStringify(value)) as Record<string, unknown>,
        value.provenance.host,
        value.provenance.skill,
        value.provenance.skillVersion,
        revision.appliedAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1)
      throw new PostgresTenantScopeError("OfficeManifestRevision", revision.id);
  }
}

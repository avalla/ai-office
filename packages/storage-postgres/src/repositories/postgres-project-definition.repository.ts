import {
  StaleProjectDefinitionError,
  compareExactSources,
  compareOwnedDefinitions,
  type ProjectDefinitionState,
  type ProjectOwnedDefinition,
  type ProjectDefinitionOverride,
} from "@ai-office/application/domain-pack/project-definition.ts";
import type { ProjectDefinitionRepository } from "@ai-office/application/ports/project-definition-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";
import { requirePostgresTenantId } from "../database/postgres-tenant-context.ts";

interface HeadRow extends Record<string, unknown> {
  revision: number;
}
interface OwnedRow extends Record<string, unknown> {
  kind: ProjectOwnedDefinition["kind"];
  local_id: string;
  revision: number;
  enabled: boolean;
  payload_json: ProjectOwnedDefinition["payload"];
  actor_id: string;
  changed_at: Date | string;
}
interface OverrideRow extends Record<string, unknown> {
  pack_id: ProjectDefinitionOverride["source"]["id"];
  pack_version: ProjectDefinitionOverride["source"]["version"];
  manifest_digest: ProjectDefinitionOverride["source"]["manifestDigest"];
  kind: ProjectDefinitionOverride["source"]["kind"];
  local_id: string;
  operation: ProjectDefinitionOverride["operation"];
  revision: number;
  payload_json: ProjectDefinitionOverride["payload"] | null;
  actor_id: string;
  changed_at: Date | string;
}
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const payload = (
  value: ProjectOwnedDefinition["payload"] | string,
): ProjectOwnedDefinition["payload"] =>
  typeof value === "string"
    ? (JSON.parse(value) as ProjectOwnedDefinition["payload"])
    : value;

export class PostgresProjectDefinitionRepository implements ProjectDefinitionRepository {
  private readonly tenantId: string;
  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async get(projectId: string): Promise<ProjectDefinitionState> {
    const [head] = await this.database.query<HeadRow>(
      "SELECT revision FROM core.project_definition_head WHERE project_id = $1 AND tenant_id = $2",
      [projectId, this.tenantId],
    );
    const ownedRows = await this.database.query<OwnedRow>(
      `SELECT kind, local_id, revision, enabled, payload_json, actor_id, changed_at FROM core.project_owned_definition WHERE project_id = $1 AND tenant_id = $2 ORDER BY kind COLLATE "C", local_id COLLATE "C"`,
      [projectId, this.tenantId],
    );
    const overrideRows = await this.database.query<OverrideRow>(
      `SELECT pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at FROM core.project_definition_override WHERE project_id = $1 AND tenant_id = $2 ORDER BY pack_id COLLATE "C", pack_version COLLATE "C", manifest_digest COLLATE "C", kind COLLATE "C", local_id COLLATE "C"`,
      [projectId, this.tenantId],
    );
    return {
      projectId,
      revision: head?.revision ?? 0,
      owned: ownedRows.map((row) => ({
        origin: "project_owned",
        kind: row.kind,
        id: row.local_id,
        revision: row.revision,
        enabled: row.enabled,
        payload: payload(row.payload_json),
        actorId: row.actor_id,
        changedAt: iso(row.changed_at),
      })),
      overrides: overrideRows.map((row) => ({
        origin: "project_override",
        source: {
          id: row.pack_id,
          version: row.pack_version,
          manifestDigest: row.manifest_digest,
          kind: row.kind,
          localId: row.local_id,
        },
        operation: row.operation,
        revision: row.revision,
        ...(row.payload_json === null || row.payload_json === undefined
          ? {}
          : { payload: payload(row.payload_json) }),
        actorId: row.actor_id,
        changedAt: iso(row.changed_at),
      })),
    };
  }

  async replace(
    state: ProjectDefinitionState,
    expectedRevision: number,
    changedAt: Date,
  ): Promise<ProjectDefinitionState> {
    return this.database.runInTransaction(async () => {
      await this.database.query(
        `INSERT INTO core.project_definition_head(project_id, tenant_id) SELECT id, tenant_id FROM core.project WHERE id = $1 AND tenant_id = $2 ON CONFLICT(project_id) DO NOTHING`,
        [state.projectId, this.tenantId],
      );
      const [head] = await this.database.query<HeadRow>(
        "SELECT revision FROM core.project_definition_head WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [state.projectId, this.tenantId],
      );
      if (!head || head.revision !== expectedRevision)
        throw new StaleProjectDefinitionError(
          state.projectId,
          head?.revision ?? 0,
        );
      await this.database.query(
        `UPDATE core.project_definition_head SET revision = revision + 1, changed_at = $3 WHERE project_id = $1 AND tenant_id = $2`,
        [state.projectId, this.tenantId, changedAt],
      );
      await this.database.query(
        "DELETE FROM core.project_owned_definition WHERE project_id = $1 AND tenant_id = $2",
        [state.projectId, this.tenantId],
      );
      await this.database.query(
        "DELETE FROM core.project_definition_override WHERE project_id = $1 AND tenant_id = $2",
        [state.projectId, this.tenantId],
      );
      for (const item of state.owned)
        await this.database.query(
          `INSERT INTO core.project_owned_definition(project_id, tenant_id, kind, local_id, revision, enabled, payload_json, actor_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
          [
            state.projectId,
            this.tenantId,
            item.kind,
            item.id,
            item.revision,
            item.enabled,
            JSON.stringify(item.payload),
            item.actorId,
            item.changedAt,
          ],
        );
      for (const item of state.overrides)
        await this.database.query(
          `INSERT INTO core.project_definition_override(project_id, tenant_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
          [
            state.projectId,
            this.tenantId,
            item.source.id,
            item.source.version,
            item.source.manifestDigest,
            item.source.kind,
            item.source.localId,
            item.operation,
            item.revision,
            item.payload === undefined ? null : JSON.stringify(item.payload),
            item.actorId,
            item.changedAt,
          ],
        );
      return {
        ...state,
        revision: expectedRevision + 1,
        owned: [...state.owned].sort(compareOwnedDefinitions),
        overrides: [...state.overrides].sort((left, right) =>
          compareExactSources(left.source, right.source),
        ),
      };
    });
  }
}

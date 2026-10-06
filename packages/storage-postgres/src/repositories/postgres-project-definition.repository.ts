import {
  ProjectDefinitionPayloadShapeError,
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
  payload_json: unknown;
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
  payload_json: unknown;
  actor_id: string;
  changed_at: Date | string;
}
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * A definition payload is a jsonb object in both tables (migration
 * 20261006000300). Anything else is corrupt or pre-migration state: the
 * repository refuses to return it typed as a payload, or to write it. The
 * error names the row by key and never carries or quotes the value.
 */
function objectPayload<Payload extends object>(
  value: unknown,
  key: string,
): Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProjectDefinitionPayloadShapeError(key);
  return value as Payload;
}
const ownedKey = (projectId: string, kind: string, localId: string): string =>
  `core.project_owned_definition (project_id=${projectId}, kind=${kind}, local_id=${localId})`;
const overrideKey = (
  projectId: string,
  source: {
    id: string;
    version: string;
    manifestDigest: string;
    kind: string;
    localId: string;
  },
): string =>
  `core.project_definition_override (project_id=${projectId}, pack=${source.id}@${source.version}, manifest_digest=${source.manifestDigest}, kind=${source.kind}, local_id=${source.localId})`;

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
        payload: objectPayload<ProjectOwnedDefinition["payload"]>(
          row.payload_json,
          ownedKey(projectId, row.kind, row.local_id),
        ),
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
          : {
              payload: objectPayload<
                NonNullable<ProjectDefinitionOverride["payload"]>
              >(
                row.payload_json,
                overrideKey(projectId, {
                  id: row.pack_id,
                  version: row.pack_version,
                  manifestDigest: row.manifest_digest,
                  kind: row.kind,
                  localId: row.local_id,
                }),
              ),
            }),
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
    // Checked before anything is written: a state carrying a payload that is
    // not a JavaScript object (a string, as an unguarded read of an unmigrated
    // database returned it, an array or null) is refused whole. What the
    // driver then serializes is not inspected here; the table checks of
    // migration 20261006000300 are what hold the stored shape.
    for (const item of state.owned)
      objectPayload(
        item.payload,
        ownedKey(state.projectId, item.kind, item.id),
      );
    for (const item of state.overrides)
      if (item.payload !== undefined)
        objectPayload(item.payload, overrideKey(state.projectId, item.source));
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
            // An object, never JSON text: the driver serializes a jsonb
            // parameter itself, and a string would be stored as a JSON string.
            item.payload,
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
            item.payload ?? null,
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

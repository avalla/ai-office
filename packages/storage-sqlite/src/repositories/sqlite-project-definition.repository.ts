import type { Database } from "bun:sqlite";
import {
  StaleProjectDefinitionError,
  type ProjectDefinitionState,
  type ProjectOwnedDefinition,
  type ProjectDefinitionOverride,
} from "@ai-office/application/domain-pack/project-definition.ts";
import type { ProjectDefinitionRepository } from "@ai-office/application/ports/project-definition-repository.port.ts";

interface HeadRow {
  revision: number;
}
interface OwnedRow {
  kind: ProjectOwnedDefinition["kind"];
  local_id: string;
  revision: number;
  enabled: number;
  payload_json: string;
  actor_id: string;
  changed_at: string;
}
interface OverrideRow {
  pack_id: ProjectDefinitionOverride["source"]["id"];
  pack_version: ProjectDefinitionOverride["source"]["version"];
  manifest_digest: ProjectDefinitionOverride["source"]["manifestDigest"];
  kind: ProjectDefinitionOverride["source"]["kind"];
  local_id: string;
  operation: ProjectDefinitionOverride["operation"];
  revision: number;
  payload_json: string | null;
  actor_id: string;
  changed_at: string;
}

export class SqliteProjectDefinitionRepository implements ProjectDefinitionRepository {
  constructor(private readonly database: Database) {}

  async get(projectId: string): Promise<ProjectDefinitionState> {
    const head = this.database
      .query<HeadRow, [string]>(
        "SELECT revision FROM project_definition_head WHERE project_id = ?",
      )
      .get(projectId);
    const owned = this.database
      .query<OwnedRow, [string]>(
        `SELECT kind, local_id, revision, enabled, payload_json, actor_id, changed_at
      FROM project_owned_definition WHERE project_id = ? ORDER BY kind, local_id`,
      )
      .all(projectId)
      .map((row): ProjectOwnedDefinition => ({
        origin: "project_owned",
        kind: row.kind,
        id: row.local_id,
        revision: row.revision,
        enabled: row.enabled === 1,
        payload: JSON.parse(
          row.payload_json,
        ) as ProjectOwnedDefinition["payload"],
        actorId: row.actor_id,
        changedAt: row.changed_at,
      }));
    const overrides = this.database
      .query<OverrideRow, [string]>(
        `SELECT pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at
      FROM project_definition_override WHERE project_id = ? ORDER BY pack_id, pack_version, manifest_digest, kind, local_id`,
      )
      .all(projectId)
      .map((row): ProjectDefinitionOverride => ({
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
        ...(row.payload_json === null
          ? {}
          : {
              payload: JSON.parse(row.payload_json) as NonNullable<
                ProjectDefinitionOverride["payload"]
              >,
            }),
        actorId: row.actor_id,
        changedAt: row.changed_at,
      }));
    return { projectId, revision: head?.revision ?? 0, owned, overrides };
  }

  async replace(
    state: ProjectDefinitionState,
    expectedRevision: number,
    changedAt: Date,
  ): Promise<ProjectDefinitionState> {
    this.database.exec("SAVEPOINT project_definition_replace");
    try {
      this.database
        .query(
          `INSERT OR IGNORE INTO project_definition_head(project_id) SELECT id FROM project WHERE id = ?`,
        )
        .run(state.projectId);
      const current = await this.get(state.projectId);
      if (current.revision !== expectedRevision)
        throw new StaleProjectDefinitionError(
          state.projectId,
          current.revision,
        );
      const result = this.database
        .query(
          `UPDATE project_definition_head SET revision = revision + 1, changed_at = ?
        WHERE project_id = ? AND revision = ?`,
        )
        .run(changedAt.toISOString(), state.projectId, expectedRevision);
      if (result.changes !== 1)
        throw new StaleProjectDefinitionError(
          state.projectId,
          current.revision,
        );
      this.database
        .query("DELETE FROM project_owned_definition WHERE project_id = ?")
        .run(state.projectId);
      this.database
        .query("DELETE FROM project_definition_override WHERE project_id = ?")
        .run(state.projectId);
      const insertOwned = this.database.query(
        `INSERT INTO project_owned_definition(project_id, kind, local_id, revision, enabled, payload_json, actor_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of state.owned)
        insertOwned.run(
          state.projectId,
          item.kind,
          item.id,
          item.revision,
          item.enabled ? 1 : 0,
          JSON.stringify(item.payload),
          item.actorId,
          item.changedAt,
        );
      const insertOverride = this.database.query(
        `INSERT INTO project_definition_override(project_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of state.overrides)
        insertOverride.run(
          state.projectId,
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
        );
      this.database.exec("RELEASE SAVEPOINT project_definition_replace");
      return { ...state, revision: expectedRevision + 1 };
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT project_definition_replace");
      this.database.exec("RELEASE SAVEPOINT project_definition_replace");
      throw error;
    }
  }
}

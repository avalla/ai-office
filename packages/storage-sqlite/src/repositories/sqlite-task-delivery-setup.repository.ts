import type { Database } from "bun:sqlite";
import type {
  TaskDeliverySetupEntry,
  TaskDeliverySetupRepository,
  TaskDeliverySetupScope,
} from "@ai-office/application/ports/task-delivery-setup-repository.port.ts";

interface SetupRow {
  project_id: string;
  scope: TaskDeliverySetupScope;
  scope_ref: string | null;
  key: string;
  value_json: string;
}

function restoreEntry(row: SetupRow): TaskDeliverySetupEntry {
  return {
    projectId: row.project_id,
    scope: row.scope,
    scopeRef: row.scope_ref,
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
  };
}

export class SqliteTaskDeliverySetupRepository
  implements TaskDeliverySetupRepository
{
  constructor(private readonly database: Database) {}

  async get(
    projectId: string,
    scope: TaskDeliverySetupScope,
    scopeRef: string | null,
  ): Promise<TaskDeliverySetupEntry[]> {
    return this.database
      .query<SetupRow, [string, TaskDeliverySetupScope, string | null]>(
        `SELECT project_id, scope, scope_ref, key, value_json
         FROM task_delivery_setup
         WHERE project_id = ? AND scope = ? AND scope_ref IS ?
         ORDER BY key`,
      )
      .all(projectId, scope, scopeRef)
      .map(restoreEntry);
  }

  async put(
    entry: TaskDeliverySetupEntry,
    actor: string,
    now: Date,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO task_delivery_setup(
           project_id, scope, scope_ref, key, value_json, updated_at, actor
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, scope, IFNULL(scope_ref, ''), key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at,
           actor = excluded.actor`,
      )
      .run(
        entry.projectId,
        entry.scope,
        entry.scopeRef,
        entry.key,
        JSON.stringify(entry.value),
        now.toISOString(),
        actor,
      );
  }

  async remove(
    projectId: string,
    scope: TaskDeliverySetupScope,
    scopeRef: string | null,
    key: string,
  ): Promise<boolean> {
    const removed = this.database
      .prepare(
        `DELETE FROM task_delivery_setup
         WHERE project_id = ? AND scope = ? AND scope_ref IS ? AND key = ?`,
      )
      .run(projectId, scope, scopeRef, key).changes;
    return removed > 0;
  }
}

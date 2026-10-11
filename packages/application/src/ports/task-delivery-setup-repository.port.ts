/**
 * Port for the Runtime-backed task-delivery setup store (M19-T4): key-value
 * JSON rows scoped to a project, with run and task overrides. The key
 * vocabulary lives in the application schema, not in SQL, so the table stays
 * forward-compatible; delete is `remove`, the command layer maps a JSON null
 * write to it.
 */

export type TaskDeliverySetupScope = "project" | "run" | "task";

export interface TaskDeliverySetupEntry {
  readonly projectId: string;
  readonly scope: TaskDeliverySetupScope;
  /** Run or task identifier; null exactly when scope is "project". */
  readonly scopeRef: string | null;
  readonly key: string;
  readonly value: unknown;
}

export interface TaskDeliverySetupRepository {
  /** All entries of one scope, ordered by key for a deterministic read. */
  get(
    projectId: string,
    scope: TaskDeliverySetupScope,
    scopeRef: string | null,
  ): Promise<TaskDeliverySetupEntry[]>;
  /** Insert or replace one entry; the store owns updated_at and actor. */
  put(
    entry: TaskDeliverySetupEntry,
    actor: string,
    now: Date,
  ): Promise<void>;
  /** Delete one entry; true when a row was removed. */
  remove(
    projectId: string,
    scope: TaskDeliverySetupScope,
    scopeRef: string | null,
    key: string,
  ): Promise<boolean>;
}

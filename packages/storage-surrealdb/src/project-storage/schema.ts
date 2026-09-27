import type { Surreal } from "surrealdb";

/** Independent schema version for the ProjectStorage subset experiment. */
export const PROJECT_STORAGE_SUBSET_SCHEMA_VERSION = 1;

export async function initializeProjectStorageSubsetSchema(
  db: Surreal,
): Promise<void> {
  const statements = [
    "DEFINE TABLE IF NOT EXISTS office_project SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON office_project TYPE string;",
    "DEFINE FIELD IF NOT EXISTS external_id ON office_project TYPE string;",
    "DEFINE FIELD IF NOT EXISTS name ON office_project TYPE string;",
    "DEFINE FIELD IF NOT EXISTS description ON office_project TYPE option<string>;",
    "DEFINE FIELD IF NOT EXISTS created_at ON office_project TYPE datetime;",
    "DEFINE FIELD IF NOT EXISTS updated_at ON office_project TYPE datetime;",
    "DEFINE INDEX IF NOT EXISTS office_project_external_id ON office_project FIELDS external_id UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS office_task SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON office_task TYPE string;",
    "DEFINE FIELD IF NOT EXISTS project_id ON office_task TYPE string;",
    "DEFINE FIELD IF NOT EXISTS external_id ON office_task TYPE string;",
    "DEFINE FIELD IF NOT EXISTS title ON office_task TYPE string;",
    "DEFINE FIELD IF NOT EXISTS description ON office_task TYPE option<string>;",
    "DEFINE FIELD IF NOT EXISTS status ON office_task TYPE string;",
    "DEFINE FIELD IF NOT EXISTS priority ON office_task TYPE int;",
    "DEFINE FIELD IF NOT EXISTS created_at ON office_task TYPE datetime;",
    "DEFINE FIELD IF NOT EXISTS updated_at ON office_task TYPE datetime;",
    "DEFINE INDEX IF NOT EXISTS office_task_external_id ON office_task FIELDS external_id UNIQUE;",
    "DEFINE INDEX IF NOT EXISTS office_task_project_external_id ON office_task FIELDS tenant_id, project_id, external_id UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS office_project_task TYPE RELATION IN office_project OUT office_task ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON office_project_task TYPE string;",
    "DEFINE FIELD IF NOT EXISTS project_id ON office_project_task TYPE string;",
    "DEFINE INDEX IF NOT EXISTS office_project_task_owned_task ON office_project_task FIELDS out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS office_requirement SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON office_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS project_id ON office_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS external_id ON office_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS requirement_key ON office_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS title ON office_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS status ON office_requirement TYPE string;",
    "DEFINE INDEX IF NOT EXISTS office_requirement_external_id ON office_requirement FIELDS external_id UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS office_task_requirement TYPE RELATION IN office_task OUT office_requirement ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON office_task_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS project_id ON office_task_requirement TYPE string;",
    "DEFINE FIELD IF NOT EXISTS created_at ON office_task_requirement TYPE datetime;",
    "DEFINE INDEX IF NOT EXISTS office_task_requirement_pair ON office_task_requirement FIELDS in, out UNIQUE;",
  ];

  for (const statement of statements) await db.query(statement);
}

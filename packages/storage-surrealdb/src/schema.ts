import type { Surreal } from "surrealdb";

/** Versioned, repeatable schema for the experimental knowledge graph. */
export const AGENT_KNOWLEDGE_SCHEMA_VERSION = 3;
export async function initializeAgentKnowledgeSchema(
  db: Surreal,
): Promise<void> {
  const statements = [
    "DEFINE TABLE IF NOT EXISTS knowledge_agent SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_agent TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_agent TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_agent TYPE string;",
    "DEFINE TABLE IF NOT EXISTS knowledge_run SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_run TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_run TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_run TYPE string; DEFINE FIELD IF NOT EXISTS agent_id ON knowledge_run TYPE string; DEFINE FIELD IF NOT EXISTS task_id ON knowledge_run TYPE string;",
    "DEFINE TABLE IF NOT EXISTS knowledge_task SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_task TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_task TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_task TYPE string;",
    "DEFINE TABLE IF NOT EXISTS knowledge_source SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS kind ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS label ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS locator ON knowledge_source TYPE option<string>; DEFINE FIELD IF NOT EXISTS run_id ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS task_id ON knowledge_source TYPE string; DEFINE FIELD IF NOT EXISTS agent_id ON knowledge_source TYPE string;",
    "DEFINE TABLE IF NOT EXISTS knowledge_memory SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS text ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS agent_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS run_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS task_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_id ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_kind ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_label ON knowledge_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_locator ON knowledge_memory TYPE option<string>; DEFINE FIELD IF NOT EXISTS created_at ON knowledge_memory TYPE datetime;",
    "DEFINE INDEX IF NOT EXISTS memory_scope_external ON knowledge_memory FIELDS tenant_id, project_id, external_id UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS knowledge_legacy_memory SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS text ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_scope ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_key ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS source_sha256 ON knowledge_legacy_memory TYPE string; DEFINE FIELD IF NOT EXISTS imported_at ON knowledge_legacy_memory TYPE datetime;",
    "DEFINE INDEX IF NOT EXISTS legacy_memory_scope_external ON knowledge_legacy_memory FIELDS tenant_id, project_id, external_id UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS knowledge_decision SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS external_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS title ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS text ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS agent_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS run_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS task_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS source_id ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS source_kind ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS source_label ON knowledge_decision TYPE string; DEFINE FIELD IF NOT EXISTS source_locator ON knowledge_decision TYPE option<string>; DEFINE FIELD IF NOT EXISTS created_at ON knowledge_decision TYPE datetime;",
    "DEFINE INDEX IF NOT EXISTS decision_scope_external ON knowledge_decision FIELDS tenant_id, project_id, external_id UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS executed TYPE RELATION IN knowledge_agent OUT knowledge_run ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON executed TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON executed TYPE string; DEFINE INDEX IF NOT EXISTS executed_unique ON executed FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS for_task TYPE RELATION IN knowledge_run OUT knowledge_task ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON for_task TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON for_task TYPE string; DEFINE INDEX IF NOT EXISTS run_task_unique ON for_task FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS derived_from TYPE RELATION IN knowledge_memory OUT knowledge_source ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON derived_from TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON derived_from TYPE string; DEFINE INDEX IF NOT EXISTS memory_source_unique ON derived_from FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS in_context_of TYPE RELATION IN knowledge_source OUT knowledge_run ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON in_context_of TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON in_context_of TYPE string; DEFINE INDEX IF NOT EXISTS source_run_unique ON in_context_of FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS based_on TYPE RELATION IN knowledge_decision OUT knowledge_source ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON based_on TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON based_on TYPE string; DEFINE INDEX IF NOT EXISTS decision_source_unique ON based_on FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS affects TYPE RELATION IN knowledge_decision OUT knowledge_task ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON affects TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON affects TYPE string; DEFINE INDEX IF NOT EXISTS decision_task_unique ON affects FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS supersedes TYPE RELATION IN knowledge_decision OUT knowledge_decision ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON supersedes TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON supersedes TYPE string; DEFINE INDEX IF NOT EXISTS supersedes_unique ON supersedes FIELDS in, out UNIQUE;",
    "DEFINE TABLE IF NOT EXISTS depends_on TYPE RELATION IN knowledge_task OUT knowledge_task ENFORCED SCHEMAFULL;",
    "DEFINE FIELD IF NOT EXISTS tenant_id ON depends_on TYPE string; DEFINE FIELD IF NOT EXISTS project_id ON depends_on TYPE string; DEFINE INDEX IF NOT EXISTS task_dependency_unique ON depends_on FIELDS in, out UNIQUE;",
    // v3 (AK-11): typed non-run provenance. A row without `provenance_kind` is
    // a run record and keeps its run, task, and agent. OVERWRITE relaxes those
    // three fields on existing databases without touching stored rows. SurrealDB
    // skips ASSERT for an absent optional value, so these assertions reject a
    // field that belongs to another provenance kind, and the adapter enforces
    // that each kind's own fields are present on every write and read.
    ...["knowledge_memory", "knowledge_decision"].flatMap((table) => [
      `DEFINE FIELD IF NOT EXISTS provenance_kind ON ${table} TYPE option<string> ASSERT $value = NONE OR $value IN ['handover', 'operator_confirmed'];`,
      ...["agent_id", "run_id", "task_id"].map(
        (field) =>
          `DEFINE FIELD OVERWRITE ${field} ON ${table} TYPE option<string> ASSERT $value = NONE OR $this.provenance_kind = NONE;`,
      ),
      ...[
        ["handover_confirmation_id", "string"],
        ["handover_fingerprint", "string"],
        ["handover_scan_id", "string"],
        ["handover_confirmed_at", "datetime"],
      ].map(
        ([field, type]) =>
          `DEFINE FIELD IF NOT EXISTS ${field} ON ${table} TYPE option<${type}> ASSERT $value = NONE OR $this.provenance_kind = 'handover';`,
      ),
      `DEFINE FIELD IF NOT EXISTS confirmed_by ON ${table} TYPE option<string> ASSERT $value = NONE OR $this.provenance_kind = 'operator_confirmed';`,
      `DEFINE FIELD IF NOT EXISTS evidence ON ${table} TYPE option<array<object>> ASSERT $value = NONE OR ($this.provenance_kind = 'operator_confirmed' AND array::len($value) >= 1 AND array::len($value) <= 8);`,
      `DEFINE FIELD IF NOT EXISTS evidence[*].kind ON ${table} TYPE string ASSERT $value IN ['adr', 'handover', 'requirement', 'review', 'task']; DEFINE FIELD IF NOT EXISTS evidence[*].id ON ${table} TYPE string; DEFINE FIELD IF NOT EXISTS evidence[*].label ON ${table} TYPE string;`,
    ]),
  ];
  for (const statement of statements) await db.query(statement);
}

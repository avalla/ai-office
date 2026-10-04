import { createHash } from "node:crypto";
import {
  KnowledgeStoreError,
  assertKnowledgeIdentifier,
  assertKnowledgeLimit,
  assertKnowledgeScope,
  assertKnowledgeSearchQuery,
  knowledgeRetrievalLimits,
  isKnowledgeIdentifier,
  isNonRunKnowledgeProvenance,
  type AgentKnowledgeStore,
  type DecisionInput,
  type KnowledgeHit,
  type KnowledgeScope,
  type KnowledgeSearchQuery,
  type MemoryInput,
  type NonRunKnowledgeHit,
  type NonRunKnowledgeInput,
  type KnowledgeProvenance,
  type LegacyKnowledgeHit,
  type SearchKnowledgeHit,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { initializeAgentKnowledgeSchema } from "./schema.ts";

type Row = Record<string, unknown>;

function isLegacyMemoryKey(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    value.length <= 256 && !/\p{Cc}/u.test(value);
}

function isLegacyMemoryValue(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    [...value].length <= 4_000 && Buffer.byteLength(value, "utf8") <= 16_384;
}

function sortKnowledge(left: SearchKnowledgeHit, right: SearchKnowledgeHit): number {
  return right.createdAt.getTime() - left.createdAt.getTime()
    || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function scopedId(scope: KnowledgeScope, kind: string, id: string): string {
  return encodeURIComponent(JSON.stringify([scope.tenantId, scope.repositoryId, kind, id]));
}

function assertKnowledge(input: MemoryInput | DecisionInput): void {
  assertKnowledgeScope(input);
  for (const [name, value] of Object.entries({
    id: input.id,
    text: input.text,
    agentId: input.agentId,
    runId: input.runId,
    taskId: input.taskId,
    sourceId: input.source?.id,
    sourceLabel: input.source?.label,
  })) {
    if (!value?.trim()) throw new Error(`AgentKnowledgeStore requires provenance ${name}`);
  }
  if (!(input.createdAt instanceof Date) || Number.isNaN(input.createdAt.getTime())) {
    throw new Error("AgentKnowledgeStore requires a valid createdAt timestamp");
  }
  if (!["requirement", "task", "decision", "run", "external"].includes(input.source.kind)) {
    throw new Error("AgentKnowledgeStore requires a supported source-reference kind");
  }
  if ("title" in input && !input.title.trim()) {
    throw new Error("AgentKnowledgeStore requires a decision title");
  }
}

const nonRunSourceKind = { handover: "handover", operator_confirmed: "operator" } as const;
const nonRunProvenanceFields = ["handover_confirmation_id", "handover_fingerprint", "handover_scan_id", "handover_confirmed_at", "confirmed_by", "evidence"] as const;

function assertNonRunKnowledge(input: NonRunKnowledgeInput): void {
  assertKnowledgeScope(input);
  for (const [name, value] of Object.entries({ id: input.id, text: input.text, sourceId: input.source?.id, sourceLabel: input.source?.label })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`AgentKnowledgeStore requires provenance ${name}`);
  }
  if (!(input.createdAt instanceof Date) || Number.isNaN(input.createdAt.getTime())) {
    throw new Error("AgentKnowledgeStore requires a valid createdAt timestamp");
  }
  if (input.kind !== "memory" && input.kind !== "decision") {
    throw new Error("AgentKnowledgeStore requires a supported knowledge kind");
  }
  if (input.kind === "decision" ? typeof input.title !== "string" || !input.title.trim() : input.title !== undefined) {
    throw new Error("AgentKnowledgeStore requires a title for a decision only");
  }
  if (!isNonRunKnowledgeProvenance(input.provenance) ||
    input.source.kind !== nonRunSourceKind[input.provenance.kind] ||
    input.source.id !== (input.provenance.kind === "handover" ? input.provenance.confirmationId : input.provenance.confirmedBy)) {
    throw new Error("AgentKnowledgeStore requires typed non-run provenance matching its source");
  }
}

function toDate(value: unknown): Date {
  return value instanceof DateTime ? value.toDate()
    : value instanceof Date ? value
      : typeof value === "string" ? new Date(value) : new Date(Number.NaN);
}

function immutableRecordGuard(variable: string, table: string, record: string, fields: Record<string, string>, message: string): string {
  const existing = `$existing_${variable}`;
  return `LET ${existing} = (SELECT * FROM ${table} WHERE id = ${record} LIMIT 1); IF array::len(${existing}) > 0 AND (${Object.entries(fields).map(([field, parameter]) => `${existing}[0].${field} != $${parameter}`).join(" OR ")}) { THROW '${message}'; };`;
}

const sourceIdentityFields = { tenant_id: "tenant_id", project_id: "project_id", external_id: "source_id", kind: "source_kind", label: "source_label", locator: "source_locator", run_id: "run_id", task_id: "task_id", agent_id: "agent_id" };
const runIdentityFields = { tenant_id: "tenant_id", project_id: "project_id", external_id: "run_id", agent_id: "agent_id", task_id: "task_id" };

export class SurrealAgentKnowledgeStoreImpl implements AgentKnowledgeStore {
  private constructor(private readonly db: Surreal) {}

  static async create(db: Surreal): Promise<SurrealAgentKnowledgeStoreImpl> {
    await initializeAgentKnowledgeSchema(db);
    return new SurrealAgentKnowledgeStoreImpl(db);
  }

  async recordMemory(input: MemoryInput): Promise<void> {
    assertKnowledge(input);
    const sourceKey = scopedId(input, "source", input.source.id);
    const agentKey = scopedId(input, "agent", input.agentId);
    const runKey = scopedId(input, "run", input.runId);
    const taskKey = scopedId(input, "task", input.taskId);
    const memoryKey = scopedId(input, "memory", input.id);
    const params = {
      tenant: input.tenantId, project: input.repositoryId,
      source_key: sourceKey, source_id: input.source.id, source_kind: input.source.kind,
      source_label: input.source.label, source_locator: input.source.locator ?? "",
      agent_key: agentKey, agent_id: input.agentId,
      run_key: runKey, run_id: input.runId, task_key: taskKey, task_id: input.taskId,
      memory_key: memoryKey, memory_id: input.id, text: input.text,
      created_at: input.createdAt,
      agent_record: new RecordId("knowledge_agent", agentKey),
      run_record: new RecordId("knowledge_run", runKey),
      task_record: new RecordId("knowledge_task", taskKey),
      source_record: new RecordId("knowledge_source", sourceKey),
      memory_record: new RecordId("knowledge_memory", memoryKey),
      executed_edge: new RecordId("executed", runKey),
      run_task_edge: new RecordId("for_task", runKey),
      memory_source_edge: new RecordId("derived_from", memoryKey),
      source_run_edge: new RecordId("in_context_of", sourceKey),
      tenant_id: input.tenantId, project_id: input.repositoryId,
    };
    const sourceGuard = immutableRecordGuard("source", "knowledge_source", "$source_record", sourceIdentityFields, "Source identity conflict");
    const runGuard = immutableRecordGuard("run", "knowledge_run", "$run_record", runIdentityFields, "Run identity conflict");
    const memoryGuard = immutableRecordGuard("memory", "knowledge_memory", "$memory_record", { tenant_id: "tenant_id", project_id: "project_id", external_id: "memory_id", text: "text", agent_id: "agent_id", run_id: "run_id", task_id: "task_id", source_id: "source_id", source_kind: "source_kind", source_label: "source_label", source_locator: "source_locator", created_at: "created_at" }, "Knowledge identity conflict");
    await this.execute(
      `BEGIN TRANSACTION;
       ${sourceGuard}
       ${runGuard}
       ${memoryGuard}
       UPSERT type::record('knowledge_agent', $agent_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $agent_id };
       UPSERT type::record('knowledge_task', $task_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $task_id };
       UPSERT type::record('knowledge_run', $run_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $run_id, agent_id: $agent_id, task_id: $task_id };
       UPSERT type::record('knowledge_source', $source_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $source_id, kind: $source_kind, label: $source_label, locator: $source_locator, run_id: $run_id, task_id: $task_id, agent_id: $agent_id };
       UPSERT type::record('knowledge_memory', $memory_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $memory_id, text: $text, agent_id: $agent_id, run_id: $run_id, task_id: $task_id, source_id: $source_id, source_kind: $source_kind, source_label: $source_label, source_locator: $source_locator, created_at: $created_at };
       RELATE OR UPDATE $agent_record->$executed_edge->$run_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $run_record->$run_task_edge->$task_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $memory_record->$memory_source_edge->$source_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $source_record->$source_run_edge->$run_record SET tenant_id = $tenant, project_id = $project;
       COMMIT TRANSACTION;`,
      params,
    );
  }

  async traceLegacyMemory(scope: KnowledgeScope, id: string): Promise<LegacyKnowledgeHit | null> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(id);
    const record = new RecordId("knowledge_legacy_memory", scopedId(scope, "legacy_memory", id));
    const rows = await this.rows("SELECT * FROM knowledge_legacy_memory WHERE id = $record LIMIT 2", { record });
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !rows[0]) throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    return this.legacyHit(rows[0], scope, id);
  }

  async recordDecision(input: DecisionInput): Promise<void> {
    assertKnowledge(input);
    const sourceKey = scopedId(input, "source", input.source.id);
    const agentKey = scopedId(input, "agent", input.agentId);
    const runKey = scopedId(input, "run", input.runId);
    const taskKey = scopedId(input, "task", input.taskId);
    const decisionKey = scopedId(input, "decision", input.id);
    await this.execute(
      `BEGIN TRANSACTION;
       ${immutableRecordGuard("source", "knowledge_source", "$source_record", sourceIdentityFields, "Source identity conflict")}
       ${immutableRecordGuard("run", "knowledge_run", "$run_record", runIdentityFields, "Run identity conflict")}
       ${immutableRecordGuard("decision", "knowledge_decision", "$decision_record", { tenant_id: "tenant_id", project_id: "project_id", external_id: "decision_id", title: "title", text: "text", agent_id: "agent_id", run_id: "run_id", task_id: "task_id", source_id: "source_id", source_kind: "source_kind", source_label: "source_label", source_locator: "source_locator", created_at: "created_at" }, "Knowledge identity conflict")}
       UPSERT type::record('knowledge_agent', $agent_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $agent_id };
       UPSERT type::record('knowledge_task', $task_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $task_id };
       UPSERT type::record('knowledge_run', $run_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $run_id, agent_id: $agent_id, task_id: $task_id };
       UPSERT type::record('knowledge_source', $source_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $source_id, kind: $source_kind, label: $source_label, locator: $source_locator, run_id: $run_id, task_id: $task_id, agent_id: $agent_id };
       UPSERT type::record('knowledge_decision', $decision_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $decision_id, title: $title, text: $text, agent_id: $agent_id, run_id: $run_id, task_id: $task_id, source_id: $source_id, source_kind: $source_kind, source_label: $source_label, source_locator: $source_locator, created_at: $created_at };
       RELATE OR UPDATE $agent_record->$executed_edge->$run_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $run_record->$run_task_edge->$task_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $source_record->$source_run_edge->$run_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $decision_record->$decision_source_edge->$source_record SET tenant_id = $tenant, project_id = $project;
       RELATE OR UPDATE $decision_record->$decision_task_edge->$task_record SET tenant_id = $tenant, project_id = $project;
       COMMIT TRANSACTION;`,
      { tenant: input.tenantId, project: input.repositoryId, source_key: sourceKey, source_id: input.source.id, source_kind: input.source.kind, source_label: input.source.label, source_locator: input.source.locator ?? "", agent_key: agentKey, agent_id: input.agentId, run_key: runKey, run_id: input.runId, task_key: taskKey, task_id: input.taskId, decision_key: decisionKey, decision_id: input.id, title: input.title, text: input.text, created_at: input.createdAt, agent_record: new RecordId("knowledge_agent", agentKey), run_record: new RecordId("knowledge_run", runKey), task_record: new RecordId("knowledge_task", taskKey), source_record: new RecordId("knowledge_source", sourceKey), decision_record: new RecordId("knowledge_decision", decisionKey), executed_edge: new RecordId("executed", runKey), run_task_edge: new RecordId("for_task", runKey), source_run_edge: new RecordId("in_context_of", sourceKey), decision_source_edge: new RecordId("based_on", decisionKey), decision_task_edge: new RecordId("affects", decisionKey), tenant_id: input.tenantId, project_id: input.repositoryId },
    );
  }

  async recordNonRunKnowledge(input: NonRunKnowledgeInput): Promise<void> {
    assertNonRunKnowledge(input);
    const table = `knowledge_${input.kind}`;
    const key = scopedId(input, input.kind, input.id);
    const provenance = input.provenance;
    const content = {
      tenant_id: input.tenantId, project_id: input.repositoryId, external_id: input.id,
      text: input.text, ...(input.kind === "decision" ? { title: input.title } : {}),
      source_id: input.source.id, source_kind: input.source.kind,
      source_label: input.source.label, source_locator: input.source.locator ?? "",
      created_at: input.createdAt, provenance_kind: provenance.kind,
      ...(provenance.kind === "handover"
        ? {
            handover_confirmation_id: provenance.confirmationId,
            handover_fingerprint: provenance.fingerprint,
            ...(provenance.scanId === null ? {} : { handover_scan_id: provenance.scanId }),
            handover_confirmed_at: provenance.confirmedAt,
          }
        : {
            confirmed_by: provenance.confirmedBy,
            evidence: provenance.evidence.map(({ kind, id, label }) => ({ kind, id, label })),
          }),
    };
    // One statement set, one transaction: the record and its provenance are the
    // same row, so neither can exist without the other. A row that already holds
    // this ID must match in every field, including run fields it must not have.
    await this.execute(
      `BEGIN TRANSACTION;
       LET $existing = (SELECT * FROM ${table} WHERE id = $record LIMIT 1);
       IF array::len($existing) > 0 AND (array::sort(object::keys($existing[0])) != $expected_keys OR ${Object.keys(content).map((field) => `$existing[0].${field} != $content.${field}`).join(" OR ")}) { THROW 'Knowledge identity conflict'; };
       UPSERT $record CONTENT $content;
       COMMIT TRANSACTION;`,
      { record: new RecordId(table, key), content, expected_keys: [...Object.keys(content), "id"].sort() },
    );
  }

  async supersedeDecision(scope: KnowledgeScope, currentId: string, priorId: string): Promise<void> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(currentId);
    assertKnowledgeIdentifier(priorId);
    if (currentId === priorId) throw new Error("A decision cannot supersede itself");
    const currentKey = scopedId(scope, "decision", currentId);
    const priorKey = scopedId(scope, "decision", priorId);
    await this.execute(
      `BEGIN TRANSACTION; LET $current = (SELECT * FROM knowledge_decision WHERE id = $current_record AND tenant_id = $tenant AND project_id = $project LIMIT 1); LET $prior = (SELECT * FROM knowledge_decision WHERE id = $prior_record AND tenant_id = $tenant AND project_id = $project LIMIT 1); IF array::len($current) != 1 OR array::len($prior) != 1 { THROW 'Decision must exist in the supplied tenant and project'; }; IF $current[0].task_id != $prior[0].task_id { THROW 'Decisions must affect the same task to supersede'; }; LET $path = (SELECT VALUE @.{1..256}(->supersedes->knowledge_decision) FROM ONLY $prior_record); LET $depth_limit = (SELECT VALUE @.{256}(->supersedes->knowledge_decision) FROM ONLY $prior_record); IF array::any(array::flatten($path), $current_record) OR array::len(array::flatten($depth_limit)) > 0 { THROW 'Decision supersession would create a cycle or exceed the validation depth'; }; RELATE OR UPDATE $current_record->$edge_record->$prior_record SET tenant_id = $tenant, project_id = $project; COMMIT TRANSACTION;`,
      { tenant: scope.tenantId, project: scope.repositoryId, current_id: currentId, prior_id: priorId, current_key: currentKey, prior_key: priorKey, edge_key: scopedId(scope, "supersedes", `${currentId}:${priorId}`), current_record: new RecordId("knowledge_decision", currentKey), prior_record: new RecordId("knowledge_decision", priorKey), edge_record: new RecordId("supersedes", scopedId(scope, "supersedes", `${currentId}:${priorId}`)) },
    );
  }

  async addTaskDependency(scope: KnowledgeScope, taskId: string, dependencyId: string): Promise<void> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(taskId);
    assertKnowledgeIdentifier(dependencyId);
    if (taskId === dependencyId) throw new Error("Task dependency requires two different task IDs");
    const taskKey = scopedId(scope, "task", taskId);
    const dependencyKey = scopedId(scope, "task", dependencyId);
    const edgeKey = scopedId(scope, "depends_on", `${taskId}:${dependencyId}`);
    await this.execute(
      `BEGIN TRANSACTION; UPSERT type::record('knowledge_task', $task_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $task_id }; UPSERT type::record('knowledge_task', $dependency_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $dependency_id }; LET $path = (SELECT VALUE @.{1..256}(->depends_on->knowledge_task) FROM ONLY $dependency_record); LET $depth_limit = (SELECT VALUE @.{256}(->depends_on->knowledge_task) FROM ONLY $dependency_record); IF array::any(array::flatten($path), $task_record) OR array::len(array::flatten($depth_limit)) > 0 { THROW 'Task dependency would create a cycle or exceed the validation depth'; }; RELATE OR UPDATE $task_record->$edge_record->$dependency_record SET tenant_id = $tenant, project_id = $project; COMMIT TRANSACTION;`,
      { tenant: scope.tenantId, project: scope.repositoryId, task_key: taskKey, task_id: taskId, dependency_key: dependencyKey, dependency_id: dependencyId, edge_key: edgeKey, task_record: new RecordId("knowledge_task", taskKey), dependency_record: new RecordId("knowledge_task", dependencyKey), edge_record: new RecordId("depends_on", edgeKey) },
    );
  }

  async findKnowledge(scope: KnowledgeScope, query: KnowledgeSearchQuery): Promise<SearchKnowledgeHit[]> {
    assertKnowledgeScope(scope);
    assertKnowledgeSearchQuery(query);
    const limit = query.limit ?? knowledgeRetrievalLimits.maxResults;
    const agentClause = query.agentId === undefined ? "" : " AND agent_id = $agent_id";
    const params = { tenant: scope.tenantId, project: scope.repositoryId, text: query.text.toLowerCase(), agent_id: query.agentId ?? "", limit };
    try {
      const [memories, decisions, legacy] = await Promise.all([
        this.rows(`SELECT * FROM knowledge_memory WHERE tenant_id = $tenant AND project_id = $project${agentClause} AND string::contains(string::lowercase(text), $text) ORDER BY created_at DESC, external_id ASC LIMIT $limit`, params),
        this.rows(`SELECT * FROM knowledge_decision WHERE tenant_id = $tenant AND project_id = $project${agentClause} AND string::contains(string::lowercase(text), $text) AND id NOT IN (SELECT VALUE out FROM supersedes WHERE tenant_id = $tenant AND project_id = $project) ORDER BY created_at DESC, external_id ASC LIMIT $limit`, params),
        query.agentId === undefined
          ? this.rows("SELECT * FROM knowledge_legacy_memory WHERE tenant_id = $tenant AND project_id = $project AND string::contains(string::lowercase(text), $text) ORDER BY imported_at DESC, external_id ASC LIMIT $limit", params)
          : Promise.resolve([] as Row[]),
      ]);
      if (memories.length > limit || decisions.length > limit || legacy.length > limit) {
        throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
      }
      const hits = [
        ...memories.map((row) => this.hit(row, "memory", scope)),
        ...decisions.map((row) => this.hit(row, "decision", scope)),
        ...legacy.map((row) => this.legacyHit(row, scope)),
      ];
      const seen = new Set<string>();
      for (const hit of hits) {
        const key = `${hit.kind}:${hit.id}`;
        if (seen.has(key) || !hit.text.toLowerCase().includes(params.text) ||
          (query.agentId !== undefined && hit.agentId !== query.agentId)) {
          throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
        }
        seen.add(key);
      }
      return hits.sort(sortKnowledge).slice(0, limit);
    } catch (error) {
      if (error instanceof KnowledgeStoreError) throw error;
      throw new KnowledgeStoreError("KNOWLEDGE_QUERY_FAILED");
    }
  }

  async traceMemoryProvenance(scope: KnowledgeScope, memoryId: string): Promise<KnowledgeProvenance | null> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(memoryId);
    return this.traceProvenance(scope, "memory", memoryId);
  }

  async traceDecisionProvenance(scope: KnowledgeScope, decisionId: string): Promise<KnowledgeProvenance | null> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(decisionId);
    return this.traceProvenance(scope, "decision", decisionId);
  }

  async findCurrentDecisions(scope: KnowledgeScope, taskId: string, limit = knowledgeRetrievalLimits.maxGraphResults): Promise<KnowledgeHit[]> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(taskId);
    assertKnowledgeLimit(limit, knowledgeRetrievalLimits.maxGraphResults);
    const rows = await this.rows(
      "SELECT * FROM knowledge_decision WHERE tenant_id = $tenant AND project_id = $project AND id IN (SELECT VALUE in FROM affects WHERE out = type::record('knowledge_task', $task_key) AND tenant_id = $tenant AND project_id = $project) AND id NOT IN (SELECT VALUE out FROM supersedes WHERE tenant_id = $tenant AND project_id = $project) ORDER BY created_at DESC, external_id ASC LIMIT $limit",
      { tenant: scope.tenantId, project: scope.repositoryId, task_key: scopedId(scope, "task", taskId), limit },
    );
    return rows.map((row) => this.runHit(row, "decision", scope));
  }

  async listTaskDependencies(scope: KnowledgeScope, taskId: string, limit = knowledgeRetrievalLimits.maxGraphResults): Promise<string[]> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(taskId);
    assertKnowledgeLimit(limit, knowledgeRetrievalLimits.maxGraphResults);
    const rows = await this.rows(
      "SELECT in, out, tenant_id, project_id, out.tenant_id AS target_tenant_id, out.project_id AS target_project_id, out.external_id AS target_id FROM depends_on WHERE in = type::record('knowledge_task', $task_key) AND tenant_id = $tenant AND project_id = $project ORDER BY out.external_id, out LIMIT $limit",
      { task_key: scopedId(scope, "task", taskId), tenant: scope.tenantId, project: scope.repositoryId, limit },
    );
    const taskRecord = new RecordId("knowledge_task", scopedId(scope, "task", taskId));
    return rows.map((row) => {
      if (!this.inScope(row, scope) || !isKnowledgeIdentifier(row.target_id) ||
        row.target_tenant_id !== scope.tenantId || row.target_project_id !== scope.repositoryId ||
        !this.sameRecord(row.in, taskRecord) ||
        !this.sameRecord(row.out, new RecordId("knowledge_task", scopedId(scope, "task", row.target_id)))) {
        throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
      }
      return row.target_id;
    });
  }

  async listAgentKnowledge(scope: KnowledgeScope, agentId: string, limit = knowledgeRetrievalLimits.maxGraphResults): Promise<KnowledgeHit[]> {
    assertKnowledgeScope(scope);
    assertKnowledgeIdentifier(agentId);
    assertKnowledgeLimit(limit, knowledgeRetrievalLimits.maxGraphResults);
    const params = { tenant: scope.tenantId, project: scope.repositoryId, agent_id: agentId, limit };
    const [memories, decisions] = await Promise.all([
      this.rows("SELECT * FROM knowledge_memory WHERE tenant_id = $tenant AND project_id = $project AND agent_id = $agent_id ORDER BY created_at DESC, external_id ASC LIMIT $limit", params),
      this.rows("SELECT * FROM knowledge_decision WHERE tenant_id = $tenant AND project_id = $project AND agent_id = $agent_id AND id NOT IN (SELECT VALUE out FROM supersedes WHERE tenant_id = $tenant AND project_id = $project) ORDER BY created_at DESC, external_id ASC LIMIT $limit", params),
    ]);
    return [...memories.map((row) => this.runHit(row, "memory", scope)), ...decisions.map((row) => this.runHit(row, "decision", scope))]
      .sort(sortKnowledge).slice(0, limit);
  }

  async deleteProjectKnowledge(scope: KnowledgeScope): Promise<void> {
    assertKnowledgeScope(scope);
    const tables = ["executed", "for_task", "derived_from", "in_context_of", "based_on", "affects", "supersedes", "depends_on", "knowledge_legacy_memory", "knowledge_memory", "knowledge_decision", "knowledge_source", "knowledge_run", "knowledge_task", "knowledge_agent"];
    const statement = [`BEGIN TRANSACTION`, ...tables.map((table) => `DELETE FROM ${table} WHERE tenant_id = $tenant AND project_id = $project`), `COMMIT TRANSACTION`].join("; ");
    await this.execute(statement, { tenant: scope.tenantId, project: scope.repositoryId });
  }

  private async execute(statement: string, params: Record<string, unknown>): Promise<void> {
    await this.db.query(statement, params);
  }

  private inScope(value: unknown, scope: KnowledgeScope): value is Row {
    return typeof value === "object" && value !== null && !Array.isArray(value) &&
      (value as Row).tenant_id === scope.tenantId && (value as Row).project_id === scope.repositoryId;
  }

  private sameRecord(value: unknown, expected: RecordId): boolean {
    return value instanceof RecordId && value.toString() === expected.toString();
  }

  private async requireNode(scope: KnowledgeScope, kind: string, id: string, fields: Row = {}): Promise<Row> {
    const record = new RecordId(`knowledge_${kind}`, scopedId(scope, kind, id));
    const rows = await this.rows(`SELECT * FROM knowledge_${kind} WHERE id = $record LIMIT 2`, { record });
    const row = rows[0];
    if (rows.length !== 1 || !this.inScope(row, scope) || row.external_id !== id ||
      !this.sameRecord(row.id, record) ||
      Object.entries(fields).some(([field, value]) => row[field] !== value)) {
      throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    }
    return row;
  }

  private async requireEdge(scope: KnowledgeScope, table: string, from: RecordId, to: RecordId, direction: "in" | "out" = "in"): Promise<void> {
    const rows = await this.rows(`SELECT * FROM ${table} WHERE ${direction} = $record LIMIT 2`, { record: direction === "in" ? from : to });
    const edge = rows[0];
    if (rows.length !== 1 || !this.inScope(edge, scope) ||
      !this.sameRecord(edge.in, from) || !this.sameRecord(edge.out, to)) {
      throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    }
  }

  private async traceProvenance(scope: KnowledgeScope, kind: KnowledgeHit["kind"], id: string): Promise<KnowledgeProvenance | null> {
    const knowledgeRecord = new RecordId(`knowledge_${kind}`, scopedId(scope, kind, id));
    const rows = await this.rows(`SELECT * FROM knowledge_${kind} WHERE id = $record LIMIT 2`, { record: knowledgeRecord });
    if (rows.length === 0) return null;
    const row = rows[0];
    if (rows.length !== 1 || !row) throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    const hit = this.hit(row, kind, scope);
    if (hit.id !== id || !this.sameRecord(row.id, knowledgeRecord)) {
      throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    }
    // A non-run record is self-contained: it has no run, task, or agent graph to verify.
    if (hit.runId === null) {
      return { knowledge: hit, source: hit.source, runId: null, taskId: null, agentId: null };
    }

    const sourceRecord = new RecordId("knowledge_source", scopedId(scope, "source", hit.source.id));
    const runRecord = new RecordId("knowledge_run", scopedId(scope, "run", hit.runId));
    const taskRecord = new RecordId("knowledge_task", scopedId(scope, "task", hit.taskId));
    const agentRecord = new RecordId("knowledge_agent", scopedId(scope, "agent", hit.agentId));
    const [source] = await Promise.all([
      this.requireNode(scope, "source", hit.source.id, {
        kind: hit.source.kind, label: hit.source.label,
        run_id: hit.runId, task_id: hit.taskId, agent_id: hit.agentId,
      }),
      this.requireNode(scope, "run", hit.runId, { agent_id: hit.agentId, task_id: hit.taskId }),
      this.requireNode(scope, "task", hit.taskId),
      this.requireNode(scope, "agent", hit.agentId),
    ]);
    if ((source.locator ?? "") !== (hit.source.locator ?? "")) {
      throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    }
    await Promise.all([
      this.requireEdge(scope, kind === "memory" ? "derived_from" : "based_on", knowledgeRecord, sourceRecord),
      this.requireEdge(scope, "in_context_of", sourceRecord, runRecord),
      this.requireEdge(scope, "for_task", runRecord, taskRecord),
      this.requireEdge(scope, "executed", agentRecord, runRecord, "out"),
      ...(kind === "decision" ? [this.requireEdge(scope, "affects", knowledgeRecord, taskRecord)] : []),
    ]);
    return { knowledge: hit, source: hit.source, runId: hit.runId, taskId: hit.taskId, agentId: hit.agentId };
  }

  private async rows<T = Row>(statement: string, params: Record<string, unknown>): Promise<T[]> {
    try {
      const response: unknown = await this.db.query<[T[]]>(statement, params);
      if (!Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0])) {
        throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
      }
      return response[0] as T[];
    } catch (error) {
      if (error instanceof KnowledgeStoreError) throw error;
      throw new KnowledgeStoreError("KNOWLEDGE_QUERY_FAILED");
    }
  }

  private runHit(row: Row, kind: KnowledgeHit["kind"], scope: KnowledgeScope): KnowledgeHit {
    const hit = this.hit(row, kind, scope);
    if (hit.runId === null) throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    return hit;
  }

  /** Validates the fields of the row's own provenance kind and rejects any field of another kind. */
  private hit(row: Row, kind: KnowledgeHit["kind"], scope: KnowledgeScope): KnowledgeHit | NonRunKnowledgeHit {
    const invalid = new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    if (
      !this.inScope(row, scope) ||
      ["external_id", "text", "source_id", "source_label"].some((field) => typeof row[field] !== "string" || !(row[field] as string).trim()) ||
      !isKnowledgeIdentifier(row.external_id) || !isKnowledgeIdentifier(row.source_id) ||
      !this.sameRecord(row.id, new RecordId(`knowledge_${kind}`, scopedId(scope, kind, String(row.external_id)))) ||
      (kind === "decision" && (typeof row.title !== "string" || !row.title.trim())) ||
      (row.source_locator != null && typeof row.source_locator !== "string")
    ) {
      throw invalid;
    }
    const createdAt = toDate(row.created_at);
    if (Number.isNaN(createdAt.getTime())) throw invalid;
    const common = {
      tenantId: scope.tenantId,
      repositoryId: scope.repositoryId,
      id: row.external_id as string,
      kind,
      text: row.text as string,
      title: kind === "decision" ? row.title as string : null,
      createdAt,
    };
    const source = (sourceKind: KnowledgeHit["source"]["kind"]) => ({
      id: row.source_id as string,
      kind: sourceKind,
      label: row.source_label as string,
      ...(typeof row.source_locator === "string" && row.source_locator.length > 0
        ? { locator: row.source_locator }
        : {}),
    });
    const runFields = ["agent_id", "run_id", "task_id"] as const;
    if (row.provenance_kind == null) {
      if (
        runFields.some((field) => !isKnowledgeIdentifier(row[field])) ||
        nonRunProvenanceFields.some((field) => row[field] != null) ||
        !["requirement", "task", "decision", "run", "external"].includes(String(row.source_kind))
      ) {
        throw invalid;
      }
      return {
        ...common,
        agentId: row.agent_id as string,
        runId: row.run_id as string,
        taskId: row.task_id as string,
        source: source(row.source_kind as KnowledgeHit["source"]["kind"]),
      };
    }
    const provenance: unknown = row.provenance_kind === "handover"
      ? {
          kind: "handover",
          confirmationId: row.handover_confirmation_id,
          fingerprint: row.handover_fingerprint,
          scanId: row.handover_scan_id ?? null,
          confirmedAt: toDate(row.handover_confirmed_at),
        }
      : row.provenance_kind === "operator_confirmed"
        ? { kind: "operator_confirmed", confirmedBy: row.confirmed_by, evidence: row.evidence }
        : null;
    if (
      !isNonRunKnowledgeProvenance(provenance) ||
      runFields.some((field) => row[field] != null) ||
      (provenance.kind === "handover"
        ? row.confirmed_by != null || row.evidence != null
        : nonRunProvenanceFields.slice(0, 4).some((field) => row[field] != null)) ||
      row.source_kind !== nonRunSourceKind[provenance.kind] ||
      row.source_id !== (provenance.kind === "handover" ? provenance.confirmationId : provenance.confirmedBy)
    ) {
      throw invalid;
    }
    return {
      ...common,
      agentId: null,
      runId: null,
      taskId: null,
      source: source(nonRunSourceKind[provenance.kind]),
      provenance: provenance.kind === "handover"
        ? provenance
        : { ...provenance, evidence: provenance.evidence.map(({ kind: evidenceKind, id, label }) => ({ kind: evidenceKind, id, label })) },
    };
  }

  private legacyHit(row: Row, scope: KnowledgeScope, expectedId?: string): LegacyKnowledgeHit {
    const id = row.external_id;
    const sourceScope = row.source_scope;
    const sourceKey = row.source_key;
    const sourceSha256 = row.source_sha256;
    const importedAt = row.imported_at instanceof DateTime
      ? row.imported_at.toDate()
      : row.imported_at instanceof Date ? row.imported_at
        : typeof row.imported_at === "string" ? new Date(row.imported_at) : new Date(Number.NaN);
    if (!this.inScope(row, scope) || !isKnowledgeIdentifier(id) ||
      (expectedId !== undefined && id !== expectedId) ||
      !this.sameRecord(row.id, new RecordId("knowledge_legacy_memory", scopedId(scope, "legacy_memory", id))) ||
      !isLegacyMemoryValue(row.text) ||
      typeof sourceScope !== "string" || !/^aio-[0-9a-f]{32}$/u.test(sourceScope) ||
      !isLegacyMemoryKey(sourceKey) ||
      typeof sourceSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(sourceSha256) ||
      sourceSha256 !== `sha256:${createHash("sha256").update(row.text as string, "utf8").digest("hex")}` ||
      Number.isNaN(importedAt.getTime())) {
      throw new KnowledgeStoreError("KNOWLEDGE_INVALID_RESULT");
    }
    return {
      tenantId: scope.tenantId, repositoryId: scope.repositoryId, id,
      kind: "memory", text: row.text, title: null,
      agentId: null, runId: null, taskId: null,
      source: { kind: "external", id: sourceKey, label: "CairnKeep named scope", locator: sourceSha256 },
      createdAt: importedAt,
      legacy: { sourceScope, sourceKey, sourceSha256 },
    };
  }
}

import type {
  AgentKnowledgeStore,
  DecisionInput,
  KnowledgeHit,
  KnowledgeScope,
  MemoryInput,
  KnowledgeProvenance,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { RecordId, type Surreal } from "surrealdb";
import { initializeAgentKnowledgeSchema } from "./schema.ts";

type Row = Record<string, unknown>;

function scopedId(scope: KnowledgeScope, kind: string, id: string): string {
  return encodeURIComponent(JSON.stringify([scope.tenantId, scope.projectId, kind, id]));
}

function assertScope(scope: KnowledgeScope): void {
  if (!scope.tenantId.trim() || !scope.projectId.trim()) {
    throw new Error("AgentKnowledgeStore requires explicit tenant and project IDs");
  }
}

function assertKnowledge(input: MemoryInput | DecisionInput): void {
  assertScope(input);
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
      tenant: input.tenantId, project: input.projectId,
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
      tenant_id: input.tenantId, project_id: input.projectId,
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
      { tenant: input.tenantId, project: input.projectId, source_key: sourceKey, source_id: input.source.id, source_kind: input.source.kind, source_label: input.source.label, source_locator: input.source.locator ?? "", agent_key: agentKey, agent_id: input.agentId, run_key: runKey, run_id: input.runId, task_key: taskKey, task_id: input.taskId, decision_key: decisionKey, decision_id: input.id, title: input.title, text: input.text, created_at: input.createdAt, agent_record: new RecordId("knowledge_agent", agentKey), run_record: new RecordId("knowledge_run", runKey), task_record: new RecordId("knowledge_task", taskKey), source_record: new RecordId("knowledge_source", sourceKey), decision_record: new RecordId("knowledge_decision", decisionKey), executed_edge: new RecordId("executed", runKey), run_task_edge: new RecordId("for_task", runKey), source_run_edge: new RecordId("in_context_of", sourceKey), decision_source_edge: new RecordId("based_on", decisionKey), decision_task_edge: new RecordId("affects", decisionKey), tenant_id: input.tenantId, project_id: input.projectId },
    );
  }

  async supersedeDecision(scope: KnowledgeScope, currentId: string, priorId: string): Promise<void> {
    assertScope(scope);
    if (currentId === priorId) throw new Error("A decision cannot supersede itself");
    const currentKey = scopedId(scope, "decision", currentId);
    const priorKey = scopedId(scope, "decision", priorId);
    await this.execute(
      `BEGIN TRANSACTION; LET $current = (SELECT * FROM knowledge_decision WHERE id = $current_record AND tenant_id = $tenant AND project_id = $project LIMIT 1); LET $prior = (SELECT * FROM knowledge_decision WHERE id = $prior_record AND tenant_id = $tenant AND project_id = $project LIMIT 1); IF array::len($current) != 1 OR array::len($prior) != 1 { THROW 'Decision must exist in the supplied tenant and project'; }; IF $current[0].task_id != $prior[0].task_id { THROW 'Decisions must affect the same task to supersede'; }; LET $path = (SELECT VALUE @.{1..256}(->supersedes->knowledge_decision) FROM ONLY $prior_record); LET $depth_limit = (SELECT VALUE @.{256}(->supersedes->knowledge_decision) FROM ONLY $prior_record); IF array::any(array::flatten($path), $current_record) OR array::len(array::flatten($depth_limit)) > 0 { THROW 'Decision supersession would create a cycle or exceed the validation depth'; }; RELATE OR UPDATE $current_record->$edge_record->$prior_record SET tenant_id = $tenant, project_id = $project; COMMIT TRANSACTION;`,
      { tenant: scope.tenantId, project: scope.projectId, current_id: currentId, prior_id: priorId, current_key: currentKey, prior_key: priorKey, edge_key: scopedId(scope, "supersedes", `${currentId}:${priorId}`), current_record: new RecordId("knowledge_decision", currentKey), prior_record: new RecordId("knowledge_decision", priorKey), edge_record: new RecordId("supersedes", scopedId(scope, "supersedes", `${currentId}:${priorId}`)) },
    );
  }

  async addTaskDependency(scope: KnowledgeScope, taskId: string, dependencyId: string): Promise<void> {
    assertScope(scope);
    if (!taskId.trim() || !dependencyId.trim() || taskId === dependencyId) throw new Error("Task dependency requires two different task IDs");
    const taskKey = scopedId(scope, "task", taskId);
    const dependencyKey = scopedId(scope, "task", dependencyId);
    const edgeKey = scopedId(scope, "depends_on", `${taskId}:${dependencyId}`);
    await this.execute(
      `BEGIN TRANSACTION; UPSERT type::record('knowledge_task', $task_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $task_id }; UPSERT type::record('knowledge_task', $dependency_key) CONTENT { tenant_id: $tenant, project_id: $project, external_id: $dependency_id }; LET $path = (SELECT VALUE @.{1..256}(->depends_on->knowledge_task) FROM ONLY $dependency_record); LET $depth_limit = (SELECT VALUE @.{256}(->depends_on->knowledge_task) FROM ONLY $dependency_record); IF array::any(array::flatten($path), $task_record) OR array::len(array::flatten($depth_limit)) > 0 { THROW 'Task dependency would create a cycle or exceed the validation depth'; }; RELATE OR UPDATE $task_record->$edge_record->$dependency_record SET tenant_id = $tenant, project_id = $project; COMMIT TRANSACTION;`,
      { tenant: scope.tenantId, project: scope.projectId, task_key: taskKey, task_id: taskId, dependency_key: dependencyKey, dependency_id: dependencyId, edge_key: edgeKey, task_record: new RecordId("knowledge_task", taskKey), dependency_record: new RecordId("knowledge_task", dependencyKey), edge_record: new RecordId("depends_on", edgeKey) },
    );
  }

  async findKnowledge(scope: KnowledgeScope, query: { text: string; agentId?: string; limit?: number }): Promise<KnowledgeHit[]> {
    assertScope(scope);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const agentClause = query.agentId === undefined ? "" : " AND agent_id = $agent_id";
    const params = { tenant: scope.tenantId, project: scope.projectId, text: query.text.toLowerCase(), agent_id: query.agentId ?? "", limit };
    const [memories, decisions] = await Promise.all([
      this.rows(`SELECT * FROM knowledge_memory WHERE tenant_id = $tenant AND project_id = $project${agentClause} AND string::contains(string::lowercase(text), $text) ORDER BY created_at DESC, external_id ASC LIMIT $limit`, params),
      this.rows(`SELECT * FROM knowledge_decision WHERE tenant_id = $tenant AND project_id = $project${agentClause} AND string::contains(string::lowercase(text), $text) AND id NOT IN (SELECT VALUE out FROM supersedes WHERE tenant_id = $tenant AND project_id = $project) ORDER BY created_at DESC, external_id ASC LIMIT $limit`, params),
    ]);
    return [...memories.map((row) => this.hit(row, "memory")), ...decisions.map((row) => this.hit(row, "decision"))]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
  }

  async traceMemoryProvenance(scope: KnowledgeScope, memoryId: string): Promise<KnowledgeProvenance | null> {
    assertScope(scope);
    const memoryKey = scopedId(scope, "memory", memoryId);
    const edgeScope = "WHERE tenant_id = $tenant AND project_id = $project";
    const [rows] = await this.db.query<[Row[]]>(
      `SELECT *,
         ->(derived_from ${edgeScope})->knowledge_source.* AS source,
         ->(derived_from ${edgeScope})->knowledge_source->(in_context_of ${edgeScope})->knowledge_run.* AS run,
         ->(derived_from ${edgeScope})->knowledge_source->(in_context_of ${edgeScope})->knowledge_run->(for_task ${edgeScope})->knowledge_task.* AS task,
         ->(derived_from ${edgeScope})->knowledge_source->(in_context_of ${edgeScope})->knowledge_run<-(executed ${edgeScope})<-knowledge_agent.* AS agent
       FROM knowledge_memory
       WHERE id = type::record('knowledge_memory', $memory_key) AND tenant_id = $tenant AND project_id = $project LIMIT 1`,
      { memory_key: memoryKey, tenant: scope.tenantId, project: scope.projectId },
    );
    const row = rows?.[0];
    if (!row) return null;
    const source = this.pathNode(row.source, scope);
    const run = this.pathNode(row.run, scope);
    const task = this.pathNode(row.task, scope);
    const agent = this.pathNode(row.agent, scope);
    if (!source || !run || !task || !agent) return null;
    if (source.external_id !== row.source_id || source.run_id !== row.run_id || source.task_id !== row.task_id || source.agent_id !== row.agent_id) return null;
    if (run.external_id !== row.run_id || run.agent_id !== row.agent_id || run.task_id !== row.task_id || task.external_id !== row.task_id || agent.external_id !== row.agent_id) return null;
    const hit = this.hit(row, "memory");
    return { knowledge: hit, source: hit.source, runId: hit.runId, taskId: hit.taskId, agentId: hit.agentId };
  }

  async traceDecisionProvenance(scope: KnowledgeScope, decisionId: string): Promise<KnowledgeProvenance | null> {
    assertScope(scope);
    const decisionKey = scopedId(scope, "decision", decisionId);
    const [decisionRows] = await this.db.query<[Row[]]>("SELECT * FROM knowledge_decision WHERE id = type::record('knowledge_decision', $decision_key) AND tenant_id = $tenant AND project_id = $project LIMIT 1", { decision_key: decisionKey, tenant: scope.tenantId, project: scope.projectId });
    const row = decisionRows?.[0];
    if (!row) return null;
    const sourceKey = scopedId(scope, "source", String(row.source_id));
    const runKey = scopedId(scope, "run", String(row.run_id));
    const taskKey = scopedId(scope, "task", String(row.task_id));
    const agentKey = scopedId(scope, "agent", String(row.agent_id));
    const edgeParams = { decision_key: decisionKey, source_key: sourceKey, run_key: runKey, task_key: taskKey, agent_key: agentKey, tenant: scope.tenantId, project: scope.projectId };
    const edges = await Promise.all([
      this.rows("SELECT id FROM based_on WHERE in = type::record('knowledge_decision', $decision_key) AND out = type::record('knowledge_source', $source_key) AND tenant_id = $tenant AND project_id = $project", edgeParams),
      this.rows("SELECT id FROM in_context_of WHERE in = type::record('knowledge_source', $source_key) AND out = type::record('knowledge_run', $run_key) AND tenant_id = $tenant AND project_id = $project", edgeParams),
      this.rows("SELECT id FROM for_task WHERE in = type::record('knowledge_run', $run_key) AND out = type::record('knowledge_task', $task_key) AND tenant_id = $tenant AND project_id = $project", edgeParams),
      this.rows("SELECT id FROM executed WHERE in = type::record('knowledge_agent', $agent_key) AND out = type::record('knowledge_run', $run_key) AND tenant_id = $tenant AND project_id = $project", edgeParams),
    ]);
    if (edges.some((result) => result.length === 0)) return null;
    const sources = await this.rows("SELECT * FROM knowledge_source WHERE id = type::record('knowledge_source', $source_key) AND tenant_id = $tenant AND project_id = $project LIMIT 1", edgeParams);
    const source = sources[0];
    if (!source || source.run_id !== row.run_id || source.task_id !== row.task_id || source.agent_id !== row.agent_id || !(await this.hasContextNodes(scope, row))) return null;
    const hit = this.hit(row, "decision");
    return { knowledge: hit, source: hit.source, runId: hit.runId, taskId: hit.taskId, agentId: hit.agentId };
  }

  async findCurrentDecisions(scope: KnowledgeScope, taskId: string): Promise<KnowledgeHit[]> {
    assertScope(scope);
    const [rows] = await this.db.query<[Row[]]>(
      "SELECT * FROM knowledge_decision WHERE tenant_id = $tenant AND project_id = $project AND id IN (SELECT VALUE in FROM affects WHERE out = type::record('knowledge_task', $task_key) AND tenant_id = $tenant AND project_id = $project) AND id NOT IN (SELECT VALUE out FROM supersedes WHERE tenant_id = $tenant AND project_id = $project) ORDER BY created_at DESC",
      { tenant: scope.tenantId, project: scope.projectId, task_key: scopedId(scope, "task", taskId) },
    );
    return (rows ?? []).map((row) => this.hit(row, "decision"));
  }

  async listTaskDependencies(scope: KnowledgeScope, taskId: string): Promise<string[]> {
    assertScope(scope);
    const taskKey = scopedId(scope, "task", taskId);
    const [rows] = await this.db.query<[Row[]]>(
      "SELECT VALUE out.external_id FROM depends_on WHERE in = type::record('knowledge_task', $task_key) AND tenant_id = $tenant AND project_id = $project ORDER BY out.external_id",
      { task_key: taskKey, tenant: scope.tenantId, project: scope.projectId },
    );
    return (rows ?? []).map(String);
  }

  async listAgentKnowledge(scope: KnowledgeScope, agentId: string): Promise<KnowledgeHit[]> {
    return this.findKnowledge(scope, { text: "", agentId, limit: 100 });
  }

  async deleteProjectKnowledge(scope: KnowledgeScope): Promise<void> {
    assertScope(scope);
    const tables = ["executed", "for_task", "derived_from", "in_context_of", "based_on", "affects", "supersedes", "depends_on", "knowledge_memory", "knowledge_decision", "knowledge_source", "knowledge_run", "knowledge_task", "knowledge_agent"];
    const statement = [`BEGIN TRANSACTION`, ...tables.map((table) => `DELETE FROM ${table} WHERE tenant_id = $tenant AND project_id = $project`), `COMMIT TRANSACTION`].join("; ");
    await this.execute(statement, { tenant: scope.tenantId, project: scope.projectId });
  }

  private async execute(statement: string, params: Record<string, unknown>): Promise<void> {
    await this.db.query(statement, params);
  }

  private pathNode(value: unknown, scope: KnowledgeScope): Row | null {
    const nodes = Array.isArray(value) ? value : [value];
    if (nodes.length !== 1) return null;
    const node = nodes[0];
    if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
    const row = node as Row;
    return row.tenant_id === scope.tenantId && row.project_id === scope.projectId ? row : null;
  }

  private async hasContextNodes(scope: KnowledgeScope, row: Row): Promise<boolean> {
    const agentId = String(row.agent_id);
    const runId = String(row.run_id);
    const taskId = String(row.task_id);
    const [agents, runs, tasks] = await Promise.all([
      this.rows("SELECT external_id FROM knowledge_agent WHERE id = type::record('knowledge_agent', $key) AND tenant_id = $tenant AND project_id = $project LIMIT 1", { key: scopedId(scope, "agent", agentId), tenant: scope.tenantId, project: scope.projectId }),
      this.rows("SELECT external_id, agent_id, task_id FROM knowledge_run WHERE id = type::record('knowledge_run', $key) AND tenant_id = $tenant AND project_id = $project LIMIT 1", { key: scopedId(scope, "run", runId), tenant: scope.tenantId, project: scope.projectId }),
      this.rows("SELECT external_id FROM knowledge_task WHERE id = type::record('knowledge_task', $key) AND tenant_id = $tenant AND project_id = $project LIMIT 1", { key: scopedId(scope, "task", taskId), tenant: scope.tenantId, project: scope.projectId }),
    ]);
    return agents[0]?.external_id === agentId && runs[0]?.external_id === runId && runs[0]?.agent_id === agentId && runs[0]?.task_id === taskId && tasks[0]?.external_id === taskId;
  }

  private async rows(statement: string, params: Record<string, unknown>): Promise<Row[]> {
    const [rows] = await this.db.query<[Row[]]>(statement, params);
    return rows ?? [];
  }

  private hit(row: Row, kind: KnowledgeHit["kind"]): KnowledgeHit {
    return {
      tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.external_id), kind,
      text: String(row.text), title: typeof row.title === "string" ? row.title : null,
      agentId: String(row.agent_id), runId: String(row.run_id), taskId: String(row.task_id),
      source: { id: String(row.source_id), kind: row.source_kind as KnowledgeHit["source"]["kind"], label: String(row.source_label), ...(typeof row.source_locator === "string" && row.source_locator.length > 0 ? { locator: row.source_locator } : {}) },
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    };
  }
}

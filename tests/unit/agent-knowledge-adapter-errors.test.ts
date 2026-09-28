import { RecordId, type Surreal } from "../../packages/storage-surrealdb/node_modules/surrealdb";
import { describe, expect, it, vi } from "vitest";
import { SurrealAgentKnowledgeStoreImpl } from "../../packages/storage-surrealdb/src/surreal-agent-knowledge.store.ts";

const scope = { tenantId: "tenant-a", repositoryId: "repo-a" };

async function mockStore() {
  const query = vi.fn(async (_statement?: string): Promise<unknown[]> => [[]]);
  const store = await SurrealAgentKnowledgeStoreImpl.create({ query } as unknown as Surreal);
  return { store, query };
}

describe("AgentKnowledgeStore retrieval failures", () => {
  it("sanitizes driver failures from every public retrieval operation", async () => {
    const { store, query } = await mockStore();
    query.mockRejectedValue(new Error("SurrealQL at ws://secret.example:8000 with credential"));
    const reads = [
      store.findKnowledge(scope, { text: "needle" }),
      store.traceMemoryProvenance(scope, "memory-a"),
      store.traceDecisionProvenance(scope, "decision-a"),
      store.findCurrentDecisions(scope, "task-a"),
      store.listTaskDependencies(scope, "task-a"),
      store.listAgentKnowledge(scope, "agent-a"),
    ];
    for (const read of reads) {
      await expect(read).rejects.toMatchObject({
        code: "KNOWLEDGE_QUERY_FAILED",
        message: "KNOWLEDGE_QUERY_FAILED",
      });
    }
  });

  it("rejects type-invalid and incomplete base rows before graph lookup", async () => {
    const { store, query } = await mockStore();
    const base = {
      tenant_id: scope.tenantId, project_id: scope.repositoryId,
      external_id: "memory-a", text: "valid text", agent_id: "agent-a",
      run_id: "run-a", task_id: "task-a", source_kind: "task",
      source_label: "Task A", created_at: new Date(),
    };
    query.mockResolvedValueOnce([[{ ...base, source_id: undefined }]]);
    await expect(store.traceMemoryProvenance(scope, "memory-a")).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    query.mockResolvedValueOnce([[{ ...base, external_id: 17, title: "Decision A" }]]);
    await expect(store.traceDecisionProvenance(scope, "decision-a")).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
  });

  it("fails closed on mismatched search rows instead of returning or silently dropping them", async () => {
    const { store, query } = await mockStore();
    const id = new RecordId("knowledge_memory", encodeURIComponent(JSON.stringify([
      scope.tenantId, scope.repositoryId, "memory", "memory-a",
    ])));
    const base = {
      id, tenant_id: scope.tenantId, project_id: scope.repositoryId,
      external_id: "memory-a", text: "Approval is required", agent_id: "agent-a",
      run_id: "run-a", task_id: "task-a", source_id: "source-a",
      source_kind: "task", source_label: "Task A", created_at: new Date(),
    };
    for (const row of [
      { ...base, tenant_id: "tenant-b" },
      { ...base, project_id: "repo-b" },
      { ...base, id: new RecordId("knowledge_memory", "wrong") },
      { ...base, id: new RecordId("knowledge_decision", id.id) },
      { ...base, external_id: " memory-a" },
      { ...base, run_id: " " },
      { ...base, source_id: null },
      { ...base, source_kind: "unknown" },
      { ...base, source_label: " " },
      { ...base, source_locator: 42 },
      { ...base, created_at: "not-a-date" },
      { ...base, text: "unrelated value" },
      { ...base, agent_id: "other-agent" },
    ]) {
      query.mockImplementation(async (statement?: string) =>
        statement?.includes("FROM knowledge_memory") ? [[row]] : [[]]);
      await expect(store.findKnowledge(scope, { text: "approval", agentId: "agent-a" }))
        .rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    }
    query.mockImplementation(async (statement?: string) =>
      statement?.includes("FROM knowledge_memory") ? [[base, base]] : [[]]);
    await expect(store.findKnowledge(scope, { text: "approval" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    query.mockImplementation(async (statement?: string) =>
      statement?.includes("FROM knowledge_memory") ? [[base, base]] : [[]]);
    await expect(store.findKnowledge(scope, { text: "approval", limit: 1 }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
  });

  it("rejects malformed database response envelopes as invalid results", async () => {
    const { store, query } = await mockStore();
    for (const response of [null, {}, [], [null], [{}], [[], []], ["not rows"]]) {
      query.mockImplementation(async () => response as unknown[]);
      await expect(store.findKnowledge(scope, { text: "approval" }))
        .rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT", message: "KNOWLEDGE_INVALID_RESULT" });
    }
  });

  it("rejects malformed decision-specific fields", async () => {
    const { store, query } = await mockStore();
    const id = new RecordId("knowledge_decision", encodeURIComponent(JSON.stringify([
      scope.tenantId, scope.repositoryId, "decision", "decision-a",
    ])));
    query.mockImplementation(async (statement?: string) => statement?.includes("FROM knowledge_decision")
      ? [[{
        id, tenant_id: scope.tenantId, project_id: scope.repositoryId,
        external_id: "decision-a", text: "Approval is required", title: " ",
        agent_id: "agent-a", run_id: "run-a", task_id: "task-a",
        source_id: "source-a", source_kind: "task", source_label: "Task A",
        created_at: new Date(),
      }]] : [[]]);
    await expect(store.findKnowledge(scope, { text: "approval" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
  });
});

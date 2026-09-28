import type { Surreal } from "../../packages/storage-surrealdb/node_modules/surrealdb";
import { describe, expect, it, vi } from "vitest";
import { SurrealAgentKnowledgeStoreImpl } from "../../packages/storage-surrealdb/src/surreal-agent-knowledge.store.ts";

const scope = { tenantId: "tenant-a", repositoryId: "repo-a" };

async function mockStore() {
  const query = vi.fn(async (): Promise<unknown[]> => [[]]);
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
});

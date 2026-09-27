import type { DecisionInput, KnowledgeScope, MemoryInput } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectSurrealAgentKnowledgeStore } from "../../packages/storage-surrealdb/src/connect-agent-knowledge-store.ts";

const endpoint = process.env.AI_OFFICE_TEST_SURREALDB_URL;
const enabled = Boolean(endpoint);
const scopeA = { tenantId: "tenant-a", projectId: "project-a" } satisfies KnowledgeScope;
const scopeSameTenantOtherProject = { tenantId: "tenant-a", projectId: "project-b" } satisfies KnowledgeScope;
const scopeB = { tenantId: "tenant-b", projectId: "project-b" } satisfies KnowledgeScope;
let closeStore: () => Promise<void>;
let store: Awaited<ReturnType<typeof connectSurrealAgentKnowledgeStore>>["store"];

function memory(scope: KnowledgeScope, id: string, text = "The deploy requires approval"): MemoryInput {
  return {
    ...scope,
    id,
    text,
    agentId: "agent-1",
    runId: `run-${id}`,
    taskId: `task-${id}`,
    source: { id: `source-${id}`, kind: "requirement", label: "Requirement R-1", locator: "requirements/R-1" },
    createdAt: new Date("2026-09-27T10:00:00.000Z"),
  };
}

function decision(scope: KnowledgeScope, id: string, taskId: string, text = "Use staged deployment"): DecisionInput {
  return {
    ...scope,
    id,
    text,
    title: `Decision ${id}`,
    agentId: "agent-1",
    runId: `run-${id}`,
    taskId,
    source: { id: `source-${id}`, kind: "task", label: `Task ${taskId}` },
    createdAt: new Date("2026-09-27T10:00:00.000Z"),
  };
}

describe.skipIf(!enabled)("SurrealDB AgentKnowledgeStore integration", () => {
  beforeAll(async () => {
    const connection = await connectSurrealAgentKnowledgeStore({ endpoint: endpoint!, namespace: "ai_office_test", database: "agent_knowledge", username: "root", password: "root" });
    store = connection.store;
    closeStore = connection.close;
    const secondConnection = await connectSurrealAgentKnowledgeStore({ endpoint: endpoint!, namespace: "ai_office_test", database: "agent_knowledge", username: "root", password: "root" });
    await secondConnection.close();
  });

  afterEach(async () => {
    await store.deleteProjectKnowledge(scopeA);
    await store.deleteProjectKnowledge(scopeSameTenantOtherProject);
    await store.deleteProjectKnowledge(scopeB);
  });

  afterAll(async () => {
    await closeStore?.();
  });

  it("initializes the versioned schema repeatedly and records idempotent provenance-backed memory", async () => {
    const input = memory(scopeA, "memory-basic");
    await store.recordMemory(input);
    await store.recordMemory(input);

    const hits = await store.findKnowledge(scopeA, { text: "approval" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: input.id, kind: "memory", source: input.source, agentId: input.agentId });
  });

  it("rejects incomplete provenance before writing", async () => {
    const input = memory(scopeA, "memory-incomplete");
    await expect(store.recordMemory({ ...input, runId: " " })).rejects.toThrow(/provenance runId/);
    await expect(store.recordMemory({ ...input, tenantId: " " })).rejects.toThrow(/explicit tenant and project/);
    await expect(store.findKnowledge({ tenantId: " ", projectId: scopeA.projectId }, { text: "approval" })).rejects.toThrow(/explicit tenant and project/);
    expect(await store.findKnowledge(scopeA, { text: "approval" })).toEqual([]);
  });

  it("traverses memory to source, originating run, task, and agent", async () => {
    const input = memory(scopeA, "memory-provenance");
    await store.recordMemory(input);
    const trace = await store.traceMemoryProvenance(scopeA, input.id);

    expect(trace).toMatchObject({
      knowledge: { id: input.id, kind: "memory" },
      source: input.source,
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
    });
  });

  it("retrieves only current decisions affecting the requested task", async () => {
    const old = decision(scopeA, "decision-old", "task-decision");
    const current = decision(scopeA, "decision-current", "task-decision", "Use blue green deployment");
    await store.recordDecision(old);
    await store.recordDecision(current);
    await store.supersedeDecision(scopeA, current.id, old.id);

    expect((await store.findCurrentDecisions(scopeA, "task-decision")).map((hit) => hit.id)).toEqual([current.id]);
    expect((await store.findKnowledge(scopeA, { text: "deployment" })).map((hit) => hit.id)).toEqual([current.id]);
    expect(await store.traceDecisionProvenance(scopeA, current.id)).toMatchObject({
      knowledge: { id: current.id, kind: "decision" },
      source: current.source,
      runId: current.runId,
      taskId: current.taskId,
      agentId: current.agentId,
    });
  });

  it("traverses task dependencies deterministically", async () => {
    await store.addTaskDependency(scopeA, "task-child", "task-parent");
    await store.addTaskDependency(scopeA, "task-child", "task-foundation");
    await store.addTaskDependency(scopeA, "task-child", "task-parent");

    expect(await store.listTaskDependencies(scopeA, "task-child")).toEqual(["task-foundation", "task-parent"]);
  });

  it("retrieves knowledge associated with the requested agent", async () => {
    await store.recordMemory({ ...memory(scopeA, "memory-agent-a"), agentId: "agent-a" });
    await store.recordMemory({ ...memory(scopeA, "memory-agent-b"), agentId: "agent-b" });

    expect((await store.listAgentKnowledge(scopeA, "agent-a")).map((hit) => hit.id)).toEqual(["memory-agent-a"]);
  });

  it("isolates tenants and projects for search, agent retrieval, and provenance", async () => {
    await store.recordMemory(memory(scopeA, "memory-isolated-a", "isolation needle"));
    await store.recordMemory(memory(scopeSameTenantOtherProject, "memory-isolated-b", "isolation needle"));
    await store.recordMemory(memory(scopeB, "memory-isolated-c", "isolation needle"));

    expect((await store.findKnowledge(scopeA, { text: "isolation" })).map((hit) => hit.id)).toEqual(["memory-isolated-a"]);
    expect(await store.findKnowledge(scopeSameTenantOtherProject, { text: "isolation" })).toHaveLength(1);
    expect(await store.findKnowledge(scopeB, { text: "isolation" })).toHaveLength(1);
    expect(await store.traceMemoryProvenance(scopeA, "memory-isolated-b")).toBeNull();
    expect(await store.traceMemoryProvenance(scopeA, "memory-isolated-c")).toBeNull();
    expect(await store.listAgentKnowledge(scopeA, "agent-1")).toHaveLength(1);
  });

  it("deletes one project deterministically without deleting another project", async () => {
    await store.recordMemory(memory(scopeA, "memory-cleanup-a", "cleanup marker"));
    await store.recordMemory(memory(scopeSameTenantOtherProject, "memory-cleanup-b", "cleanup marker"));

    await store.deleteProjectKnowledge(scopeA);

    expect(await store.findKnowledge(scopeA, { text: "cleanup" })).toEqual([]);
    expect(await store.findKnowledge(scopeSameTenantOtherProject, { text: "cleanup" })).toHaveLength(1);
  });
});

import type { DecisionInput, KnowledgeScope, MemoryInput } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectSurrealAgentKnowledgeStore } from "../../packages/storage-surrealdb/src/connect-agent-knowledge-store.ts";

const endpoint = process.env.AI_OFFICE_TEST_SURREALDB_URL;
const enabled = Boolean(endpoint);
const scopeA = { tenantId: "tenant-a", repositoryId: "repo-a" } satisfies KnowledgeScope;
const scopeSameTenantOtherProject = { tenantId: "tenant-a", repositoryId: "repo-b" } satisfies KnowledgeScope;
const scopeB = { tenantId: "tenant-b", repositoryId: "repo-b" } satisfies KnowledgeScope;
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

  it("bounds and orders scoped search with stable ties", async () => {
    for (const id of ["z", "b", "a", "c", "d", "e"]) {
      await store.recordMemory(memory(scopeA, `ordered-${id}`, "approval checkpoint"));
    }
    await store.recordDecision(decision(scopeA, "decision-ordered", "task-ordered", "approval checkpoint"));
    const hits = await store.findKnowledge(scopeA, { text: "approval", limit: 3 });
    expect(hits.map((hit) => [hit.kind, hit.id])).toEqual([
      ["decision", "decision-ordered"],
      ["memory", "ordered-a"],
      ["memory", "ordered-b"],
    ]);
    expect(hits.every((hit) => hit.tenantId === scopeA.tenantId && hit.repositoryId === scopeA.repositoryId)).toBe(true);
    expect(await store.findKnowledge(scopeSameTenantOtherProject, { text: "approval" })).toEqual([]);
    expect(await store.findKnowledge(scopeB, { text: "approval" })).toEqual([]);
  });

  it("rejects invalid search limits and blank queries instead of broadening the search", async () => {
    await expect(store.findKnowledge(scopeA, { text: "approval", limit: 6 })).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_QUERY" });
    await expect(store.findKnowledge(scopeA, { text: "" })).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_QUERY" });
    await expect(store.findKnowledge(scopeA, { text: "approval", agentId: " " })).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_QUERY" });
  });

  it("rejects a knowledge ID rewrite with conflicting provenance and keeps the original record", async () => {
    const original = memory(scopeA, "memory-immutable");
    await store.recordMemory(original);
    await expect(store.recordMemory({ ...original, runId: "run-rewritten", taskId: "task-rewritten", agentId: "agent-rewritten", source: { ...original.source, id: "source-rewritten" } })).rejects.toThrow();
    expect(await store.traceMemoryProvenance(scopeA, original.id)).toMatchObject({ runId: original.runId, taskId: original.taskId, agentId: original.agentId, source: original.source });
  });

  it("rejects a source ID reused with different provenance context and preserves its original context", async () => {
    const original = memory(scopeA, "memory-source-original");
    await store.recordMemory(original);
    const conflicting = { ...memory(scopeA, "memory-source-conflict"), source: original.source, runId: "run-conflict", taskId: "task-conflict", agentId: "agent-conflict" };
    await expect(store.recordMemory(conflicting)).rejects.toThrow();
    expect(await store.traceMemoryProvenance(scopeA, original.id)).toMatchObject({ runId: original.runId, taskId: original.taskId, agentId: original.agentId });
    expect(await store.traceMemoryProvenance(scopeA, conflicting.id)).toBeNull();
  });

  it("rejects decision ID rewrites, including text and title changes", async () => {
    const original = decision(scopeA, "decision-immutable", "task-immutable");
    await store.recordDecision(original);
    await expect(store.recordDecision({ ...original, title: "Changed title" })).rejects.toThrow();
    await expect(store.recordDecision({ ...original, text: "Changed text" })).rejects.toThrow();
    expect((await store.findKnowledge(scopeA, { text: "staged deployment" }))[0]).toMatchObject({ id: original.id, title: original.title, text: original.text });
  });

  it("rejects incomplete provenance before writing", async () => {
    const input = memory(scopeA, "memory-incomplete");
    await expect(store.recordMemory({ ...input, runId: " " })).rejects.toThrow(/provenance runId/);
    await expect(store.recordMemory({ ...input, tenantId: " " })).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_SCOPE" });
    await expect(store.findKnowledge({ tenantId: " ", repositoryId: scopeA.repositoryId }, { text: "approval" })).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_SCOPE" });
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

  it("rejects same-task violations and two-decision supersession cycles without changing edges", async () => {
    const a = decision(scopeA, "decision-cycle-a", "task-cycle");
    const b = decision(scopeA, "decision-cycle-b", "task-cycle");
    const otherTask = decision(scopeA, "decision-cycle-other-task", "task-other");
    await store.recordDecision(a);
    await store.recordDecision(b);
    await store.recordDecision(otherTask);
    await store.supersedeDecision(scopeA, a.id, b.id);

    await expect(store.supersedeDecision(scopeA, b.id, a.id)).rejects.toThrow();
    await expect(store.supersedeDecision(scopeA, a.id, otherTask.id)).rejects.toThrow();
    expect((await store.findCurrentDecisions(scopeA, a.taskId)).map((hit) => hit.id)).toEqual([a.id]);
    expect((await store.findCurrentDecisions(scopeA, otherTask.taskId)).map((hit) => hit.id)).toEqual([otherTask.id]);
  });

  it("rejects transitive supersession cycles", async () => {
    const a = decision(scopeA, "decision-chain-a", "task-chain");
    const b = decision(scopeA, "decision-chain-b", "task-chain");
    const c = decision(scopeA, "decision-chain-c", "task-chain");
    await store.recordDecision(a);
    await store.recordDecision(b);
    await store.recordDecision(c);
    await store.supersedeDecision(scopeA, a.id, b.id);
    await store.supersedeDecision(scopeA, b.id, c.id);

    await expect(store.supersedeDecision(scopeA, c.id, a.id)).rejects.toThrow();
    expect((await store.findCurrentDecisions(scopeA, a.taskId)).map((hit) => hit.id)).toEqual([a.id]);
  });

  it("keeps supersession edges scoped to the supplied tenant and project", async () => {
    const current = decision(scopeA, "cross-current", "cross-task");
    await store.recordDecision(current);
    await store.recordDecision(decision(scopeSameTenantOtherProject, "cross-prior", "cross-task"));
    await store.recordDecision(decision(scopeB, "cross-prior", "cross-task"));

    await expect(store.supersedeDecision(scopeA, current.id, "cross-prior")).rejects.toThrow();
    expect((await store.findCurrentDecisions(scopeA, current.taskId)).map((hit) => hit.id)).toEqual([current.id]);
    expect(await store.findCurrentDecisions(scopeSameTenantOtherProject, "cross-task")).toHaveLength(1);
    expect(await store.findCurrentDecisions(scopeB, "cross-task")).toHaveLength(1);
  });

  it("traverses task dependencies deterministically", async () => {
    await store.addTaskDependency(scopeA, "task-child", "task-parent");
    await store.addTaskDependency(scopeA, "task-child", "task-foundation");
    await store.addTaskDependency(scopeA, "task-child", "task-parent");

    expect(await store.listTaskDependencies(scopeA, "task-child")).toEqual(["task-foundation", "task-parent"]);
  });

  it("rejects two-task and transitive dependency cycles while preserving valid edges", async () => {
    await store.addTaskDependency(scopeA, "cycle-a", "cycle-b");
    await expect(store.addTaskDependency(scopeA, "cycle-b", "cycle-a")).rejects.toThrow();
    expect(await store.listTaskDependencies(scopeA, "cycle-a")).toEqual(["cycle-b"]);
    expect(await store.listTaskDependencies(scopeA, "cycle-b")).toEqual([]);

    await store.addTaskDependency(scopeA, "chain-a", "chain-b");
    await store.addTaskDependency(scopeA, "chain-b", "chain-c");
    await expect(store.addTaskDependency(scopeA, "chain-c", "chain-a")).rejects.toThrow();
    expect(await store.listTaskDependencies(scopeA, "chain-a")).toEqual(["chain-b"]);
    expect(await store.listTaskDependencies(scopeA, "chain-b")).toEqual(["chain-c"]);
    expect(await store.listTaskDependencies(scopeA, "chain-c")).toEqual([]);
  });

  it("keeps dependency edges scoped to the supplied tenant and project", async () => {
    await store.addTaskDependency(scopeSameTenantOtherProject, "shared-child", "shared-parent");
    await store.addTaskDependency(scopeB, "shared-child", "shared-parent");
    await store.addTaskDependency(scopeA, "shared-child", "shared-parent");

    expect(await store.listTaskDependencies(scopeA, "shared-child")).toEqual(["shared-parent"]);
    expect(await store.listTaskDependencies(scopeSameTenantOtherProject, "shared-child")).toEqual(["shared-parent"]);
    expect(await store.listTaskDependencies(scopeB, "shared-child")).toEqual(["shared-parent"]);
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

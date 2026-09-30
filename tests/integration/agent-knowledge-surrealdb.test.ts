import type { AgentKnowledgeStore, DecisionInput, KnowledgeScope, LegacyKnowledgeInput, MemoryInput } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { knowledgeCompatibilitySearchTerm } from "@ai-office/application/context/knowledge-search-term.ts";
import { deriveProjectMemoryIdentity } from "@ai-office/application/project-memory/project-memory-identity.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RecordId, Surreal } from "../../packages/storage-surrealdb/node_modules/surrealdb";
import { connectSurrealAgentKnowledgeStore } from "../../packages/storage-surrealdb/src/connect-agent-knowledge-store.ts";
import { ManageKnowledgeAdmission } from "../../packages/application/src/agent-knowledge/manage-knowledge-admission.ts";
import { ImportLegacyKnowledge } from "../../packages/application/src/agent-knowledge/import-legacy-knowledge.ts";
import type { ProjectRepository } from "../../packages/application/src/ports/project-repository.port.ts";
import type { TaskRepository } from "../../packages/application/src/ports/task-repository.port.ts";
import type { AgentRuntimeRepository } from "../../packages/application/src/ports/agent-runtime-repository.port.ts";
import type { RepositoryIdentityRepository } from "../../packages/application/src/ports/repository-identity-repository.port.ts";
import type { RecordAuditEvent } from "../../packages/application/src/commands/record-audit-event.ts";
import type { Clock } from "../../packages/application/src/ports/clock.port.ts";
import { createHash, randomUUID } from "node:crypto";
import { SurrealAgentKnowledgeStoreImpl } from "../../packages/storage-surrealdb/src/surreal-agent-knowledge.store.ts";

const endpoint = process.env.AI_OFFICE_TEST_SURREALDB_URL;
const enabled = Boolean(endpoint);
const scopeA = { tenantId: "tenant-a", repositoryId: "repo-a" } satisfies KnowledgeScope;
const scopeSameTenantOtherProject = { tenantId: "tenant-a", repositoryId: "repo-b" } satisfies KnowledgeScope;
const scopeB = { tenantId: "tenant-b", repositoryId: "repo-b" } satisfies KnowledgeScope;
let closeStore: () => Promise<void>;
let store: Awaited<ReturnType<typeof connectSurrealAgentKnowledgeStore>>["store"];
let db: Surreal;

it.skipIf(!enabled)("adds legacy storage to an existing v1 database without losing records", async () => {
  const upgradeDb = new Surreal();
  try {
    await upgradeDb.connect(endpoint!);
    await upgradeDb.signin({ username: "root", password: "root" });
    await upgradeDb.use({ namespace: "ai_office_test", database: `ak06_upgrade_${randomUUID().replaceAll("-", "")}` });
    await upgradeDb.query("DEFINE TABLE knowledge_agent SCHEMAFULL TYPE NORMAL; DEFINE FIELD tenant_id ON knowledge_agent TYPE string; DEFINE FIELD project_id ON knowledge_agent TYPE string; DEFINE FIELD external_id ON knowledge_agent TYPE string;");
    await upgradeDb.query("CREATE knowledge_agent:existing CONTENT { tenant_id: 'tenant-a', project_id: 'repo-a', external_id: 'agent-existing' };");
    const upgraded = await SurrealAgentKnowledgeStoreImpl.create(upgradeDb);
    await upgraded.recordLegacyMemory({ ...scopeA, id: "ak_legacy_upgrade", text: "Retained legacy note",
      sourceScope: "aio-0123456789abcdef0123456789abcdef", sourceKey: "notes/old",
      sourceSha256: `sha256:${createHash("sha256").update("Retained legacy note").digest("hex")}`,
      importedAt: new Date("2026-09-30T12:00:00.000Z") });
    expect((await upgradeDb.query("SELECT external_id FROM knowledge_agent WHERE external_id = 'agent-existing'"))[0])
      .toEqual([{ external_id: "agent-existing" }]);
    expect((await upgraded.traceLegacyMemory(scopeA, "ak_legacy_upgrade"))?.text).toBe("Retained legacy note");
  } finally {
    await upgradeDb.close();
  }
});

function record(scope: KnowledgeScope, kind: string, id: string): RecordId {
  return new RecordId(kind, encodeURIComponent(JSON.stringify([scope.tenantId, scope.repositoryId, kind.replace(/^knowledge_/, ""), id])));
}

function provenanceEdge(scope: KnowledgeScope, edge: "derived_from" | "based_on", kind: "memory" | "decision", id: string): RecordId {
  return new RecordId(edge, encodeURIComponent(JSON.stringify([scope.tenantId, scope.repositoryId, kind, id])));
}

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
    db = new Surreal();
    await db.connect(endpoint!);
    await db.signin({ username: "root", password: "root" });
    await db.use({ namespace: "ai_office_test", database: "agent_knowledge" });
  });

  afterEach(async () => {
    await store.deleteProjectKnowledge(scopeA);
    await store.deleteProjectKnowledge(scopeSameTenantOtherProject);
    await store.deleteProjectKnowledge(scopeB);
  });

  afterAll(async () => {
    await closeStore?.();
    await db?.close();
  });

  it("admits a completed worker result through the application, traces it, and reconciles an exact retry", async () => {
    const events: Array<Parameters<RecordAuditEvent["execute"]>[0]> = [];
    let failNextRecorded = false;
    const service = new ManageKnowledgeAdmission(
      { findById: async () => ({}) } as unknown as ProjectRepository,
      {
        findById: async () => ({
          snapshot: () => ({ projectId: "project-1" }),
        }),
      } as unknown as TaskRepository,
      {
        findRun: async () => ({
          snapshot: () => ({
            id: "run-ak05",
            projectId: "project-1",
            taskId: "task-ak05",
            agentId: "agent-ak05",
            status: "completed",
            completedAt: new Date("2026-09-30T10:00:00.000Z"),
            execution: { kind: "worker" },
            result: { summary: "Verified result" },
          }),
        }),
        findAgent: async () => ({ id: "agent-ak05", projectId: "project-1" }),
      } as unknown as AgentRuntimeRepository,
      {
        findRepositoryId: async () => scopeA.repositoryId,
      } as unknown as RepositoryIdentityRepository,
      { state: "connected", tenantId: scopeA.tenantId, store },
      {
        execute: async (event: Parameters<RecordAuditEvent["execute"]>[0]) => {
          events.push(event);
          if (
            failNextRecorded &&
            event.eventType === "knowledge.admission.recorded"
          ) {
            failNextRecorded = false;
            throw new Error("audit backend secret");
          }
          return "audit-ak05";
        },
      } as unknown as RecordAuditEvent,
      { now: () => new Date("2026-09-30T11:00:00.000Z") } as Clock,
    );
    const input = {
      projectId: "project-1",
      runId: "run-ak05",
      kind: "memory" as const,
      text: "Use the verified rollout",
    };
    const plan = await service.plan(input);
    expect(plan.id).toBe(`ak_${plan.planHash}`);
    expect(plan.source.locator).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await store.traceMemoryProvenance(scopeA, plan.id)).toBeNull();
    expect(
      await service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).toEqual({ ...plan, outcome: "recorded" });
    expect(
      await service.trace(input.projectId, "memory", plan.id),
    ).toMatchObject({
      runId: plan.runId,
      taskId: plan.taskId,
      agentId: plan.agentId,
      source: plan.source,
      knowledge: { id: plan.id, text: plan.text, source: plan.source },
    });
    expect(
      await service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).toEqual({ ...plan, outcome: "reconciled" });
    expect(
      await db.select(record(scopeA, "knowledge_memory", plan.id)),
    ).not.toBeNull();
    await expect(
      service.admit({
        ...input,
        text: "Changed",
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_MISMATCH" });
    await expect(
      store.recordMemory({
        ...scopeA,
        id: plan.id,
        text: "Changed",
        runId: plan.runId,
        taskId: plan.taskId,
        agentId: plan.agentId,
        source: plan.source,
        createdAt: new Date(plan.createdAt),
      }),
    ).rejects.toThrow();
    const uncertainInput = { ...input, text: "Verified but unaudited rollout" };
    const uncertainPlan = await service.plan(uncertainInput);
    failNextRecorded = true;
    await expect(
      service.admit({
        ...uncertainInput,
        approval: uncertainPlan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_ADMISSION_RECONCILIATION_REQUIRED",
    });
    expect(
      await store.traceMemoryProvenance(scopeA, uncertainPlan.id),
    ).toMatchObject({
      knowledge: { id: uncertainPlan.id, text: uncertainPlan.text },
      source: uncertainPlan.source,
    });
    expect(
      await service.admit({
        ...uncertainInput,
        approval: uncertainPlan.planHash,
        reviewedBy: "operator",
      }),
    ).toEqual({ ...uncertainPlan, outcome: "reconciled" });
    await expect(
      service.admit({
        ...uncertainInput,
        text: "Changed again",
        approval: uncertainPlan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_MISMATCH" });
    expect(events.map((event) => event.eventType)).toEqual([
      "knowledge.admission.approved",
      "knowledge.admission.recorded",
      "knowledge.admission.approved",
      "knowledge.admission.recorded",
      "knowledge.admission.approved",
      "knowledge.admission.recorded",
      "knowledge.admission.approved",
      "knowledge.admission.recorded",
    ]);
    expect(JSON.stringify(events)).not.toContain(input.text);
    expect(JSON.stringify(events)).not.toContain(uncertainInput.text);
  });

  it("rejects blank, padded, oversized, and runtime-invalid retrieval IDs", async () => {
    const calls = [
      (id: string) => store.traceMemoryProvenance(scopeA, id),
      (id: string) => store.traceDecisionProvenance(scopeA, id),
      (id: string) => store.findCurrentDecisions(scopeA, id),
      (id: string) => store.listTaskDependencies(scopeA, id),
      (id: string) => store.listAgentKnowledge(scopeA, id),
    ];
    for (const call of calls) {
      for (const id of ["", " ", " padded", "padded ", "x".repeat(257), 17, null]) {
        await expect(call(id as string)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_QUERY" });
      }
    }
    for (const id of ["", " padded", "x".repeat(257), 17]) {
      await expect(store.supersedeDecision(scopeA, id as string, "prior")).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_QUERY" });
      await expect(store.addTaskDependency(scopeA, "task", id as string)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_QUERY" });
    }
  });

  it("distinguishes absent knowledge from malformed persisted base rows", async () => {
    expect(await store.traceMemoryProvenance(scopeA, "missing-memory")).toBeNull();
    expect(await store.traceDecisionProvenance(scopeA, "missing-decision")).toBeNull();
    const m = memory(scopeA, "malformed-memory");
    const d = decision(scopeA, "malformed-decision", "task-malformed");
    await store.recordMemory(m);
    await store.recordDecision(d);
    await db.query("UPDATE $record SET source_id = 'wrong-source'", { record: record(scopeA, "knowledge_memory", m.id) });
    await db.query("UPDATE $record SET source_id = 'wrong-source'", { record: record(scopeA, "knowledge_decision", d.id) });
    await expect(store.traceMemoryProvenance(scopeA, m.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    await expect(store.traceDecisionProvenance(scopeA, d.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
  });

  it("rejects missing, cross-scope, and ambiguous provenance relations", async () => {
    const m = memory(scopeA, "graph-memory");
    const d = decision(scopeA, "graph-decision", "graph-task");
    await store.recordMemory(m);
    await store.recordDecision(d);
    expect(await store.traceMemoryProvenance(scopeA, m.id)).toMatchObject({ runId: m.runId });
    expect(await store.traceDecisionProvenance(scopeA, d.id)).toMatchObject({ runId: d.runId });

    const memoryEdge = provenanceEdge(scopeA, "derived_from", "memory", m.id);
    const decisionEdge = provenanceEdge(scopeA, "based_on", "decision", d.id);
    await db.query("DELETE FROM derived_from WHERE id = $record", { record: memoryEdge });
    await db.query("DELETE FROM based_on WHERE id = $record", { record: decisionEdge });
    await expect(store.traceMemoryProvenance(scopeA, m.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    await expect(store.traceDecisionProvenance(scopeA, d.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });

    await store.recordMemory(m);
    await store.recordDecision(d);
    await db.query("UPDATE $record SET tenant_id = 'tenant-b'", { record: memoryEdge });
    await db.query("UPDATE $record SET tenant_id = 'tenant-b'", { record: decisionEdge });
    await expect(store.traceMemoryProvenance(scopeA, m.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    await expect(store.traceDecisionProvenance(scopeA, d.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    await db.query("UPDATE $record SET tenant_id = 'tenant-a'", { record: memoryEdge });
    await db.query("UPDATE $record SET tenant_id = 'tenant-a'", { record: decisionEdge });

    const other = memory(scopeA, "graph-other");
    await store.recordMemory(other);
    await db.query("RELATE $from->derived_from->$to SET tenant_id = $tenant, project_id = $project", {
      from: record(scopeA, "knowledge_memory", m.id), to: record(scopeA, "knowledge_source", other.source.id),
      tenant: scopeA.tenantId, project: scopeA.repositoryId,
    });
    await expect(store.traceMemoryProvenance(scopeA, m.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
  });

  it("rejects cross-scope provenance nodes and dependency targets", async () => {
    const m = memory(scopeA, "cross-node-memory");
    await store.recordMemory(m);
    const source = record(scopeA, "knowledge_source", m.source.id);
    await db.query("UPDATE $record SET project_id = 'repo-b'", { record: source });
    await expect(store.traceMemoryProvenance(scopeA, m.id)).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
    await db.query("UPDATE $record SET project_id = 'repo-a'", { record: source });

    await store.addTaskDependency(scopeA, "local-child", "local-parent");
    await store.addTaskDependency(scopeB, "foreign-child", "foreign-parent");
    await db.query("RELATE $from->depends_on->$to SET tenant_id = $tenant, project_id = $project", {
      from: record(scopeA, "knowledge_task", "local-child"),
      to: record(scopeB, "knowledge_task", "foreign-parent"),
      tenant: scopeA.tenantId, project: scopeA.repositoryId,
    });
    await expect(store.listTaskDependencies(scopeA, "local-child")).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
  });

  it("initializes the versioned schema repeatedly and records idempotent provenance-backed memory", async () => {
    const input = memory(scopeA, "memory-basic");
    await store.recordMemory(input);
    await store.recordMemory(input);

    const hits = await store.findKnowledge(scopeA, { text: "approval" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: input.id, kind: "memory", source: input.source, agentId: input.agentId });
  });

  it("applies the global top-N order across memories and decisions despite reverse insertion", async () => {
    const at = (hour: number) => new Date(`2026-09-27T${String(hour).padStart(2, "0")}:00:00.000Z`);
    const candidates = [
      { kind: "memory", id: "ordered-old", hour: 9 },
      { kind: "decision", id: "ordered-lower", hour: 11 },
      { kind: "memory", id: "memory-b", hour: 12 },
      { kind: "memory", id: "memory-a", hour: 12 },
      { kind: "decision", id: "decision-b", hour: 12 },
      { kind: "decision", id: "decision-a", hour: 12 },
      { kind: "decision", id: "ordered-newer", hour: 13 },
      { kind: "memory", id: "ordered-newest", hour: 14 },
    ] as const;
    for (const candidate of candidates) {
      if (candidate.kind === "memory") {
        await store.recordMemory({ ...memory(scopeA, candidate.id, "approval checkpoint"), createdAt: at(candidate.hour) });
      } else {
        await store.recordDecision({ ...decision(scopeA, candidate.id, `task-${candidate.id}`, "approval checkpoint"), createdAt: at(candidate.hour) });
      }
    }
    const hits = await store.findKnowledge(scopeA, { text: "approval", limit: 5 });
    expect(hits.map((hit) => [hit.kind, hit.id])).toEqual([
      ["memory", "ordered-newest"],
      ["decision", "ordered-newer"],
      ["decision", "decision-a"],
      ["decision", "decision-b"],
      ["memory", "memory-a"],
    ]);
    expect(hits.every((hit) => hit.tenantId === scopeA.tenantId && hit.repositoryId === scopeA.repositoryId)).toBe(true);
    expect(await store.findKnowledge(scopeSameTenantOtherProject, { text: "approval" })).toEqual([]);
    expect(await store.findKnowledge(scopeB, { text: "approval" })).toEqual([]);
  });

  it("retrieves the CairnKeep compatibility term as a case-insensitive literal", async () => {
    const input = memory(scopeA, "term-memory", "The DePlOy requires approval");
    await store.recordMemory(input);
    await store.recordMemory(memory(scopeSameTenantOtherProject, "other-term", "deploy elsewhere"));
    const term = knowledgeCompatibilitySearchTerm("Document the deploy flow");
    expect(term).toBe("deploy");
    expect((await store.findKnowledge(scopeA, { text: term, agentId: input.agentId })).map((hit) => hit.id))
      .toEqual([input.id]);
    expect(await store.findKnowledge(scopeA, { text: "document the deploy flow" })).toEqual([]);
    expect(await store.findKnowledge(scopeA, { text: term, agentId: "other-agent" })).toEqual([]);
    expect(await store.findKnowledge(scopeA, { text: term, agentId: "AGENT-1" })).toEqual([]);
    expect(await store.findKnowledge(scopeB, { text: term })).toEqual([]);
  });

  it("agrees with SurrealDB Unicode lowercase for literal retrieval", async () => {
    const examples = [
      { id: "dotted-i", text: "İSTANBUL migration", query: "İSTANBUL" },
      { id: "final-sigma", text: "ΟΣ", query: "ΟΣ" },
      { id: "capital-sharp-s", text: "ẞtraße", query: "ẞtraße" },
      { id: "kelvin", text: "Kelvin", query: "Kelvin" },
      { id: "deseret", text: "𐐀𐐁𐐂", query: "𐐀𐐁𐐂" },
      { id: "accent", text: "Résumé", query: "RÉSUMÉ" },
    ] as const;
    for (const example of examples) {
      await store.recordMemory(memory(scopeA, `unicode-${example.id}`, example.text));
      const term = knowledgeCompatibilitySearchTerm(example.query);
      expect((await store.findKnowledge(scopeA, { text: term })).map((hit) => hit.id))
        .toEqual([`unicode-${example.id}`]);
    }
    expect(await store.findKnowledge(scopeA, { text: "οσ" })).toEqual([]);
    expect(await store.findKnowledge(scopeA, { text: "resume" })).toEqual([]);
    expect(await store.findKnowledge(scopeA, { text: "sstrasse" })).toEqual([]);
  });

  it("rejects a search row whose persisted identity disagrees with its scoped record ID", async () => {
    const input = memory(scopeA, "tampered-search", "approval checkpoint");
    await store.recordMemory(input);
    await db.query("UPDATE $record SET external_id = 'rewritten'", {
      record: record(scopeA, "knowledge_memory", input.id),
    });
    await expect(store.findKnowledge(scopeA, { text: "approval" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_RESULT" });
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
    expect((await store.findKnowledge(scopeA, { text: "deployment" })).map((hit) => hit.id))
      .toEqual([current.id, old.id]);
    for (const foreignScope of [scopeSameTenantOtherProject, scopeB]) {
      await store.recordDecision(decision(foreignScope, old.id, old.taskId));
      await store.recordDecision(decision(foreignScope, current.id, old.taskId));
      await store.supersedeDecision(foreignScope, current.id, old.id);
    }
    expect((await store.findKnowledge(scopeA, { text: "deployment" })).map((hit) => hit.id))
      .toEqual([current.id, old.id]);
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

  it("imports immutable legacy memory without inventing run provenance and isolates its scope", async () => {
    const input = { ...scopeA, id: "ak_legacy_one", text: "Legacy deployment note",
      sourceScope: "aio-0123456789abcdef0123456789abcdef", sourceKey: "notes/deploy",
      sourceSha256: `sha256:${createHash("sha256").update("Legacy deployment note").digest("hex")}`,
      importedAt: new Date("2026-09-30T12:00:00.000Z") };
    expect(await store.recordLegacyMemory(input)).toBe("recorded");
    expect(await store.recordLegacyMemory({ ...input, importedAt: new Date("2026-10-01T12:00:00.000Z") })).toBe("existing");
    expect(await store.traceLegacyMemory(scopeA, input.id)).toMatchObject({
      text: input.text, runId: null, taskId: null, agentId: null,
      legacy: { sourceScope: input.sourceScope, sourceKey: input.sourceKey,
        sourceSha256: input.sourceSha256 },
    });
    expect((await store.findKnowledge(scopeA, { text: "deployment" })).map((hit) => hit.id)).toEqual([input.id]);
    expect(await store.findKnowledge(scopeA, { text: "deployment", agentId: "agent-1" })).toEqual([]);
    expect(await store.traceLegacyMemory(scopeSameTenantOtherProject, input.id)).toBeNull();
    await expect(store.recordLegacyMemory({ ...input, text: "Rewritten" })).rejects.toThrow();
    expect((await store.traceLegacyMemory(scopeA, input.id))?.text).toBe(input.text);
    await store.deleteProjectKnowledge(scopeA);
    expect(await store.traceLegacyMemory(scopeA, input.id)).toBeNull();
  });

  it("reports concurrent exact imports honestly and reconciles the one immutable record on explicit retry", async () => {
    const expectedScope = deriveProjectMemoryIdentity(scopeA.repositoryId).memoryProjectId;
    const events: string[] = [];
    let prechecks = 0;
    const recordLegacyMemory = vi.fn((input: LegacyKnowledgeInput) => store.recordLegacyMemory(input));
    const raceStore = {
      recordLegacyMemory,
      traceLegacyMemory: (scope: KnowledgeScope, id: string) =>
        ++prechecks <= 2 ? Promise.resolve(null) : store.traceLegacyMemory(scope, id),
    } as unknown as AgentKnowledgeStore;
    const makeService = (importedAt: Date) => new ImportLegacyKnowledge(
      { findById: async () => ({ id: "project-1" }) } as unknown as ProjectRepository,
      { findRepositoryId: async () => scopeA.repositoryId } as unknown as RepositoryIdentityRepository,
      { readNamedScope: async () => [{ key: "parallel", value: "Concurrent legacy record" }] },
      { state: "connected", tenantId: scopeA.tenantId, store: raceStore },
      { execute: async (event: Parameters<RecordAuditEvent["execute"]>[0]) => {
        events.push(event.eventType); return "audit-ak06";
      } } as unknown as RecordAuditEvent,
      { now: () => importedAt } as Clock,
    );
    const first = makeService(new Date("2026-09-30T12:00:00.000Z"));
    const second = makeService(new Date("2026-10-01T12:00:00.000Z"));
    const plan = await first.plan("project-1", expectedScope);
    const request = { projectId: "project-1", sourceScope: expectedScope, approval: plan.planHash, reviewedBy: "operator" };
    const outcomes = await Promise.allSettled([first.import(request), second.import(request)]);
    const successful = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
    const failed = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
    expect(failed.every((error: unknown) => typeof error === "object" && error !== null &&
      "code" in error && error.code === "KNOWLEDGE_LEGACY_IMPORT_OUTCOME_UNKNOWN")).toBe(true);
    expect(successful.reduce((sum, outcome) => sum + outcome.imported, 0)).toBeLessThanOrEqual(1);
    expect(successful.every((outcome) => outcome.imported + outcome.reconciled === 1)).toBe(true);
    expect(recordLegacyMemory).toHaveBeenCalledTimes(2);
    const hit = await store.traceLegacyMemory(scopeA, plan.entries[0]!.id);
    expect(hit?.text).toBe("Concurrent legacy record");
    const originalTimestamp = hit?.createdAt.getTime();
    const rows = await db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM knowledge_legacy_memory WHERE tenant_id = $tenant AND project_id = $project AND external_id = $id",
      { tenant: scopeA.tenantId, project: scopeA.repositoryId, id: plan.entries[0]!.id },
    );
    expect(rows[0]).toHaveLength(1);
    expect(await first.import(request)).toMatchObject({ imported: 0, reconciled: 1 });
    expect(recordLegacyMemory).toHaveBeenCalledTimes(2);
    expect((await store.traceLegacyMemory(scopeA, plan.entries[0]!.id))?.createdAt.getTime()).toBe(originalTimestamp);
    expect(events.filter((event) => event === "knowledge.legacy_import.approved")).toHaveLength(3);
  });

  it.each([
    ["oversized matching digest", "oversize " + "😀".repeat(4_001), true],
    ["malformed digest", "oversize malformed", false],
  ])("rejects directly seeded legacy %s through trace and bounded retrieval", async (_case, text, matchingDigest) => {
    const id = `ak_legacy_malformed_${matchingDigest ? "size" : "digest"}`;
    await db.query("CREATE $record CONTENT $content", { record: record(scopeA, "knowledge_legacy_memory", id), content: {
      tenant_id: scopeA.tenantId, project_id: scopeA.repositoryId, external_id: id,
      text, source_scope: "aio-0123456789abcdef0123456789abcdef", source_key: "notes/bad",
      source_sha256: `sha256:${matchingDigest ? createHash("sha256").update(text).digest("hex") : "0".repeat(64)}`,
      imported_at: new Date("2026-09-30T12:00:00.000Z"),
    } });
    await expect(store.traceLegacyMemory(scopeA, id)).rejects.toMatchObject({
      code: "KNOWLEDGE_INVALID_RESULT", message: "KNOWLEDGE_INVALID_RESULT",
    });
    await expect(store.findKnowledge(scopeA, { text: "oversize", limit: 1 })).rejects.toMatchObject({
      code: "KNOWLEDGE_INVALID_RESULT", message: "KNOWLEDGE_INVALID_RESULT",
    });
  });

  it("deletes one project deterministically without deleting another project", async () => {
    await store.recordMemory(memory(scopeA, "memory-cleanup-a", "cleanup marker"));
    await store.recordMemory(memory(scopeSameTenantOtherProject, "memory-cleanup-b", "cleanup marker"));

    await store.deleteProjectKnowledge(scopeA);

    expect(await store.findKnowledge(scopeA, { text: "cleanup" })).toEqual([]);
    expect(await store.findKnowledge(scopeSameTenantOtherProject, { text: "cleanup" })).toHaveLength(1);
  });
});

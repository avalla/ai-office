import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeAdmissionError,
  ManageKnowledgeAdmission,
} from "../../packages/application/src/agent-knowledge/manage-knowledge-admission.ts";
import type {
  AgentKnowledgeStore,
  KnowledgeProvenance,
  RuntimeAgentKnowledge,
} from "../../packages/application/src/ports/agent-knowledge-store.port.ts";
import type { AgentRuntimeRepository } from "../../packages/application/src/ports/agent-runtime-repository.port.ts";
import type { ProjectRepository } from "../../packages/application/src/ports/project-repository.port.ts";
import type { TaskRepository } from "../../packages/application/src/ports/task-repository.port.ts";
import type { RepositoryIdentityRepository } from "../../packages/application/src/ports/repository-identity-repository.port.ts";
import type { RecordAuditEvent } from "../../packages/application/src/commands/record-audit-event.ts";
import type { Clock } from "../../packages/application/src/ports/clock.port.ts";

const completedAt = new Date("2026-09-30T10:00:00.000Z");

function fixture(
  overrides: {
    runStatus?: string;
    executionKind?: string;
    taskProjectId?: string;
    knowledge?: RuntimeAgentKnowledge;
  } = {},
) {
  const append = vi.fn(
    async (_input: Parameters<RecordAuditEvent["execute"]>[0]) => "audit-1",
  );
  const recordMemory = vi.fn(async () => {});
  const recordDecision = vi.fn(async () => {});
  const traceMemoryProvenance = vi.fn(
    async (): Promise<KnowledgeProvenance | null> => null,
  );
  const traceDecisionProvenance = vi.fn(
    async (): Promise<KnowledgeProvenance | null> => null,
  );
  const store = {
    recordMemory,
    recordDecision,
    traceMemoryProvenance,
    traceDecisionProvenance,
  } as unknown as AgentKnowledgeStore;
  const knowledge = overrides.knowledge ?? {
    state: "connected" as const,
    tenantId: "tenant-1",
    store,
  };
  const service = new ManageKnowledgeAdmission(
    { findById: vi.fn(async () => ({})) } as unknown as ProjectRepository,
    {
      findById: vi.fn(async () => ({
        snapshot: () => ({ projectId: overrides.taskProjectId ?? "project-1" }),
      })),
    } as unknown as TaskRepository,
    {
      findRun: vi.fn(async () => ({
        snapshot: () => ({
          id: "run-1",
          projectId: "project-1",
          taskId: "task-1",
          agentId: "agent-1",
          status: overrides.runStatus ?? "completed",
          completedAt,
          execution: { kind: overrides.executionKind ?? "worker" },
          result: { summary: "Analysis" },
        }),
      })),
      findAgent: vi.fn(async () => ({ id: "agent-1", projectId: "project-1" })),
    } as unknown as AgentRuntimeRepository,
    {
      findRepositoryId: vi.fn(async () => "repo-1"),
    } as unknown as RepositoryIdentityRepository,
    knowledge,
    { execute: append } as unknown as RecordAuditEvent,
    { now: () => new Date("2026-09-30T11:00:00.000Z") } as Clock,
  );
  return {
    service,
    append,
    recordMemory,
    recordDecision,
    traceMemoryProvenance,
    traceDecisionProvenance,
  };
}

function trace(
  plan: Awaited<ReturnType<ManageKnowledgeAdmission["plan"]>>,
): KnowledgeProvenance {
  const source = plan.source;
  return {
    knowledge: {
      tenantId: "tenant-1",
      repositoryId: plan.repositoryId,
      id: plan.id,
      kind: plan.kind,
      text: plan.text,
      title: plan.title,
      agentId: plan.agentId,
      runId: plan.runId,
      taskId: plan.taskId,
      source,
      createdAt: new Date(plan.createdAt),
    },
    source,
    runId: plan.runId,
    taskId: plan.taskId,
    agentId: plan.agentId,
  };
}

describe("governed knowledge admission", () => {
  it("plans an exact completed-run memory without a write, then admits only that approved content", async () => {
    const f = fixture();
    const input = {
      projectId: "project-1",
      runId: "run-1",
      kind: "memory" as const,
      text: "Use the staged rollout",
    };
    const plan = await f.service.plan(input);
    expect(plan.id).toBe(`ak_${plan.planHash}`);
    expect(plan.source).toMatchObject({
      kind: "run",
      id: "run-1",
      label: "Agent run run-1",
    });
    expect(plan.source.locator).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(f.recordMemory).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();

    await expect(
      f.service.admit({
        ...input,
        text: "Use the direct rollout",
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_MISMATCH" });
    expect(f.recordMemory).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();

    f.traceMemoryProvenance.mockResolvedValue(trace(plan));
    await expect(
      f.service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).resolves.toEqual(plan);
    expect(f.recordMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: plan.id,
        tenantId: "tenant-1",
        repositoryId: "repo-1",
        runId: "run-1",
        taskId: "task-1",
      }),
    );
    expect(f.append.mock.calls.map(([event]) => event.eventType)).toEqual([
      "knowledge.admission.approved",
      "knowledge.admission.recorded",
    ]);
    expect(f.append.mock.calls[0]?.[0].actorId).toBe("operator");
    expect(JSON.stringify(f.append.mock.calls)).not.toContain(input.text);
  });

  it("requires completed and same-project provenance", async () => {
    const input = {
      projectId: "project-1",
      runId: "run-1",
      kind: "memory" as const,
      text: "A memory",
    };
    await expect(
      fixture({ runStatus: "reviewing" }).service.plan(input),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_RUN_NOT_COMPLETED" });
    await expect(
      fixture({ executionKind: "simulation" }).service.plan(input),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_RUN_NOT_COMPLETED" });
    await expect(
      fixture({ taskProjectId: "other" }).service.plan(input),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_PROVENANCE_UNAVAILABLE" });
    await expect(
      fixture({ knowledge: { state: "disabled" } }).service.plan(input),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_STORE_NOT_CONNECTED" });
  });

  it("records failure without body or backend details when the secondary write fails", async () => {
    const f = fixture();
    const input = {
      projectId: "project-1",
      runId: "run-1",
      kind: "decision" as const,
      title: "Staged rollout",
      text: "Never deploy everything at once",
    };
    const plan = await f.service.plan(input);
    f.recordDecision.mockRejectedValue(
      new Error("secret password at endpoint"),
    );
    await expect(
      f.service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toEqual(
      new KnowledgeAdmissionError("KNOWLEDGE_ADMISSION_FAILED"),
    );
    expect(f.append.mock.calls.map(([event]) => event.eventType)).toEqual([
      "knowledge.admission.approved",
      "knowledge.admission.failed",
    ]);
    expect(JSON.stringify(f.append.mock.calls)).not.toContain(input.text);
  });

  it("refuses a malformed provenance graph after the write", async () => {
    const f = fixture();
    const input = {
      projectId: "project-1",
      runId: "run-1",
      kind: "memory" as const,
      text: "A memory",
    };
    const plan = await f.service.plan(input);
    f.traceMemoryProvenance.mockResolvedValue({
      ...trace(plan),
      taskId: "other-task",
    });
    await expect(
      f.service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ADMISSION_FAILED" });
    expect(f.append.mock.calls.at(-1)?.[0].eventType).toBe(
      "knowledge.admission.failed",
    );
  });

  it("does not touch the secondary store when the prior audit append fails", async () => {
    const f = fixture();
    const input = {
      projectId: "project-1",
      runId: "run-1",
      kind: "memory" as const,
      text: "A memory",
    };
    const plan = await f.service.plan(input);
    f.append.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      f.service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toThrow("audit unavailable");
    expect(f.recordMemory).not.toHaveBeenCalled();
  });
});

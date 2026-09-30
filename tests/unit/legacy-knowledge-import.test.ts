import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ImportLegacyKnowledge } from "@ai-office/application/agent-knowledge/import-legacy-knowledge.ts";
import { deriveProjectMemoryIdentity } from "@ai-office/application/project-memory/project-memory-identity.ts";
import type {
  AgentKnowledgeStore,
  LegacyKnowledgeHit,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import type { LegacyMemoryReader } from "@ai-office/application/ports/legacy-memory-reader.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { RepositoryIdentityRepository } from "@ai-office/application/ports/repository-identity-repository.port.ts";
import type { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";

const projectId = "project-1";
const repositoryId = "repo-1";
const sourceScope = deriveProjectMemoryIdentity(repositoryId).memoryProjectId;
const now = new Date("2026-09-30T12:00:00.000Z");

function fixture() {
  let entries = [{ key: "decision/auth", value: "Use signed requests" }];
  const persisted = new Map<string, LegacyKnowledgeHit>();
  const readNamedScope = vi.fn(async () => entries);
  const recordLegacyMemory = vi.fn(
    async (input: {
      id: string;
      text: string;
      sourceScope: string;
      sourceKey: string;
      sourceSha256: string;
      tenantId: string;
      repositoryId: string;
      importedAt: Date;
    }) => {
      persisted.set(input.id, {
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        id: input.id,
        kind: "memory",
        text: input.text,
        title: null,
        agentId: null,
        runId: null,
        taskId: null,
        source: {
          id: input.sourceKey,
          kind: "external",
          label: "CairnKeep named scope",
          locator: input.sourceSha256,
        },
        createdAt: input.importedAt,
        legacy: {
          sourceScope: input.sourceScope,
          sourceKey: input.sourceKey,
          sourceSha256: input.sourceSha256,
        },
      });
    },
  );
  const traceLegacyMemory = vi.fn(
    async (_scope: unknown, id: string) => persisted.get(id) ?? null,
  );
  const auditExecute = vi.fn(async (_event: { eventType: string }) => ({}));
  const service = new ImportLegacyKnowledge(
    {
      findById: vi.fn(async () => ({ id: projectId })),
    } as unknown as ProjectRepository,
    {
      findRepositoryId: vi.fn(async () => repositoryId),
    } as unknown as RepositoryIdentityRepository,
    { readNamedScope } satisfies LegacyMemoryReader,
    {
      state: "connected",
      tenantId: "tenant-1",
      store: {
        recordLegacyMemory,
        traceLegacyMemory,
      } as unknown as AgentKnowledgeStore,
    },
    { execute: auditExecute } as unknown as RecordAuditEvent,
    { now: () => now } as Clock,
  );
  return {
    service,
    readNamedScope,
    recordLegacyMemory,
    traceLegacyMemory,
    auditExecute,
    persisted,
    setEntries: (value: typeof entries) => {
      entries = value;
    },
  };
}

describe("legacy knowledge import", () => {
  it("plans the exact named scope, records legacy origin, and reconciles an exact retry", async () => {
    const f = fixture();
    const plan = await f.service.plan(projectId, sourceScope);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      key: "decision/auth",
      text: "Use signed requests",
      sourceSha256: `sha256:${createHash("sha256").update("Use signed requests").digest("hex")}`,
    });
    expect(f.recordLegacyMemory).not.toHaveBeenCalled();
    expect(
      await f.service.import({
        projectId,
        sourceScope,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).toEqual({ planHash: plan.planHash, imported: 1, reconciled: 0 });
    expect(f.persisted.get(plan.entries[0]!.id)).toMatchObject({
      runId: null,
      taskId: null,
      agentId: null,
      legacy: { sourceScope, sourceKey: "decision/auth" },
    });
    expect(
      await f.service.import({
        projectId,
        sourceScope,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).toEqual({ planHash: plan.planHash, imported: 0, reconciled: 1 });
    expect(f.recordLegacyMemory).toHaveBeenCalledTimes(1);
    expect(f.auditExecute.mock.calls.map(([event]) => event.eventType)).toEqual(
      [
        "knowledge.legacy_import.approved",
        "knowledge.legacy_import.recorded",
        "knowledge.legacy_import.approved",
        "knowledge.legacy_import.recorded",
      ],
    );
  });

  it("rejects a guessed scope, changed source, and conflicting existing content", async () => {
    const f = fixture();
    await expect(f.service.plan(projectId, "project")).rejects.toMatchObject({
      code: "KNOWLEDGE_LEGACY_SCOPE_MISMATCH",
    });
    expect(f.readNamedScope).not.toHaveBeenCalled();
    const plan = await f.service.plan(projectId, sourceScope);
    f.setEntries([{ key: "decision/auth", value: "Changed" }]);
    await expect(
      f.service.import({
        projectId,
        sourceScope,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_MISMATCH" });
    expect(f.auditExecute).not.toHaveBeenCalled();
    f.setEntries([{ key: "decision/auth", value: "Use signed requests" }]);
    f.persisted.set(plan.entries[0]!.id, {
      tenantId: "tenant-1",
      repositoryId,
      id: plan.entries[0]!.id,
      kind: "memory",
      text: "conflict",
      title: null,
      agentId: null,
      runId: null,
      taskId: null,
      source: {
        id: "decision/auth",
        kind: "external",
        label: "CairnKeep named scope",
      },
      createdAt: now,
      legacy: {
        sourceScope,
        sourceKey: "decision/auth",
        sourceSha256: plan.entries[0]!.sourceSha256,
      },
    });
    await expect(
      f.service.import({
        projectId,
        sourceScope,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_LEGACY_IMPORT_CONFLICT" });
  });

  it("stops before the secondary write when approval auditing fails", async () => {
    const f = fixture();
    const plan = await f.service.plan(projectId, sourceScope);
    f.auditExecute.mockRejectedValueOnce(new Error("private database failure"));
    await expect(
      f.service.import({
        projectId,
        sourceScope,
        approval: plan.planHash,
        reviewedBy: "operator",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_AUDIT_FAILED" });
    expect(f.recordLegacyMemory).not.toHaveBeenCalled();
  });

  it("requires an explicit same-hash retry after an uncertain secondary write", async () => {
    const f = fixture();
    const plan = await f.service.plan(projectId, sourceScope);
    const original = f.recordLegacyMemory.getMockImplementation()!;
    f.recordLegacyMemory.mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error("remote reply lost");
    });
    const request = {
      projectId,
      sourceScope,
      approval: plan.planHash,
      reviewedBy: "operator",
    };
    await expect(f.service.import(request)).rejects.toMatchObject({
      code: "KNOWLEDGE_LEGACY_IMPORT_OUTCOME_UNKNOWN",
    });
    expect(f.auditExecute.mock.calls.map(([event]) => event.eventType)).toEqual(
      ["knowledge.legacy_import.approved", "knowledge.legacy_import.failed"],
    );
    expect(await f.service.import(request)).toMatchObject({
      imported: 0,
      reconciled: 1,
    });
    expect(f.recordLegacyMemory).toHaveBeenCalledTimes(1);
  });

  it("reconciles a verified record after final audit fails", async () => {
    const f = fixture();
    const plan = await f.service.plan(projectId, sourceScope);
    f.auditExecute
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const request = {
      projectId,
      sourceScope,
      approval: plan.planHash,
      reviewedBy: "operator",
    };
    await expect(f.service.import(request)).rejects.toMatchObject({
      code: "KNOWLEDGE_ADMISSION_RECONCILIATION_REQUIRED",
    });
    expect(await f.service.import(request)).toMatchObject({
      imported: 0,
      reconciled: 1,
    });
    expect(f.recordLegacyMemory).toHaveBeenCalledTimes(1);
  });
});

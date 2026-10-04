import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { RunContextAssembler } from "@ai-office/application/context/run-context-assembler.ts";
import {
  KnowledgeStoreError,
  type AgentKnowledgeStore,
  type KnowledgeHit,
  type NonRunKnowledgeHit,
  type RuntimeAgentKnowledge,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import type { ProjectMemoryRetrievalRecord } from "@ai-office/application/ports/project-memory-provenance-repository.port.ts";

const input = {
  runId: "run-1",
  projectId: "project-1",
  taskTitle: "Refactor the authentication middleware",
  taskDescription: null,
  roleKey: "developer",
  stageObjective: null,
};
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const hit: KnowledgeHit = {
  tenantId: "tenant-a",
  repositoryId: "repo-1",
  id: "decision-1",
  kind: "decision",
  text: "Authentication middleware should verify every request.",
  title: "Authentication policy",
  agentId: "agent-1",
  runId: "source-run",
  taskId: "source-task",
  source: { id: "source-task", kind: "task", label: "Original task" },
  createdAt: new Date("2026-09-28T00:00:00.000Z"),
};

function fixture(state: RuntimeAgentKnowledge) {
  const records: ProjectMemoryRetrievalRecord[] = [];
  const findRepositoryId = vi.fn<() => Promise<string | null>>(
    async () => "repo-1",
  );
  const recordRetrieval = vi.fn(
    async (record: ProjectMemoryRetrievalRecord) => {
      records.push(record);
    },
  );
  const findRetrieval = vi.fn(
    async (): Promise<ProjectMemoryRetrievalRecord | null> => null,
  );
  const assembler = new RunContextAssembler({
    clock: { now: () => new Date("2026-09-28T01:00:00.000Z") },
    agentKnowledge: {
      state,
      identities: {
        findRepositoryId,
        findProjectId: async () => null,
        associate: async () => "created",
      },
      provenance: {
        recordRetrieval,
        findRetrieval,
        findLatestRetrieval: async () => null,
      },
    },
  });
  return {
    assembler,
    records,
    findRepositoryId,
    recordRetrieval,
    findRetrieval,
  };
}

function connected(
  findKnowledge: AgentKnowledgeStore["findKnowledge"],
): RuntimeAgentKnowledge {
  return {
    state: "connected",
    tenantId: "tenant-a",
    store: { findKnowledge } as AgentKnowledgeStore,
  };
}

describe("native knowledge run context", () => {
  test("injects run, handover, and operator-confirmed knowledge alike as advisory context", async () => {
    const nonRun = { agentId: null, runId: null, taskId: null } as const;
    const fromHandover: NonRunKnowledgeHit = {
      ...hit,
      ...nonRun,
      id: "memory-handover",
      kind: "memory",
      title: null,
      text: "Authentication is terminated at the gateway.",
      source: { id: "confirmation-1", kind: "handover", label: "Review" },
      provenance: {
        kind: "handover",
        confirmationId: "confirmation-1",
        fingerprint: "f".repeat(64),
        scanId: null,
        confirmedAt: new Date("2026-09-27T00:00:00.000Z"),
      },
    };
    const fromOperator: NonRunKnowledgeHit = {
      ...hit,
      ...nonRun,
      id: "decision-operator",
      text: "Authentication tokens are never logged.",
      source: { id: "andrea", kind: "operator", label: "Operator" },
      provenance: {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [{ kind: "task", id: "task-9", label: "Task task-9" }],
      },
    };
    const f = fixture(
      connected(vi.fn(async () => [hit, fromHandover, fromOperator])),
    );
    const result = await f.assembler.assemble(input);
    expect(
      result.projectMemory?.results.map((entry) => entry.referenceId),
    ).toEqual(["decision-1", "memory-handover", "decision-operator"]);
    expect(f.records[0]).toMatchObject({ resultCount: 3, injectedCount: 3 });
  });

  test("disabled knowledge does not search or record provenance", async () => {
    const f = fixture({ state: "disabled" });
    expect(await f.assembler.assemble(input)).toEqual({ memory: [] });
    expect(f.findRepositoryId).not.toHaveBeenCalled();
    expect(f.recordRetrieval).not.toHaveBeenCalled();
  });

  test("uses trusted tenant and portable repository scope, then records exact query and bounded references", async () => {
    const findKnowledge = vi.fn(async () => [hit]);
    const f = fixture(connected(findKnowledge));
    const result = await f.assembler.assemble(input);
    expect(findKnowledge).toHaveBeenCalledWith(
      { tenantId: "tenant-a", repositoryId: "repo-1" },
      { text: "authentication", limit: 5 },
    );
    expect(result.projectMemory).toMatchObject({
      provider: "surrealdb",
      results: [
        { referenceId: "decision-1", scope: "decision", excerpt: hit.text },
      ],
    });
    expect(f.records).toEqual([
      expect.objectContaining({
        provider: "surrealdb",
        outcome: "retrieved",
        resultCount: 1,
        injectedCount: 1,
        contextQuerySha256: digest(input.taskTitle),
        providerQuerySha256: digest("authentication"),
        references: [
          expect.objectContaining({
            referenceId: "decision-1",
            scope: "decision",
            injected: true,
            contentDigest: `sha256:${digest(JSON.stringify([hit.title, hit.text]))}`,
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(f.records)).not.toContain(hit.text);
    expect(JSON.stringify(f.records)).not.toContain("authentication");
  });

  test("missing portable identity skips the search", async () => {
    const findKnowledge = vi.fn(async () => [hit]);
    const f = fixture(connected(findKnowledge));
    f.findRepositoryId.mockResolvedValueOnce(null);
    expect(await f.assembler.assemble(input)).toEqual({ memory: [] });
    expect(findKnowledge).not.toHaveBeenCalled();
    expect(f.records[0]).toMatchObject({
      outcome: "skipped",
      errorCode: "REPOSITORY_IDENTITY_UNAVAILABLE",
    });
  });

  test.each([
    ["empty", async () => [] as KnowledgeHit[], "empty", null],
    [
      "unavailable",
      async () => {
        throw new KnowledgeStoreError("KNOWLEDGE_QUERY_FAILED");
      },
      "failed",
      "KNOWLEDGE_QUERY_FAILED",
    ],
    [
      "wrong scope",
      async () => [{ ...hit, repositoryId: "other" }],
      "failed",
      "KNOWLEDGE_INVALID_RESULT",
    ],
    ["duplicate", async () => [hit, hit], "failed", "KNOWLEDGE_INVALID_RESULT"],
    [
      "control in ID",
      async () => [{ ...hit, id: "bad\nidentifier" }],
      "failed",
      "KNOWLEDGE_INVALID_RESULT",
    ],
  ])(
    "%s retrieval leaves no injected context and records its outcome",
    async (_label, findKnowledge, outcome, errorCode) => {
      const f = fixture(connected(findKnowledge));
      expect(await f.assembler.assemble(input)).toEqual({ memory: [] });
      expect(f.records[0]).toMatchObject({
        outcome,
        errorCode,
        resultCount: 0,
        injectedCount: 0,
        contextQuerySha256: digest(input.taskTitle),
        providerQuerySha256: digest("authentication"),
      });
    },
  );

  test("startup failure is recorded without consulting a store", async () => {
    const f = fixture({
      state: "unavailable",
      error: new KnowledgeStoreError("KNOWLEDGE_UNAVAILABLE"),
    });
    expect(await f.assembler.assemble(input)).toEqual({ memory: [] });
    expect(f.records[0]).toMatchObject({
      outcome: "failed",
      errorCode: "KNOWLEDGE_UNAVAILABLE",
    });
    expect(f.findRepositoryId).not.toHaveBeenCalled();
    expect(f.records[0]?.providerQuerySha256).toBeNull();
  });

  test("a synchronous store failure still records the attempted literal term", async () => {
    const f = fixture(
      connected(() => {
        throw new KnowledgeStoreError("KNOWLEDGE_QUERY_FAILED");
      }),
    );
    expect(await f.assembler.assemble(input)).toEqual({ memory: [] });
    expect(f.records[0]).toMatchObject({
      outcome: "failed",
      errorCode: "KNOWLEDGE_QUERY_FAILED",
      contextQuerySha256: digest(input.taskTitle),
      providerQuerySha256: digest("authentication"),
    });
  });

  test("sanitized title and excerpt are marked transformed while digest identifies the original", async () => {
    const altered = {
      ...hit,
      title: "Auth\u200bentication\npolicy",
      text: "Verify\u0000 every\u200b request.",
    };
    const f = fixture(connected(async () => [altered]));
    const result = await f.assembler.assemble(input);
    expect(result.projectMemory?.results).toEqual([
      expect.objectContaining({
        title: "Auth entication policy",
        excerpt: "Verify  every  request.",
        truncated: true,
      }),
    ]);
    expect(f.records[0]?.references).toEqual([
      expect.objectContaining({
        truncated: true,
        injected: true,
        contentDigest: `sha256:${digest(JSON.stringify([altered.title, altered.text]))}`,
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  test("sanitizing only the title still marks the injected reference transformed", async () => {
    const altered = { ...hit, title: "Auth\u200bentication policy" };
    const f = fixture(connected(async () => [altered]));
    const result = await f.assembler.assemble(input);
    expect(result.projectMemory?.results[0]).toMatchObject({
      title: "Auth entication policy",
      excerpt: hit.text,
      truncated: true,
    });
    expect(f.records[0]?.references[0]).toMatchObject({
      injected: true,
      truncated: true,
      contentDigest: `sha256:${digest(JSON.stringify([altered.title, altered.text]))}`,
    });
  });

  test("an existing retrieval row refuses another preparation", async () => {
    const findKnowledge = vi.fn(async () => [hit]);
    const f = fixture(connected(findKnowledge));
    f.findRetrieval.mockResolvedValueOnce({} as ProjectMemoryRetrievalRecord);
    await expect(f.assembler.assemble(input)).rejects.toMatchObject({
      code: "WORKER_CONTEXT_INVALID",
    });
    expect(findKnowledge).not.toHaveBeenCalled();
  });

  test("a provenance write failure suppresses knowledge injection", async () => {
    const f = fixture(connected(async () => [hit]));
    f.recordRetrieval.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    expect(await f.assembler.assemble(input)).toEqual({ memory: [] });
  });

  test("a competing provenance write refuses preparation", async () => {
    const f = fixture(connected(async () => [hit]));
    f.findRetrieval
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({} as ProjectMemoryRetrievalRecord);
    f.recordRetrieval.mockRejectedValueOnce(
      new Error("UNIQUE constraint failed"),
    );
    await expect(f.assembler.assemble(input)).rejects.toMatchObject({
      code: "WORKER_CONTEXT_INVALID",
    });
  });

  test("a stalled knowledge search times out without blocking the run", async () => {
    vi.useFakeTimers();
    try {
      let resolveSearch: (hits: KnowledgeHit[]) => void = () => {};
      const f = fixture(
        connected(
          () =>
            new Promise<KnowledgeHit[]>((resolve) => {
              resolveSearch = resolve;
            }),
        ),
      );
      const pending = f.assembler.assemble(input);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ memory: [] });
      expect(f.records[0]).toMatchObject({
        outcome: "failed",
        errorCode: "KNOWLEDGE_TIMEOUT",
        providerQuerySha256: digest("authentication"),
      });
      resolveSearch([hit]);
      await Promise.resolve();
      expect(f.records).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancellation records the failure and aborts preparation", async () => {
    const controller = new AbortController();
    const f = fixture(
      connected(async () => {
        controller.abort();
        return [hit];
      }),
    );
    await expect(
      f.assembler.assemble({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.records[0]).toMatchObject({
      outcome: "failed",
      errorCode: "KNOWLEDGE_CANCELLED",
      providerQuerySha256: digest("authentication"),
    });
  });

  test("cancellation before store invocation records no provider query", async () => {
    const controller = new AbortController();
    controller.abort();
    const findKnowledge = vi.fn(async () => [hit]);
    const f = fixture(connected(findKnowledge));
    await expect(
      f.assembler.assemble({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(findKnowledge).not.toHaveBeenCalled();
    expect(f.records[0]).toMatchObject({
      outcome: "failed",
      errorCode: "KNOWLEDGE_CANCELLED",
      contextQuerySha256: digest(input.taskTitle),
      providerQuerySha256: null,
    });
  });
});

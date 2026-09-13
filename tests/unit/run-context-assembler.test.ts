import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  RunContextAssembler,
  applyProjectMemoryBudget,
  deriveProjectMemoryQuery,
  projectMemoryNotice,
} from "@ai-office/application/context/run-context-assembler.ts";
import {
  DisabledProjectMemoryProvider,
  ProjectMemoryError,
  projectMemoryLimits,
  type ProjectMemoryHit,
  type ProjectMemoryProvider,
  type ProjectMemoryQuery,
} from "@ai-office/application/ports/project-memory-provider.port.ts";
import type {
  ProjectMemoryProvenanceRepository,
  ProjectMemoryRetrievalRecord,
} from "@ai-office/application/ports/project-memory-provenance-repository.port.ts";
import type { RepositoryIdentityRepository } from "@ai-office/application/ports/repository-identity-repository.port.ts";
import { deriveProjectMemoryIdentity } from "@ai-office/application/project-memory/project-memory-identity.ts";

const now = new Date("2026-09-13T00:00:00.000Z");
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const providerQuerySha256 = sha256("provider query");

function hit(index: number, excerpt = `excerpt ${index}`): ProjectMemoryHit {
  return {
    referenceId: `notes/${index}`,
    contentDigest: `sha256:${String(index).padStart(64, "0")}`,
    scope: "aio-scope",
    title: null,
    excerpt,
    truncated: false,
  };
}

function harness(
  search: ProjectMemoryProvider["search"],
  repositoryId: string | null = "repo_1",
) {
  const records: ProjectMemoryRetrievalRecord[] = [];
  const provider: ProjectMemoryProvider = {
    id: "fake",
    search: vi.fn(search),
    describe: () => ({
      provider: "fake",
      state: "configured",
      version: null,
      code: null,
      message: "",
    }),
    probe: async () => provider.describe(),
  };
  const identities: RepositoryIdentityRepository = {
    findProjectId: async () => null,
    findRepositoryId: async () => repositoryId,
    associate: async () => "created",
  };
  const provenance: ProjectMemoryProvenanceRepository = {
    recordRetrieval: async (record) => {
      records.push(record);
    },
    findRetrieval: async () => null,
    findLatestRetrieval: async () => null,
  };
  const assembler = new RunContextAssembler({
    clock: { now: () => now },
    projectMemory: { provider, identities, provenance },
  });
  return { assembler, provider, records };
}

const input = {
  runId: "run-1",
  projectId: "project-1",
  taskTitle: "  Harden   the login\nflow ",
  taskDescription: "Details stay out of the query",
  roleKey: "developer",
  stageObjective: null,
};

describe("run context assembly with optional project memory", () => {
  test("a disabled provider is never invoked and leaves no provenance", async () => {
    const provider = new DisabledProjectMemoryProvider();
    const search = vi.spyOn(provider, "search");
    const recordRetrieval = vi.fn();
    const findRepositoryId = vi.fn();
    const context = await new RunContextAssembler({
      clock: { now: () => now },
      projectMemory: {
        provider,
        identities: {
          findProjectId: vi.fn(),
          findRepositoryId,
          associate: vi.fn(),
        },
        provenance: {
          recordRetrieval,
          findRetrieval: vi.fn(async () => null),
          findLatestRetrieval: vi.fn(),
        },
      },
    }).assemble(input);
    expect(context).toEqual({ memory: [] });
    expect(search).not.toHaveBeenCalled();
    expect(findRepositoryId).not.toHaveBeenCalled();
    expect(recordRetrieval).not.toHaveBeenCalled();
  });

  test("performs exactly one bounded search keyed by the portable identity and records provenance", async () => {
    let received: ProjectMemoryQuery | undefined;
    const { assembler, provider, records } = harness(async (query) => {
      received = query;
      return {
        provider: { id: "fake", version: "9" },
        providerQuerySha256,
        hits: [hit(1), hit(2)],
      };
    });
    const context = await assembler.assemble(input);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(received).toMatchObject({
      identity: deriveProjectMemoryIdentity("repo_1"),
      text: "Harden the login flow",
      limit: projectMemoryLimits.maxResults,
    });
    expect(context.projectMemory).toEqual({
      provider: "fake",
      notice: projectMemoryNotice,
      results: [
        expect.objectContaining({ rank: 1, referenceId: "notes/1" }),
        expect.objectContaining({ rank: 2, referenceId: "notes/2" }),
      ],
    });
    expect(records).toEqual([
      expect.objectContaining({
        runId: "run-1",
        projectId: "project-1",
        outcome: "retrieved",
        memoryProjectId: deriveProjectMemoryIdentity("repo_1").memoryProjectId,
        providerVersion: "9",
        contextQuerySha256: sha256("Harden the login flow"),
        providerQuerySha256,
        resultCount: 2,
        injectedCount: 2,
        errorCode: null,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("excerpt 1");
    expect(JSON.stringify(records)).not.toContain("Harden");
  });

  test("an empty result continues without project memory context", async () => {
    const { assembler, records } = harness(async () => ({
      provider: { id: "fake", version: null },
      providerQuerySha256,
      hits: [],
    }));
    const context = await assembler.assemble(input);
    expect(context.projectMemory).toBeUndefined();
    expect(records[0]).toMatchObject({ outcome: "empty", resultCount: 0 });
  });

  test.each([
    new ProjectMemoryError("PROJECT_MEMORY_UNAVAILABLE"),
    new ProjectMemoryError("PROJECT_MEMORY_TIMEOUT"),
    new Error("unexpected provider bug with /secret/path"),
  ])(
    "a provider failure degrades to no memory and is recorded honestly (%s)",
    async (error) => {
      const { assembler, records } = harness(async () => {
        throw error;
      });
      const context = await assembler.assemble(input);
      expect(context).toEqual({ memory: [] });
      expect(records).toEqual([
        expect.objectContaining({
          outcome: "failed",
          errorCode:
            error instanceof ProjectMemoryError
              ? error.code
              : "PROJECT_MEMORY_FAILED",
          resultCount: 0,
          injectedCount: 0,
          references: [],
        }),
      ]);
    },
  );

  test("a provider returning out-of-contract hits is rejected rather than injected", async () => {
    const { assembler, records } = harness(async () => ({
      provider: { id: "fake", version: null },
      providerQuerySha256,
      hits: Array.from({ length: projectMemoryLimits.maxResults + 1 }, (_, i) =>
        hit(i),
      ),
    }));
    expect((await assembler.assemble(input)).projectMemory).toBeUndefined();
    expect(records[0]).toMatchObject({
      outcome: "failed",
      errorCode: "PROJECT_MEMORY_INVALID_RESPONSE",
    });
  });

  test("a project without a portable repository identity is skipped, never keyed by a local ID", async () => {
    const { assembler, provider, records } = harness(
      async () => ({
        provider: { id: "fake", version: null },
        providerQuerySha256,
        hits: [],
      }),
      null,
    );
    await assembler.assemble(input);
    expect(provider.search).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      outcome: "skipped",
      errorCode: "REPOSITORY_IDENTITY_UNAVAILABLE",
      memoryProjectId: null,
    });
  });

  test("cancellation during retrieval cancels preparation after recording it", async () => {
    const controller = new AbortController();
    const { assembler, records } = harness(async () => {
      controller.abort();
      throw new ProjectMemoryError("PROJECT_MEMORY_CANCELLED");
    });
    await expect(
      assembler.assemble({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(records[0]).toMatchObject({
      outcome: "failed",
      errorCode: "PROJECT_MEMORY_CANCELLED",
    });
  });
});

describe("run context assembly bounds and failure isolation", () => {
  test("a provenance write failure withholds memory but never fails the run", async () => {
    const { assembler, provider } = harness(async () => ({
      provider: { id: "fake", version: null },
      providerQuerySha256,
      hits: [hit(1)],
    }));
    const failing = new RunContextAssembler({
      clock: { now: () => now },
      projectMemory: {
        provider,
        identities: {
          findProjectId: async () => null,
          findRepositoryId: async () => "repo_1",
          associate: async () => "created",
        },
        provenance: {
          recordRetrieval: async () => {
            throw new Error("SQLITE_BUSY");
          },
          findRetrieval: async () => null,
          findLatestRetrieval: async () => null,
        },
      },
    });
    expect(await failing.assemble(input)).toEqual({ memory: [] });
    expect((await assembler.assemble(input)).projectMemory).toBeDefined();
  });

  test("without enough context bytes no search happens and the skip is recorded", async () => {
    const { assembler, provider, records } = harness(async () => ({
      provider: { id: "fake", version: null },
      providerQuerySha256,
      hits: [hit(1)],
    }));
    const context = await assembler.assemble({
      ...input,
      projectMemoryBytesAvailable: () =>
        projectMemoryLimits.minimumContextBytes - 1,
    });
    expect(context.projectMemory).toBeUndefined();
    expect(provider.search).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      outcome: "skipped",
      errorCode: "CONTEXT_BUDGET_EXHAUSTED",
    });
  });

  test("the serialized block never exceeds the available bytes, even for escape-heavy text", async () => {
    const escaped = "\u0001".repeat(1_200);
    const { assembler, records } = harness(async () => ({
      provider: { id: "fake", version: null },
      providerQuerySha256,
      hits: [hit(1, escaped), hit(2, escaped), hit(3, escaped)],
    }));
    const available = 12_000;
    const context = await assembler.assemble({
      ...input,
      projectMemoryBytesAvailable: () => available,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify(context.projectMemory),
    ).byteLength;
    expect(bytes).toBeLessThanOrEqual(available);
    expect(context.projectMemory?.results).toHaveLength(1);
    expect(records[0]?.references.map((value) => value.injected)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("exact query provenance and single preparation", () => {
  const refactor = {
    ...input,
    taskTitle: "Refactor the authentication middleware",
  };

  test("the context query and the provider's outbound query are digested separately and never stored", async () => {
    const { assembler, provider, records } = harness(async (query) => {
      // A provider-specific transformation, as CairnKeep performs.
      expect(query.text).toBe("Refactor the authentication middleware");
      return {
        provider: { id: "fake", version: null },
        providerQuerySha256: sha256("authentication"),
        hits: [hit(1)],
      };
    });
    await assembler.assemble(refactor);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({
        outcome: "retrieved",
        contextQuerySha256: sha256("Refactor the authentication middleware"),
        providerQuerySha256: sha256("authentication"),
      }),
    ]);
    expect(records[0]!.contextQuerySha256).not.toBe(
      records[0]!.providerQuerySha256,
    );
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("Refactor");
    expect(serialized).not.toContain("authentication");
  });

  test.each([
    ["missing", undefined],
    ["uppercase", sha256("authentication").toUpperCase()],
    ["short", "a".repeat(63)],
    ["prefixed", `sha256:${sha256("authentication")}`],
    ["non-string", 42],
  ])(
    "a %s provider query digest fails closed and injects nothing",
    async (_label, digest) => {
      const { assembler, records } = harness(
        async () =>
          ({
            provider: { id: "fake", version: null },
            providerQuerySha256: digest,
            hits: [hit(1)],
          }) as unknown as Awaited<ReturnType<ProjectMemoryProvider["search"]>>,
      );
      expect(
        (await assembler.assemble(refactor)).projectMemory,
      ).toBeUndefined();
      expect(records).toEqual([
        expect.objectContaining({
          outcome: "failed",
          errorCode: "PROJECT_MEMORY_INVALID_RESPONSE",
          contextQuerySha256: sha256("Refactor the authentication middleware"),
          providerQuerySha256: null,
          references: [],
        }),
      ]);
    },
  );

  test("a failed search keeps the context digest and reports no outbound digest", async () => {
    const { assembler, records } = harness(async () => {
      throw new ProjectMemoryError("PROJECT_MEMORY_TIMEOUT");
    });
    await assembler.assemble(refactor);
    expect(records[0]).toMatchObject({
      outcome: "failed",
      contextQuerySha256: sha256("Refactor the authentication middleware"),
      providerQuerySha256: null,
    });
  });

  test("a run that already has provenance is never prepared again", async () => {
    const { assembler, provider, records } = harness(async () => ({
      provider: { id: "fake", version: null },
      providerQuerySha256,
      hits: [hit(1)],
    }));
    const first = await assembler.assemble(input);
    expect(first.projectMemory).toBeDefined();
    const stored = records[0]!;
    const pinned = new RunContextAssembler({
      clock: { now: () => now },
      projectMemory: {
        provider,
        identities: {
          findProjectId: async () => null,
          findRepositoryId: async () => "repo_1",
          associate: async () => "created",
        },
        provenance: {
          recordRetrieval: async (record) => {
            records.push(record);
          },
          findRetrieval: async (runId) =>
            runId === stored.runId ? stored : null,
          findLatestRetrieval: async () => stored,
        },
      },
    });
    // Different context inputs would otherwise derive a different retrieval.
    await expect(
      pinned.assemble({ ...input, taskTitle: "Something else entirely" }),
    ).rejects.toMatchObject({
      name: "WorkerRuntimeError",
      code: "WORKER_CONTEXT_INVALID",
    });
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    // Other runs are unaffected.
    expect(
      (await pinned.assemble({ ...input, runId: "run-2" })).projectMemory,
    ).toBeDefined();
  });

  test("losing a provenance race to another preparation refuses instead of dispatching unattributed context", async () => {
    let stored: ProjectMemoryRetrievalRecord | null = null;
    const provider: ProjectMemoryProvider = {
      id: "fake",
      search: vi.fn(async () => ({
        provider: { id: "fake", version: null },
        providerQuerySha256,
        hits: [hit(1)],
      })),
      describe: () => ({
        provider: "fake",
        state: "configured",
        version: null,
        code: null,
        message: "",
      }),
      probe: async () => provider.describe(),
    };
    const assembler = new RunContextAssembler({
      clock: { now: () => now },
      projectMemory: {
        provider,
        identities: {
          findProjectId: async () => null,
          findRepositoryId: async () => "repo_1",
          associate: async () => "created",
        },
        provenance: {
          // Another preparation commits first while this search is in flight.
          recordRetrieval: async (record) => {
            stored = { ...record, contextQuerySha256: sha256("other") };
            throw new Error("UNIQUE constraint failed");
          },
          findRetrieval: async () => stored,
          findLatestRetrieval: async () => stored,
        },
      },
    });
    await expect(assembler.assemble(input)).rejects.toMatchObject({
      code: "WORKER_CONTEXT_INVALID",
    });
  });
});

describe("deterministic query and budget rules", () => {
  test("the query is the whitespace-normalized title bounded at a word boundary", () => {
    expect(
      deriveProjectMemoryQuery({ taskTitle: "a  b\tc", stageObjective: "x" }),
    ).toBe("a b c");
    expect(
      deriveProjectMemoryQuery({
        taskTitle: "  ",
        stageObjective: "Assess risk",
      }),
    ).toBe("Assess risk");
    expect(
      deriveProjectMemoryQuery({ taskTitle: " ", stageObjective: null }),
    ).toBeNull();
    const long = deriveProjectMemoryQuery({
      taskTitle: "word ".repeat(100),
      stageObjective: null,
    })!;
    expect(long.length).toBeLessThanOrEqual(
      projectMemoryLimits.queryCharacters,
    );
    expect(long.endsWith("word")).toBe(true);
  });

  test("excerpts respect per-result and total character limits in rank order", () => {
    const big = "é".repeat(5_000);
    const result = applyProjectMemoryBudget([
      hit(1, big),
      hit(2, big),
      hit(3, big),
      hit(4, "x".repeat(700)),
      hit(5, "tail"),
    ]);
    expect(result.injected.map((value) => [...value.excerpt].length)).toEqual([
      1_200, 1_200, 1_200, 400,
    ]);
    expect(result.injectedCharacters).toBe(
      projectMemoryLimits.totalExcerptCharacters,
    );
    expect(result.references.map((value) => value.injected)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(result.references.map((value) => value.truncated)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // Deterministic: the same hits always yield the same selection.
    expect(applyProjectMemoryBudget([hit(1, big), hit(2, big)])).toEqual(
      applyProjectMemoryBudget([hit(1, big), hit(2, big)]),
    );
  });

  test("a remainder below the minimum tail is not injected", () => {
    const result = applyProjectMemoryBudget([
      hit(1, "a".repeat(1_200)),
      hit(2, "b".repeat(1_200)),
      hit(3, "c".repeat(1_200)),
      hit(4, "d".repeat(300)),
      hit(5, "e".repeat(300)),
    ]);
    expect(result.injected.map((value) => value.rank)).toEqual([1, 2, 3, 4]);
    expect(result.injectedCharacters).toBe(3_900);
    expect(result.references[4]).toMatchObject({ injected: false });
  });
});

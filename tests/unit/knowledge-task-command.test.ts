import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeStoreError,
  type AgentKnowledgeStore,
  type KnowledgeScope,
  type SearchKnowledgeHit,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { handleKnowledgeCommand } from "../../packages/runtime-host/src/commands/knowledge.ts";
import type { CommandContext } from "../../packages/runtime-host/src/commands/shared.ts";

const scope: KnowledgeScope = {
  tenantId: "tenant-a",
  repositoryId: "repo-a",
};

function knowledgeHit(overrides: Partial<SearchKnowledgeHit> = {}): SearchKnowledgeHit {
  return {
    tenantId: scope.tenantId,
    repositoryId: scope.repositoryId,
    id: "ak_mem_1",
    kind: "memory",
    text: "Use the staged rollout",
    title: null,
    agentId: "agent-1",
    runId: "run-1",
    taskId: "task-1",
    source: { id: "run-1", kind: "run", label: "Agent run run-1" },
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    ...overrides,
  };
}

interface Harness {
  context: CommandContext;
  stdout: string[];
  findTaskKnowledge: ReturnType<typeof vi.fn>;
}

function harness(
  agentKnowledge: CommandContext["agentKnowledge"],
  hits: SearchKnowledgeHit[] = [],
): Harness {
  const stdout: string[] = [];
  const findTaskKnowledge = vi.fn(
    async (_scope: KnowledgeScope, _taskId: string, _limit?: number) => hits,
  );
  const context = {
    io: { stdout: (message: string) => stdout.push(message), stderr: () => {} },
    projects: { findById: async () => ({}) },
    tasks: {},
    runtime: {},
    repositoryIdentities: { findRepositoryId: async () => scope.repositoryId },
    agentKnowledge,
    audit: {},
    clock: {},
    profiles: {},
    governance: {},
  } as unknown as CommandContext;
  // The store only needs the one retrieval method for this command.
  if (agentKnowledge?.state === "connected") {
    (agentKnowledge as { store: AgentKnowledgeStore }).store = {
      findTaskKnowledge,
    } as unknown as AgentKnowledgeStore;
  }
  return { context, stdout, findTaskKnowledge };
}

async function run(context: CommandContext, args: string[]): Promise<number | null> {
  return handleKnowledgeCommand("knowledge:task", args, context);
}

describe("knowledge:task command", () => {
  it("returns ranked task-linked hits with a connected store and hides the scope", async () => {
    const hits = [
      knowledgeHit(),
      knowledgeHit({
        id: "ak_dec_1",
        kind: "decision",
        title: "Use staged deployment",
        runId: "run-2",
        createdAt: new Date("2026-10-02T10:00:00.000Z"),
      }),
    ];
    const { context, stdout, findTaskKnowledge } = harness(
      {
        state: "connected",
        tenantId: scope.tenantId,
        store: {} as AgentKnowledgeStore,
      },
      hits,
    );
    const code = await run(context, [
      "--project",
      "project-1",
      "--task",
      "task-1",
      "--limit",
      "2",
    ]);
    expect(code).toBe(0);
    expect(findTaskKnowledge).toHaveBeenCalledWith(
      { tenantId: scope.tenantId, repositoryId: scope.repositoryId },
      "task-1",
      2,
    );
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      state: "connected",
      hits: [
        {
          id: "ak_mem_1",
          kind: "memory",
          title: null,
          excerpt: "Use the staged rollout",
          createdAt: "2026-10-01T10:00:00.000Z",
          runId: "run-1",
        },
        {
          id: "ak_dec_1",
          kind: "decision",
          title: "Use staged deployment",
          excerpt: "Use the staged rollout",
          createdAt: "2026-10-02T10:00:00.000Z",
          runId: "run-2",
        },
      ],
    });
    expect(stdout.join("\n")).not.toMatch(/tenant-a|repo-a/);
  });

  it("bounds the excerpt at the retrieval limit and marks truncation", async () => {
    const text = `${"x".repeat(500)} tail`;
    const { context, stdout } = harness(
      {
        state: "connected",
        tenantId: scope.tenantId,
        store: {} as AgentKnowledgeStore,
      },
      [knowledgeHit({ text })],
    );
    expect(await run(context, ["--project", "project-1", "--task", "task-1"])).toBe(0);
    const output = JSON.parse(stdout[0]!) as { hits: { excerpt: string }[] };
    expect(output.hits[0]!.excerpt).toHaveLength(401);
    expect(output.hits[0]!.excerpt.endsWith("…")).toBe(true);
    expect(output.hits[0]!.excerpt).not.toContain("tail");
  });

  it("distinguishes a connected store with no hits from an unusable store", async () => {
    const { context, stdout, findTaskKnowledge } = harness(
      {
        state: "connected",
        tenantId: scope.tenantId,
        store: {} as AgentKnowledgeStore,
      },
      [],
    );
    expect(await run(context, ["--project", "project-1", "--task", "task-1"])).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      state: "connected",
      hits: [],
    });
    expect(findTaskKnowledge).toHaveBeenCalledTimes(1);

    const disabled = harness({ state: "disabled" });
    expect(
      await run(disabled.context, ["--project", "project-1", "--task", "task-1"]),
    ).toBe(0);
    expect(JSON.parse(disabled.stdout[0]!)).toEqual({
      schemaVersion: 1,
      state: "disabled",
      hits: [],
    });
    expect(disabled.findTaskKnowledge).not.toHaveBeenCalled();
  });

  it("reports misconfigured and unavailable states with only the typed code", async () => {
    for (const state of ["misconfigured", "unavailable"] as const) {
      const { context, stdout, findTaskKnowledge } = harness({
        state,
        error: new KnowledgeStoreError(
          state === "misconfigured"
            ? "KNOWLEDGE_MISCONFIGURED"
            : "KNOWLEDGE_UNAVAILABLE",
        ),
      });
      expect(
        await run(context, ["--project", "project-1", "--task", "task-1"]),
      ).toBe(0);
      const output = JSON.parse(stdout[0]!) as Record<string, unknown>;
      expect(output).toEqual({
        schemaVersion: 1,
        state,
        error:
          state === "misconfigured"
            ? "KNOWLEDGE_MISCONFIGURED"
            : "KNOWLEDGE_UNAVAILABLE",
        hits: [],
      });
      expect(JSON.stringify(output)).not.toMatch(/endpoint|secret|ws:/);
      expect(findTaskKnowledge).not.toHaveBeenCalled();
    }
  });

  it("treats an absent store composition as disabled", async () => {
    const { context, stdout } = harness(undefined);
    expect(
      await run(context, ["--project", "project-1", "--task", "task-1"]),
    ).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      state: "disabled",
      hits: [],
    });
  });

  it("refuses a missing, blank, padded, or oversized --task id", async () => {
    const { context } = harness({
      state: "connected",
      tenantId: scope.tenantId,
      store: {} as AgentKnowledgeStore,
    });
    for (const args of [
      ["--project", "project-1"],
      ["--project", "project-1", "--task", ""],
      ["--project", "project-1", "--task", " padded"],
      ["--project", "project-1", "--task", "padded "],
      ["--project", "project-1", "--task", "x".repeat(257)],
    ]) {
      await expect(run(context, args)).rejects.toThrow(/task id|Missing required option --task/);
    }
  });

  it("enforces the limit bounds before touching the store", async () => {
    const { context, findTaskKnowledge } = harness({
      state: "connected",
      tenantId: scope.tenantId,
      store: {} as AgentKnowledgeStore,
    });
    for (const limit of ["0", "6", "1.5", "05", "-1"]) {
      await expect(
        run(context, ["--project", "project-1", "--task", "task-1", "--limit", limit]),
      ).rejects.toThrow("Knowledge task limit must be 1 to 5");
    }
    expect(findTaskKnowledge).not.toHaveBeenCalled();
    for (const limit of ["1", "5"]) {
      expect(
        await run(context, [
          "--project",
          "project-1",
          "--task",
          "task-1",
          "--limit",
          limit,
        ]),
      ).toBe(0);
    }
    expect(findTaskKnowledge.mock.calls.map((call) => call[2])).toEqual([1, 5]);
  });

  it("rejects unknown options and positional arguments", async () => {
    const { context } = harness({ state: "disabled" });
    await expect(
      run(context, ["--project", "project-1", "--task", "task-1", "--query", "x"]),
    ).rejects.toThrow("Unknown option --query");
    await expect(
      run(context, ["--project", "project-1", "--task", "task-1", "extra"]),
    ).rejects.toThrow("knowledge:task only accepts named options");
  });

  it("propagates typed store failures for the runtime boundary to sanitize", async () => {
    const failing = vi.fn(async () => {
      throw new KnowledgeStoreError("KNOWLEDGE_QUERY_FAILED");
    });
    const context = {
      io: { stdout: () => {}, stderr: () => {} },
      projects: { findById: async () => ({}) },
      tasks: {},
      runtime: {},
      repositoryIdentities: { findRepositoryId: async () => scope.repositoryId },
      agentKnowledge: {
        state: "connected",
        tenantId: scope.tenantId,
        store: { findTaskKnowledge: failing } as unknown as AgentKnowledgeStore,
      },
      audit: {},
      clock: {},
      profiles: {},
      governance: {},
    } as unknown as CommandContext;
    // The typed code is the entire message, so the formatted stderr the
    // Runtime boundary prints carries no query, endpoint, or credential.
    await expect(
      run(context, ["--project", "project-1", "--task", "task-1"]),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_QUERY_FAILED",
      message: "KNOWLEDGE_QUERY_FAILED",
    });
  });

  it("refuses an unknown project before querying the store", async () => {
    const stdout: string[] = [];
    const findTaskKnowledge = vi.fn(async () => []);
    const context = {
      io: { stdout: (message: string) => stdout.push(message), stderr: () => {} },
      projects: { findById: async () => null },
      tasks: {},
      runtime: {},
      repositoryIdentities: { findRepositoryId: async () => null },
      agentKnowledge: {
        state: "connected",
        tenantId: scope.tenantId,
        store: { findTaskKnowledge } as unknown as AgentKnowledgeStore,
      },
      audit: {},
      clock: {},
      profiles: {},
      governance: {},
    } as unknown as CommandContext;
    await expect(
      run(context, ["--project", "missing", "--task", "task-1"]),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_PROJECT_NOT_FOUND" });
    expect(findTaskKnowledge).not.toHaveBeenCalled();
    expect(stdout).toHaveLength(0);
  });
});

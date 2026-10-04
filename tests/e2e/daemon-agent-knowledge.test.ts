import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeStoreError,
  type AgentKnowledgeStore,
  type KnowledgeProvenance,
  type KnowledgeScope,
  type KnowledgeSearchQuery,
  type NonRunKnowledgeHit,
  type NonRunKnowledgeInput,
  type SearchKnowledgeHit,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import type { AgentKnowledgeConfiguration } from "@ai-office/storage-surrealdb/agent-knowledge-configuration.ts";
import { runtimeHomeAgentKnowledgePath } from "@ai-office/runtime-paths/agent-knowledge-location.ts";
import {
  ensureRuntimeHome,
  resolveRuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";
import { writeRuntimeHomeCredential } from "@ai-office/llm-gateway/runtime-home-credential-store.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcRuntimeClient } from "../../apps/cli/src/daemon-client.ts";
import {
  bootstrap,
  type BootstrapOptions,
} from "../../apps/daemon/src/bootstrap.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const roots: string[] = [];
const configuration: AgentKnowledgeConfiguration = {
  kind: "surrealdb",
  tenantId: "tenant-a",
  connection: {
    endpoint: "ws://127.0.0.1:8000",
    namespace: "ai_office",
    database: "knowledge",
    username: "operator",
    password: "secret",
  },
};

function configureManagedHome(home: string, password: string): void {
  writeFileSync(
    runtimeHomeAgentKnowledgePath(home),
    JSON.stringify({
      provider: "surrealdb",
      endpoint: "ws://127.0.0.1:8000",
      namespace: "ai_office",
      database: "knowledge",
      tenantId: "tenant-a",
    }),
    { mode: 0o600 },
  );
  writeRuntimeHomeCredential(
    home,
    "AI_OFFICE_SURREALDB_USERNAME",
    Buffer.from("operator"),
  );
  writeRuntimeHomeCredential(
    home,
    "AI_OFFICE_SURREALDB_PASSWORD",
    Buffer.from(password),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function withHost(
  options: Pick<
    BootstrapOptions,
    | "agentKnowledgeConfiguration"
    | "connectAgentKnowledge"
    | "agentKnowledgeConnectTimeoutMs"
  >,
  check: (client: IpcRuntimeClient) => Promise<void>,
  configureRuntimeHome?: (home: string) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ai-office-knowledge-host-"));
  const socket = createTestUnixSocket();
  roots.push(root, socket.root);
  const paths = resolveRuntimePaths({
    mode: "development",
    developmentRoot: root,
  });
  if (configureRuntimeHome !== undefined) {
    ensureRuntimeHome(paths);
    configureRuntimeHome(paths.runtimeHome);
  }
  const host = await bootstrap({
    projectRoot: root,
    runtimePaths: paths,
    socketPath: socket.socketPath,
    ...options,
  });
  const controller = new AbortController();
  const running = host.start(controller.signal);
  const client = new IpcRuntimeClient(socket.socketPath);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await client.health();
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    await check(client);
  } finally {
    controller.abort();
    await running;
  }
}

describe("Runtime agent knowledge composition", () => {
  it("reconstructs managed knowledge from Runtime-home sources without ambient secrets", async () => {
    vi.stubEnv("AI_OFFICE_AGENT_KNOWLEDGE_SOURCE", "runtime_home");
    vi.stubEnv("AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER", "none");
    vi.stubEnv("AI_OFFICE_SURREALDB_PASSWORD", "ambient-secret");
    const connect = vi.fn(async () => ({
      store: {} as AgentKnowledgeStore,
      close: async () => {},
    }));
    await withHost(
      { connectAgentKnowledge: connect },
      async (client) => {
        expect((await client.health()).knowledge).toEqual({
          provider: "surrealdb",
          startup: "connected",
        });
        expect(JSON.stringify(await client.health())).not.toMatch(
          /stored-secret|ambient-secret/u,
        );
        expect(connect).toHaveBeenCalledWith(
          expect.objectContaining({
            username: "operator",
            password: "stored-secret",
          }),
          expect.any(AbortSignal),
        );
      },
      (home) => configureManagedHome(home, "stored-secret"),
    );
  });

  it("reports a rejected managed password as unavailable without exposing it", async () => {
    vi.stubEnv("AI_OFFICE_AGENT_KNOWLEDGE_SOURCE", "runtime_home");
    const connect = vi.fn(async () => {
      throw new Error(
        "Authentication failed for rejected-secret at ws://127.0.0.1:8000",
      );
    });
    await withHost(
      { connectAgentKnowledge: connect },
      async (client) => {
        const health = await client.health();
        expect(health.knowledge).toEqual({
          provider: "surrealdb",
          startup: "unavailable",
        });
        expect(JSON.stringify(health)).not.toMatch(
          /rejected-secret|127\.0\.0\.1/u,
        );
        expect((await client.execute(["client:detect"])).exitCode).toBe(0);
      },
      (home) => configureManagedHome(home, "rejected-secret"),
    );
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "rejected-secret" }),
      expect.any(AbortSignal),
    );
  });

  it("ignores stale CairnKeep environment while native knowledge follows its own configuration", async () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "ai-office-retired-memory-"));
    roots.push(legacyRoot);
    const marker = join(legacyRoot, "spawned");
    const command = join(legacyRoot, "retired-memory");
    writeFileSync(command, `#!/bin/sh\nprintf spawned > '${marker}'\n`, {
      mode: 0o700,
    });
    vi.stubEnv("AI_OFFICE_PROJECT_MEMORY_PROVIDER", "cairnkeep");
    vi.stubEnv("AI_OFFICE_CAIRNKEEP_COMMAND", command);
    vi.stubEnv("AI_OFFICE_PROJECT_MEMORY_TIMEOUT_MS", "500");
    vi.stubEnv(
      "CAIRN_AGENTFS_BASE_DIR",
      join(legacyRoot, "legacy-secret-directory"),
    );
    vi.stubEnv("AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER", "none");
    const connect = vi.fn(async () => ({
      store: {} as AgentKnowledgeStore,
      close: async () => {},
    }));
    await withHost({ connectAgentKnowledge: connect }, async (client) => {
      const health = await client.health();
      expect(health.knowledge).toEqual({
        provider: "none",
        startup: "disabled",
      });
      expect(health).not.toHaveProperty("projectMemory");
      expect(JSON.stringify(health)).not.toMatch(/cairnkeep|legacy-secret/iu);
      const detection = await client.execute(["client:detect"]);
      expect(detection.exitCode).toBe(0);
      expect(JSON.stringify(detection)).not.toMatch(
        /cairnkeep|legacy-secret/iu,
      );
      const retired = await client.execute([
        "project-memory:status",
        "--probe",
      ]);
      expect(retired.stderr.join("\n")).toContain(
        "Unknown command: project-memory:status",
      );
    });
    expect(connect).not.toHaveBeenCalled();

    vi.stubEnv("AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER", "surrealdb");
    vi.stubEnv(
      "AI_OFFICE_SURREALDB_URL",
      configuration.kind === "surrealdb"
        ? configuration.connection.endpoint
        : "",
    );
    vi.stubEnv("AI_OFFICE_SURREALDB_NAMESPACE", "ai_office");
    vi.stubEnv("AI_OFFICE_SURREALDB_DATABASE", "knowledge");
    vi.stubEnv("AI_OFFICE_SURREALDB_USERNAME", "operator");
    vi.stubEnv("AI_OFFICE_SURREALDB_PASSWORD", "native-secret-password");
    vi.stubEnv("AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID", "tenant-a");
    await withHost({ connectAgentKnowledge: connect }, async (client) => {
      const health = await client.health();
      expect(health.knowledge).toEqual({
        provider: "surrealdb",
        startup: "connected",
      });
      expect(health).not.toHaveProperty("projectMemory");
      expect(JSON.stringify(health)).not.toMatch(
        /cairnkeep|legacy-secret|native-secret/iu,
      );
      const detection = await client.execute(["client:detect"]);
      expect(detection.exitCode).toBe(0);
      expect(JSON.stringify(detection)).not.toMatch(
        /cairnkeep|legacy-secret|native-secret/iu,
      );
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "ws://127.0.0.1:8000",
        password: "native-secret-password",
      }),
      expect.any(AbortSignal),
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects retired CairnKeep commands over the Runtime socket", async () => {
    await withHost(
      { agentKnowledgeConfiguration: { kind: "disabled" } },
      async (client) => {
        for (const command of [
          "project-memory:status",
          "knowledge:legacy-plan",
          "knowledge:legacy-import",
        ]) {
          const result = await client.execute([command]);
          expect(result.exitCode).toBe(1);
          expect(result.stderr.join("\n")).toContain(
            `Unknown command: ${command}`,
          );
        }
      },
    );
  });

  it("searches scoped knowledge read-only over the Runtime socket", async () => {
    const repository = mkdtempSync(join(tmpdir(), "ai-office-knowledge-repo-"));
    roots.push(repository);
    writeFileSync(join(repository, "README.md"), "# Demo\n");
    const findKnowledge = vi.fn(async () => [
      {
        tenantId: "tenant-a",
        repositoryId: "ignored-by-output",
        id: "ak_1",
        kind: "memory" as const,
        text: "Use the staged rollout",
        title: null,
        agentId: "agent-1",
        runId: "run-1",
        taskId: "task-1",
        source: { id: "run-1", kind: "run" as const, label: "Agent run run-1" },
        createdAt: new Date("2026-09-30T10:00:00.000Z"),
      },
    ]);
    const store = { findKnowledge } as unknown as AgentKnowledgeStore;
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: async () => ({ store, close: async () => {} }),
      },
      async (client) => {
        const imported = await client.execute([
          "project:import",
          repository,
          "--json",
        ]);
        expect(imported.exitCode).toBe(0);
        const { projectId } = JSON.parse(imported.stdout[0]!) as {
          projectId: string;
        };

        const found = await client.execute([
          "knowledge:search",
          "--project",
          projectId,
          "--query",
          "rollout",
          "--limit",
          "2",
        ]);
        expect(found.exitCode).toBe(0);
        expect(JSON.parse(found.stdout.join("\n"))).toEqual({
          schemaVersion: 1,
          hits: [
            {
              id: "ak_1",
              kind: "memory",
              title: null,
              text: "Use the staged rollout",
              agentId: "agent-1",
              runId: "run-1",
              taskId: "task-1",
              source: { id: "run-1", kind: "run", label: "Agent run run-1" },
              createdAt: "2026-09-30T10:00:00.000Z",
              legacy: false,
              provenanceKind: "agent_run",
            },
          ],
        });
        expect(findKnowledge).toHaveBeenCalledTimes(1);
        expect(findKnowledge).toHaveBeenCalledWith(
          { tenantId: "tenant-a", repositoryId: expect.any(String) },
          { text: "rollout", limit: 2 },
        );
        expect(found.stdout.join("\n")).not.toMatch(/tenant-a|secret/u);

        for (const [args, message] of [
          [
            ["--project", projectId, "--query", "rollout", "--limit", "6"],
            "Knowledge search limit must be 1 to 5",
          ],
          [["--project", projectId], "Missing required option --query"],
          [
            ["--project", projectId, "--query", "staged", "rollout"],
            "knowledge:search only accepts named options",
          ],
          [
            ["--project", projectId, "--query", "rollout", "--kind", "memory"],
            "--kind",
          ],
          [["--project", projectId, "--query", "a", "--query", "b"], "--query"],
          [
            ["--project", "missing", "--query", "rollout"],
            "KNOWLEDGE_PROJECT_NOT_FOUND",
          ],
        ] as const) {
          const refused = await client.execute(["knowledge:search", ...args]);
          expect(refused.exitCode).toBe(1);
          expect(refused.stderr.join("\n")).toContain(message);
        }
        expect(findKnowledge).toHaveBeenCalledTimes(1);
      },
    );

    await withHost(
      { agentKnowledgeConfiguration: { kind: "disabled" } },
      async (client) => {
        const refused = await client.execute([
          "knowledge:search",
          "--project",
          "any",
          "--query",
          "rollout",
        ]);
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr.join("\n")).toContain(
          "KNOWLEDGE_STORE_NOT_CONNECTED",
        );
      },
    );
  });

  it("publishes legacy and empty results, bounds limits, and hides store failures over the Runtime socket", async () => {
    const repositories = ["a", "b"].map((name) => {
      const repository = mkdtempSync(
        join(tmpdir(), `ai-office-knowledge-repo-${name}-`),
      );
      roots.push(repository);
      writeFileSync(join(repository, "README.md"), `# ${name}\n`);
      return repository;
    });
    let next: () => Promise<SearchKnowledgeHit[]> = async () => [];
    const findKnowledge = vi.fn(
      async (_scope: KnowledgeScope, _query: KnowledgeSearchQuery) => next(),
    );
    const store = { findKnowledge } as unknown as AgentKnowledgeStore;
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: async () => ({ store, close: async () => {} }),
      },
      async (client) => {
        const projectIds: string[] = [];
        for (const repository of repositories) {
          const imported = await client.execute([
            "project:import",
            repository,
            "--json",
          ]);
          expect(imported.exitCode).toBe(0);
          const output: { projectId: string } = JSON.parse(imported.stdout[0]!);
          projectIds.push(output.projectId);
        }
        const [projectId, otherProjectId] = projectIds as [string, string];
        const search = (...args: string[]) =>
          client.execute(["knowledge:search", "--project", projectId, ...args]);

        next = async () => [
          {
            tenantId: "tenant-a",
            repositoryId: "repo",
            id: "legacy_1",
            kind: "memory",
            text: "Legacy rollout note",
            title: null,
            agentId: null,
            runId: null,
            taskId: null,
            source: { id: "legacy_1", kind: "external", label: "Imported" },
            createdAt: new Date("2026-01-02T03:04:05.000Z"),
            legacy: {
              sourceScope: "hidden-scope-x",
              sourceKey: "hidden-key-y",
              sourceSha256: "hidden-sha-z",
            },
          },
        ];
        const legacy = await search("--query", "rollout");
        expect(legacy.exitCode).toBe(0);
        expect(JSON.parse(legacy.stdout.join("\n"))).toEqual({
          schemaVersion: 1,
          hits: [
            {
              id: "legacy_1",
              kind: "memory",
              title: null,
              text: "Legacy rollout note",
              agentId: null,
              runId: null,
              taskId: null,
              source: { id: "legacy_1", kind: "external", label: "Imported" },
              createdAt: "2026-01-02T03:04:05.000Z",
              legacy: true,
              provenanceKind: "legacy_import",
            },
          ],
        });
        expect(legacy.stdout.join("\n")).not.toMatch(/hidden-/u);

        next = async () => [];
        const empty = await search("--query", "nothing");
        expect(empty.exitCode).toBe(0);
        expect(empty.stdout).toEqual(['{"schemaVersion":1,"hits":[]}']);

        findKnowledge.mockClear();
        expect(
          (await search("--query", "x", "--agent", "agent-7")).exitCode,
        ).toBe(0);
        expect(findKnowledge).toHaveBeenCalledWith(expect.anything(), {
          text: "x",
          agentId: "agent-7",
        });

        findKnowledge.mockClear();
        for (const limit of ["1", "5"]) {
          expect(
            (await search("--query", "x", "--limit", limit)).exitCode,
          ).toBe(0);
        }
        expect(
          findKnowledge.mock.calls.map(([, query]) => query.limit),
        ).toEqual([1, 5]);
        for (const limit of ["0", "1.5", "05", "6"]) {
          const refused = await search("--query", "x", "--limit", limit);
          expect(refused.exitCode).toBe(1);
          expect(refused.stderr.join("\n")).toContain(
            "Knowledge search limit must be 1 to 5",
          );
        }
        expect(findKnowledge).toHaveBeenCalledTimes(2);

        next = async () => {
          throw new KnowledgeStoreError("KNOWLEDGE_QUERY_FAILED");
        };
        const typed = await search("--query", "x");
        expect(typed.exitCode).toBe(1);
        expect(typed.stderr.join("\n")).toContain("KNOWLEDGE_QUERY_FAILED");

        next = async () => {
          throw new Error("secret endpoint password");
        };
        const untyped = await search("--query", "x");
        expect(untyped.exitCode).toBe(1);
        expect(
          untyped.stdout.join("\n") + untyped.stderr.join("\n"),
        ).not.toMatch(/secret|endpoint|password/u);

        next = async () => [];
        findKnowledge.mockClear();
        await search("--query", "x");
        await client.execute([
          "knowledge:search",
          "--project",
          otherProjectId,
          "--query",
          "x",
        ]);
        const [first, second] = findKnowledge.mock.calls.map(
          ([scope]) => scope,
        );
        expect(first?.tenantId).toBe("tenant-a");
        expect(second?.tenantId).toBe("tenant-a");
        expect(first?.repositoryId).not.toBe(second?.repositoryId);
      },
    );
  });

  it("admits handover and operator-confirmed knowledge over the Runtime socket with real evidence only", async () => {
    const repository = mkdtempSync(join(tmpdir(), "ai-office-knowledge-repo-"));
    roots.push(repository);
    writeFileSync(join(repository, "README.md"), "# Demo\n");
    writeFileSync(join(repository, "index.ts"), "export {};\n");

    // A minimal store: the Runtime, not this fake, owns every admission rule.
    const records = new Map<string, NonRunKnowledgeHit>();
    const trace = async (
      _scope: unknown,
      id: string,
    ): Promise<KnowledgeProvenance | null> => {
      const knowledge = records.get(id);
      return knowledge === undefined
        ? null
        : {
            knowledge,
            source: knowledge.source,
            runId: null,
            taskId: null,
            agentId: null,
          };
    };
    const recordNonRunKnowledge = vi.fn(
      async ({ title, ...input }: NonRunKnowledgeInput) => {
        records.set(input.id, {
          ...input,
          title: title ?? null,
          agentId: null,
          runId: null,
          taskId: null,
        });
      },
    );
    const store = {
      recordNonRunKnowledge,
      recordMemory: vi.fn(),
      recordDecision: vi.fn(),
      traceMemoryProvenance: trace,
      traceDecisionProvenance: trace,
      traceLegacyMemory: async () => null,
      findKnowledge: async (_scope: unknown, query: { text: string }) =>
        [...records.values()].filter((hit) =>
          hit.text.toLowerCase().includes(query.text.toLowerCase()),
        ),
    } as unknown as AgentKnowledgeStore;

    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: async () => ({ store, close: async () => {} }),
      },
      async (client) => {
        interface Output {
          projectId: string;
          confirmationId: string;
          fingerprint: string;
          scanId: string | null;
          confirmedAt: string;
          id: string;
          planHash: string;
          provenanceKind: string;
          provenance: Record<string, unknown>;
          admissionSource: Record<string, unknown>;
          hits: Array<Record<string, unknown>>;
        }
        const json = async (args: string[]) => {
          const result = await client.execute(args);
          expect(result.stderr.join("\n")).toBe("");
          expect(result.exitCode).toBe(0);
          return JSON.parse(result.stdout.join("\n")) as Output;
        };
        const refused = async (args: string[], message: string) => {
          const result = await client.execute(args);
          expect(result.exitCode, args.join(" ")).toBe(1);
          expect(result.stderr.join("\n")).toContain(message);
        };
        const { projectId } = await json([
          "project:import",
          repository,
          "--json",
        ]);
        const content = [
          "--project",
          projectId,
          "--kind",
          "memory",
          "--text",
          "The daemon owns every knowledge write",
        ];

        // A scanned, imported repository is not a confirmed review.
        await refused(
          [
            "knowledge:plan",
            ...content,
            "--source",
            "handover",
            "--handover",
            "any",
          ],
          "KNOWLEDGE_HANDOVER_NOT_CONFIRMED",
        );
        const confirmed = await json([
          "handover:confirm",
          "--project",
          projectId,
          "--summary",
          "TypeScript library with a README",
          "--json",
        ]);
        expect(confirmed.confirmationId).toEqual(expect.any(String));
        const handover = [
          ...content,
          "--source",
          "handover",
          "--handover",
          confirmed.confirmationId,
        ];
        const plan = await json(["knowledge:plan", ...handover]);
        expect(plan).toMatchObject({
          schemaVersion: 2,
          runId: null,
          taskId: null,
          agentId: null,
          provenance: {
            kind: "handover",
            confirmationId: confirmed.confirmationId,
            fingerprint: confirmed.fingerprint,
            scanId: confirmed.scanId,
            confirmedAt: confirmed.confirmedAt,
          },
        });
        expect(recordNonRunKnowledge).not.toHaveBeenCalled();
        await refused(
          [
            "knowledge:admit",
            ...handover,
            "--approve",
            "0".repeat(64),
            "--actor",
            "operator",
          ],
          "KNOWLEDGE_APPROVAL_MISMATCH",
        );
        expect(
          await json([
            "knowledge:admit",
            ...handover,
            "--approve",
            plan.planHash,
            "--actor",
            "operator",
          ]),
        ).toEqual({
          schemaVersion: 1,
          id: plan.id,
          kind: "memory",
          planHash: plan.planHash,
          provenanceKind: "handover",
          outcome: "recorded",
        });

        // Operator-confirmed evidence must be a record of this project.
        const created = await client.execute([
          "task:create",
          "--project",
          projectId,
          "--title",
          "Investigate the knowledge boundary",
        ]);
        const taskId = /Task created: (\S+)/u.exec(
          created.stdout.join("\n"),
        )![1]!;
        const operatorContent = [
          "--project",
          projectId,
          "--kind",
          "decision",
          "--title",
          "Knowledge write boundary",
          "--text",
          "Agents propose; only the daemon persists knowledge",
          "--source",
          "operator-confirmed",
          "--confirmed-by",
          "andrea",
        ];
        const evidence = `task:${taskId},handover:${confirmed.confirmationId}`;
        const operatorPlan = await json([
          "knowledge:plan",
          ...operatorContent,
          "--evidence",
          evidence,
        ]);
        expect(operatorPlan.provenance).toEqual({
          kind: "operator_confirmed",
          confirmedBy: "andrea",
          evidence: [
            {
              kind: "handover",
              id: confirmed.confirmationId,
              label: `Handover review ${confirmed.confirmationId}`,
            },
            { kind: "task", id: taskId, label: `Task ${taskId}` },
          ],
        });
        await refused(
          [
            "knowledge:admit",
            ...operatorContent,
            "--evidence",
            evidence,
            "--approve",
            operatorPlan.planHash,
            "--actor",
            "claude-code",
          ],
          "KNOWLEDGE_CONFIRMATION_MISMATCH",
        );
        await refused(
          [
            "knowledge:admit",
            ...operatorContent,
            "--evidence",
            `task:${taskId}`,
            "--approve",
            operatorPlan.planHash,
            "--actor",
            "andrea",
          ],
          "KNOWLEDGE_APPROVAL_MISMATCH",
        );
        expect(recordNonRunKnowledge).toHaveBeenCalledTimes(1);
        expect(
          (
            await json([
              "knowledge:admit",
              ...operatorContent,
              "--evidence",
              evidence,
              "--approve",
              operatorPlan.planHash,
              "--actor",
              "andrea",
            ])
          ).provenanceKind,
        ).toBe("operator_confirmed");

        // Host sessions, unknown records, and mixed sources are never provenance.
        for (const [args, message] of [
          [
            [...operatorContent, "--evidence", "claude_session:session_01Xo"],
            "KNOWLEDGE_INVALID_PROVENANCE",
          ],
          [
            [...operatorContent, "--evidence", "task:missing"],
            "KNOWLEDGE_EVIDENCE_UNAVAILABLE",
          ],
          [[...operatorContent, "--evidence", "task"], "<kind>:<id>"],
          [[...operatorContent], "Missing required option --evidence"],
          [
            [...operatorContent, "--evidence", evidence, "--run", "run-1"],
            "--run is not accepted with --source operator-confirmed",
          ],
          [
            [...handover, "--confirmed-by", "andrea"],
            "--confirmed-by is not accepted with --source handover",
          ],
          [
            [
              ...content,
              "--run",
              "run-1",
              "--handover",
              confirmed.confirmationId,
            ],
            "--handover is not accepted with --source agent-run",
          ],
          [
            [...content, "--source", "claude-session", "--run", "run-1"],
            "Knowledge source must be",
          ],
          [[...content], "Missing required option --run"],
          [
            [...content, "--claude-session", "session_01Xo"],
            "--claude-session",
          ],
        ] as const) {
          await refused(["knowledge:plan", ...args], message);
        }
        expect(recordNonRunKnowledge).toHaveBeenCalledTimes(2);

        const traced = await json([
          "knowledge:trace",
          "--project",
          projectId,
          "--kind",
          "memory",
          "--id",
          plan.id,
        ]);
        expect(traced).toMatchObject({
          schemaVersion: 1,
          provenance: {
            runId: null,
            source: { kind: "handover", id: confirmed.confirmationId },
          },
          admissionSource: { projectId, ...plan.provenance },
          admission: {
            planHash: plan.planHash,
            audit: { aggregateType: "agent_knowledge", aggregateId: plan.id },
          },
        });
        expect(
          (
            await json([
              "knowledge:trace",
              "--project",
              projectId,
              "--kind",
              "decision",
              "--id",
              operatorPlan.id,
            ])
          ).admissionSource,
        ).toEqual({ projectId, ...operatorPlan.provenance });
        expect(
          await json([
            "knowledge:trace",
            "--project",
            projectId,
            "--kind",
            "memory",
            "--id",
            "ak_missing",
          ]),
        ).toEqual({
          schemaVersion: 1,
          provenance: null,
          admissionSource: null,
          admission: null,
        });

        const found = await json([
          "knowledge:search",
          "--project",
          projectId,
          "--query",
          "daemon",
        ]);
        expect(
          found.hits
            .map((hit) => [hit.id, hit.provenanceKind, hit.runId])
            .sort(),
        ).toEqual(
          [
            [plan.id, "handover", null],
            [operatorPlan.id, "operator_confirmed", null],
          ].sort(),
        );

        // New repository evidence makes the confirmed review stale for admission.
        writeFileSync(join(repository, "tool.py"), "print('x')\n");
        await json(["project:import", repository, "--json"]);
        await refused(
          ["knowledge:plan", ...handover],
          "KNOWLEDGE_HANDOVER_STALE",
        );
        await refused(
          ["knowledge:plan", ...operatorContent, "--evidence", evidence],
          "KNOWLEDGE_EVIDENCE_UNAVAILABLE",
        );
        expect(recordNonRunKnowledge).toHaveBeenCalledTimes(2);
        expect(store.recordMemory).not.toHaveBeenCalled();
        expect(store.recordDecision).not.toHaveBeenCalled();
      },
    );
  });

  it("composes an explicit secondary store and closes it with the host", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      store: {} as AgentKnowledgeStore,
      close,
    }));
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: connect,
      },
      async (client) => {
        const health = await client.health();
        expect(health.knowledge).toEqual({
          provider: "surrealdb",
          startup: "connected",
        });
        expect(JSON.stringify(health)).not.toContain("secret");
        expect(connect).toHaveBeenCalledWith(
          configuration.kind === "surrealdb"
            ? configuration.connection
            : undefined,
          expect.any(AbortSignal),
        );
        expect(close).not.toHaveBeenCalled();
      },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      configuration: { kind: "disabled" },
      expected: { provider: "none", startup: "disabled" },
    },
    {
      configuration: { kind: "misconfigured", provider: "surrealdb" },
      expected: { provider: "surrealdb", startup: "misconfigured" },
    },
    {
      configuration: { kind: "misconfigured", provider: "unknown" },
      expected: { provider: "unknown", startup: "misconfigured" },
    },
  ] satisfies Array<{
    configuration: AgentKnowledgeConfiguration;
    expected: { provider: string; startup: string };
  }>)(
    "keeps knowledge $configuration.kind independent of Runtime authority",
    async ({ configuration, expected }) => {
      const connect = vi.fn(async () => {
        throw new Error("unexpected connection");
      });
      await withHost(
        {
          agentKnowledgeConfiguration: configuration,
          connectAgentKnowledge: connect,
        },
        async (client) => {
          expect((await client.health()).knowledge).toEqual(expected);
          expect((await client.execute(["client:detect"])).exitCode).toBe(0);
        },
      );
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("reports an unavailable store without blocking existing Runtime commands or leaking backend errors", async () => {
    const connect = vi.fn(async () => {
      throw new Error("secret endpoint and password");
    });
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: connect,
      },
      async (client) => {
        const health = await client.health();
        expect(health.knowledge).toEqual({
          provider: "surrealdb",
          startup: "unavailable",
        });
        expect(JSON.stringify(health)).not.toContain("secret");
        expect((await client.execute(["client:detect"])).exitCode).toBe(0);
        const search = await client.execute([
          "knowledge:search",
          "--project",
          "any",
          "--query",
          "rollout",
        ]);
        expect(search.exitCode).toBe(1);
        expect(search.stderr.join("\n")).toContain(
          "KNOWLEDGE_STORE_NOT_CONNECTED",
        );
        expect(search.stdout.join("\n") + search.stderr.join("\n")).not.toMatch(
          /secret|password/u,
        );
      },
    );
  });

  it("bounds a stuck connection and closes a late success", async () => {
    let finish!: (value: {
      store: AgentKnowledgeStore;
      close: () => Promise<void>;
    }) => void;
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      (_connection: unknown, signal?: AbortSignal) =>
        new Promise<{ store: AgentKnowledgeStore; close: () => Promise<void> }>(
          (resolve) => {
            finish = resolve;
            expect(signal).toBeDefined();
          },
        ),
    );
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: connect,
        agentKnowledgeConnectTimeoutMs: 10,
      },
      async (client) => {
        expect((await client.health()).knowledge?.startup).toBe("unavailable");
        finish({ store: {} as AgentKnowledgeStore, close });
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      },
    );
  });

  it("consumes a late connection rejection after host shutdown", async () => {
    let fail!: (reason: Error) => void;
    let signal: AbortSignal | undefined;
    const connect = vi.fn(
      (_connection: unknown, receivedSignal?: AbortSignal) => {
        signal = receivedSignal;
        return new Promise<{
          store: AgentKnowledgeStore;
          close: () => Promise<void>;
        }>((_, reject) => {
          fail = reject;
        });
      },
    );
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: connect,
        agentKnowledgeConnectTimeoutMs: 10,
      },
      async (client) => {
        expect((await client.health()).knowledge).toEqual({
          provider: "surrealdb",
          startup: "unavailable",
        });
        expect(signal?.aborted).toBe(true);
      },
    );
    fail(new Error("late secret connection failure"));
    await Promise.resolve();
  });

  it("closes a late success once after host shutdown", async () => {
    let finish!: (value: {
      store: AgentKnowledgeStore;
      close: () => Promise<void>;
    }) => void;
    const close = vi.fn(async () => {});
    await withHost(
      {
        agentKnowledgeConfiguration: configuration,
        connectAgentKnowledge: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        agentKnowledgeConnectTimeoutMs: 10,
      },
      async (client) => {
        expect((await client.health()).knowledge?.startup).toBe("unavailable");
      },
    );
    finish({ store: {} as AgentKnowledgeStore, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});

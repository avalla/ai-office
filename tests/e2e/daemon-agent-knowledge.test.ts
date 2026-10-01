import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKnowledgeStore } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
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

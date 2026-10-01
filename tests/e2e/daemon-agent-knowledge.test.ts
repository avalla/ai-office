import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKnowledgeStore } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import type { AgentKnowledgeConfiguration } from "@ai-office/storage-surrealdb/agent-knowledge-configuration.ts";
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

afterEach(() => {
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
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ai-office-knowledge-host-"));
  const socket = createTestUnixSocket();
  roots.push(root, socket.root);
  const host = await bootstrap({
    projectRoot: root,
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

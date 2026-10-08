import { Surreal } from "surrealdb";
import type { AgentKnowledgeStore } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import { SurrealAgentKnowledgeStoreImpl } from "./surreal-agent-knowledge.store.ts";

export interface SurrealAgentKnowledgeConfig {
  endpoint: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
}

/** Connects and scopes the experimental adapter without leaking its client type. */
export async function connectSurrealAgentKnowledgeStore(
  config: SurrealAgentKnowledgeConfig,
  signal?: AbortSignal,
): Promise<{ store: AgentKnowledgeStore; close: () => Promise<void> }> {
  const db = new Surreal();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= db.close().then(
      () => undefined,
      (error: unknown) => {
        closing = undefined;
        throw error;
      },
    ));
  const abort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const requireActive = () => {
    if (signal?.aborted)
      throw new Error("Agent knowledge connection cancelled");
  };
  try {
    requireActive();
    // `authentication` is the only sign-in: the SDK applies it during
    // `connect()` (before `ready()` resolves, so the calls below are already
    // authenticated) and replays it when the session token expires and after
    // an automatic reconnect. A manual `signin()` here would set the SDK's
    // `authOverriden` flag and disable that replay, reintroducing the
    // ~1-hour silent knowledge outage this connection exists to prevent.
    await db.connect(config.endpoint, {
      reconnect: true,
      namespace: config.namespace,
      database: config.database,
      authentication: {
        username: config.username,
        password: config.password,
      },
    });
    requireActive();
    await db.query("DEFINE NAMESPACE IF NOT EXISTS $namespace", {
      namespace: config.namespace,
    });
    requireActive();
    await db.use({ namespace: config.namespace });
    requireActive();
    await db.query("DEFINE DATABASE IF NOT EXISTS $database", {
      database: config.database,
    });
    requireActive();
    await db.use({ namespace: config.namespace, database: config.database });
    requireActive();
    const store = await SurrealAgentKnowledgeStoreImpl.create(db);
    requireActive();
    return { store, close };
  } catch (error) {
    try {
      await close();
    } catch {
      /* Preserve the connection failure. */
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

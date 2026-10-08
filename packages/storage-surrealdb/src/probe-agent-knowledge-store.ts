import { Surreal } from "surrealdb";
import type { SurrealAgentKnowledgeConfig } from "./connect-agent-knowledge-store.ts";

/**
 * One-shot live connectivity probe for the Runtime status endpoint. Unlike
 * the persistent store connection, every probe uses a throwaway connection
 * that is closed when the probe settles or hits its deadline, so a store
 * that accepts connections but stops answering can never accumulate pending
 * RPCs: each probe frees its own socket, the discarded client is garbage
 * collected, and the next request probes on a fresh connection and observes
 * recovery immediately. The probe only connects and runs a trivial read; it
 * never writes and holds no transaction. Implementations of this contract
 * must settle within the given deadline.
 */
export async function probeSurrealAgentKnowledgeStore(
  config: SurrealAgentKnowledgeConfig,
  deadlineMs: number,
): Promise<void> {
  const db = new Surreal();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Agent knowledge probe timed out")),
      deadlineMs,
    );
  });
  try {
    await Promise.race([
      (async () => {
        await db.connect(config.endpoint, {
          reconnect: false,
          namespace: config.namespace,
          database: config.database,
          authentication: {
            username: config.username,
            password: config.password,
          },
        });
        await db.query("SELECT 1");
      })(),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Closing a still-handshaking socket does not settle the SDK's pending
    // connect(), but it frees the socket and every reference to the client,
    // so a timed-out probe is garbage collected instead of accumulating.
    void db.close().catch(() => {});
  }
}

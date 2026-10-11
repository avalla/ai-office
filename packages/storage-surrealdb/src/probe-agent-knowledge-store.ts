import { Surreal } from "surrealdb";
import type { SurrealAgentKnowledgeConfig } from "./connect-agent-knowledge-store.ts";

/** Bound for closing the throwaway connection after the probe settles. */
const probeCloseBudgetMs = 250;

/**
 * Close a probe client within a fixed budget. SDK close() resolves
 * immediately while the handshake is incomplete, but on an open connection
 * it awaits the socket close event — an event a blackholed transport never
 * delivers. The budget guarantees settlement either way, so no cleanup
 * extends the probe past the budget (a wedged close promise may outlive the
 * probe, but it is raced and can never delay or change the outcome);
 * cleanup failures are swallowed and never change the probe outcome.
 */
export async function closeProbeClient(
  db: Surreal,
  budgetMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } catch {
    /* Preserve the probe outcome over a cleanup failure. */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One-shot live connectivity probe for the Runtime status endpoint. Unlike
 * the persistent store connection, every probe uses a throwaway connection
 * that is closed when the probe settles or hits its deadline, so a store
 * that accepts connections but stops answering can never accumulate pending
 * RPCs: each probe frees its own socket, the discarded client is garbage
 * collected, and the next request probes on a fresh connection and observes
 * recovery immediately. The probe only connects and runs a trivial read; it
 * never writes and holds no transaction. Implementations of this contract
 * settle within the given deadline plus `probeCloseBudgetMs` for closing the
 * connection.
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
    await closeProbeClient(db, probeCloseBudgetMs);
  }
}

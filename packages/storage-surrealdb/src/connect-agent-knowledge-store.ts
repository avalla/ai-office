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
): Promise<{ store: AgentKnowledgeStore; close: () => Promise<void> }> {
  const db = new Surreal();
  try {
    await db.connect(config.endpoint);
    await db.signin({ username: config.username, password: config.password });
    await db.query("DEFINE NAMESPACE IF NOT EXISTS $namespace", { namespace: config.namespace });
    await db.use({ namespace: config.namespace });
    await db.query("DEFINE DATABASE IF NOT EXISTS $database", { database: config.database });
    await db.use({ namespace: config.namespace, database: config.database });
    const store = await SurrealAgentKnowledgeStoreImpl.create(db);
    return { store, close: async () => { await db.close(); } };
  } catch (error) {
    await db.close();
    throw error;
  }
}

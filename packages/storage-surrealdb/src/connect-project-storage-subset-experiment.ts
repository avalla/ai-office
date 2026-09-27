import { Surreal } from "surrealdb";
import { createSurrealProjectStorageSubsetExperiment } from "./project-storage-subset.ts";

export interface SurrealProjectStorageSubsetConfig {
  endpoint: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
  tenantId: string;
}

/** Connects the opt-in subset experiment without changing Runtime bootstrap. */
export async function connectSurrealProjectStorageSubsetExperiment(
  config: SurrealProjectStorageSubsetConfig,
): Promise<{ experiment: Awaited<ReturnType<typeof createSurrealProjectStorageSubsetExperiment>>; close: () => Promise<void> }> {
  const db = new Surreal();
  try {
    await db.connect(config.endpoint);
    await db.signin({ username: config.username, password: config.password });
    await db.query("DEFINE NAMESPACE IF NOT EXISTS $namespace", { namespace: config.namespace });
    await db.use({ namespace: config.namespace });
    await db.query("DEFINE DATABASE IF NOT EXISTS $database", { database: config.database });
    await db.use({ namespace: config.namespace, database: config.database });
    const experiment = await createSurrealProjectStorageSubsetExperiment(db, config.tenantId);
    return { experiment, close: async () => { await db.close(); } };
  } catch (error) {
    await db.close();
    throw error;
  }
}

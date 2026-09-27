import { AsyncLocalStorage } from "node:async_hooks";
import type { Surreal, SurrealTransaction } from "surrealdb";

interface ActiveTransaction {
  database: Surreal;
  transaction: SurrealTransaction;
}

const active = new AsyncLocalStorage<ActiveTransaction>();

export function querySurreal<T extends unknown[]>(
  database: Surreal,
  statement: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const context = active.getStore();
  const queryable = context?.database === database ? context.transaction : database;
  return queryable.query<T>(statement, variables) as unknown as Promise<T>;
}

export async function withSurrealTransaction<T>(
  database: Surreal,
  work: () => Promise<T>,
): Promise<T> {
  if (active.getStore()?.database === database) return work();
  const transaction = await database.beginTransaction();
  try {
    const value = await active.run({ database, transaction }, work);
    await transaction.commit();
    return value;
  } catch (error) {
    // The server may already have aborted the transaction. Cleanup must not
    // replace the original write/commit error with "Transaction not found".
    await transaction.cancel().catch(() => undefined);
    throw error;
  }
}

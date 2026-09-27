import {
  TransactionAlreadyActiveError,
  type TransactionRunner,
} from "@ai-office/application/ports/transaction-runner.port.ts";
import type { Surreal } from "surrealdb";
import { withSurrealTransaction } from "./transaction-context.ts";

const activeConnections = new WeakSet<Surreal>();

/** Ordinary single-client transactions only; this is not a concurrency primitive. */
export class SurrealTransactionRunner implements TransactionRunner {
  constructor(private readonly db: Surreal) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (activeConnections.has(this.db))
      throw new TransactionAlreadyActiveError();
    activeConnections.add(this.db);
    try {
      return await withSurrealTransaction(this.db, work);
    } finally {
      activeConnections.delete(this.db);
    }
  }
}

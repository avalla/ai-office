import type { Database } from "bun:sqlite";
import {
  TransactionAlreadyActiveError,
  type TransactionRunner,
} from "@ai-office/application/ports/transaction-runner.port.ts";

const activeConnections = new WeakSet<Database>();

export class SqliteTransactionRunner implements TransactionRunner {
  constructor(private readonly database: Database) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (activeConnections.has(this.database))
      throw new TransactionAlreadyActiveError();
    activeConnections.add(this.database);

    try {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = await work();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      activeConnections.delete(this.database);
    }
  }
}

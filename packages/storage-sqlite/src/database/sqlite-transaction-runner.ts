import type { Database } from "bun:sqlite";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";

export class SqliteTransactionRunner implements TransactionRunner {
  constructor(private readonly database: Database) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      const result = await work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

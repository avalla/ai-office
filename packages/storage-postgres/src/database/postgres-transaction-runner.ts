import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { PostgresClient } from "./postgres-client.ts";

export class PostgresTransactionRunner implements TransactionRunner {
  constructor(private readonly database: PostgresClient) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }
}

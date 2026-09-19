import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { TransactionAlreadyActiveError } from "@ai-office/application/ports/transaction-runner.port.ts";

type DriverClient = ReturnType<typeof postgres>;
type QuerySession = Pick<DriverClient, "unsafe">;
type DriverParameters = NonNullable<Parameters<DriverClient["unsafe"]>[1]>;

/**
 * One pooled PostgreSQL client plus the transaction-scoped session used by its
 * repositories. The driver remains private to this infrastructure package.
 */
export class PostgresClient {
  private readonly client: DriverClient;
  private readonly transactionSession = new AsyncLocalStorage<QuerySession>();

  constructor(connectionString: string) {
    this.client = postgres(connectionString, {
      // Migration idempotency uses IF NOT EXISTS; expected notices are not
      // useful Runtime output and may include database-local identifiers.
      onnotice: () => undefined,
    });
  }

  async query<Row extends object>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> {
    const session = this.transactionSession.getStore() ?? this.client;
    return (await session.unsafe<Row[]>(statement, [
      ...values,
    ] as unknown as DriverParameters)) as Row[];
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionSession.getStore() !== undefined)
      throw new TransactionAlreadyActiveError();

    return this.client.begin(async (session) =>
      this.transactionSession.run(session, work),
    ) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

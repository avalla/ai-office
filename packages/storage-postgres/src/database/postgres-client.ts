import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { TransactionAlreadyActiveError } from "@ai-office/application/ports/transaction-runner.port.ts";

type DriverClient = ReturnType<typeof postgres>;
type QuerySession = Pick<DriverClient, "unsafe">;
type DriverParameters = NonNullable<Parameters<DriverClient["unsafe"]>[1]>;

interface TransactionContext {
  session: QuerySession;
  lifetime: {
    active: boolean;
  };
}

export class TransactionContextExpiredError extends Error {
  constructor() {
    super("The PostgreSQL transaction context is no longer active");
    this.name = "TransactionContextExpiredError";
  }
}

/**
 * One pooled PostgreSQL client plus the transaction-scoped session used by its
 * repositories. The driver remains private to this infrastructure package.
 */
export class PostgresClient {
  private readonly client: DriverClient;
  private readonly transactionSession =
    new AsyncLocalStorage<TransactionContext>();

  constructor(connectionString: string) {
    this.client = postgres(connectionString, {
      // Expected notices are not useful Runtime output and may include
      // database-local identifiers.
      onnotice: () => undefined,
    });
  }

  async query<Row extends object>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> {
    const context = this.transactionSession.getStore();
    if (context !== undefined && !context.lifetime.active)
      throw new TransactionContextExpiredError();
    const session = context?.session ?? this.client;
    return (await session.unsafe<Row[]>(statement, [
      ...values,
    ] as unknown as DriverParameters)) as Row[];
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const context = this.transactionSession.getStore();
    if (context !== undefined && !context.lifetime.active)
      throw new TransactionContextExpiredError();
    if (context !== undefined) throw new TransactionAlreadyActiveError();

    return this.client.begin(async (session) => {
      const transactionContext: TransactionContext = {
        session,
        lifetime: { active: true },
      };
      try {
        return await this.transactionSession.run(transactionContext, work);
      } finally {
        transactionContext.lifetime.active = false;
      }
    }) as Promise<T>;
  }

  /**
   * Join the current transaction when a repository is called from an
   * application TransactionRunner; otherwise create the top-level boundary.
   */
  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const context = this.transactionSession.getStore();
    if (context !== undefined && !context.lifetime.active)
      throw new TransactionContextExpiredError();
    return context === undefined ? this.transaction(work) : work();
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

import { isRetryableConflict, RecordId, Surreal } from "surrealdb";

export interface ExperimentRecord {
  id: RecordId;
  owner: string;
  lease_until: Date;
  fence: number;
  version: number;
  run_status: string;
  protected_value: string;
}

export function isSurrealConcurrencyConflict(error: unknown): boolean {
  return (
    isRetryableConflict(error) ||
    (error instanceof Error &&
      error.message.includes("Transaction conflict: Write conflict"))
  );
}

/** Primitive probes only; this is not an AI Office repository implementation. */
export class SurrealConcurrencyExperiment {
  constructor(private readonly db: Surreal) {}

  async create(input: {
    id: string;
    owner: string;
    leaseUntil: Date;
    fence?: number;
    version?: number;
    runStatus?: string;
    protectedValue?: string;
  }): Promise<void> {
    await this.db.query(
      `CREATE ONLY $id CONTENT {
         owner: $owner,
         lease_until: $lease_until,
         fence: $fence,
         version: $version,
         run_status: $run_status,
         protected_value: $protected_value
       }`,
      {
        id: new RecordId("concurrency_probe", input.id),
        owner: input.owner,
        lease_until: input.leaseUntil,
        fence: input.fence ?? 0,
        version: input.version ?? 1,
        run_status: input.runStatus ?? "queued",
        protected_value: input.protectedValue ?? "initial",
      },
    );
  }

  async read(id: string): Promise<ExperimentRecord | null> {
    const rows = await this.db.query<ExperimentRecord[]>(
      "SELECT * FROM ONLY $id",
      { id: new RecordId("concurrency_probe", id) },
    );
    return rows[0] ?? null;
  }

  async claim(input: {
    id: string;
    owner: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<boolean> {
    return this.conditionalUpdate(
      `UPDATE ONLY $id SET owner = $owner, lease_until = $lease_until,
         fence += 1
       WHERE owner = '' OR lease_until <= $now
       RETURN AFTER`,
      {
        id: new RecordId("concurrency_probe", input.id),
        owner: input.owner,
        now: input.now,
        lease_until: input.leaseUntil,
      },
    );
  }

  async renew(input: {
    id: string;
    owner: string;
    fence: number;
    now: Date;
    leaseUntil: Date;
  }): Promise<boolean> {
    return this.conditionalUpdate(
      `UPDATE ONLY $id SET lease_until = $lease_until
       WHERE owner = $owner AND fence = $fence
         AND lease_until > $now AND $lease_until > $now
       RETURN AFTER`,
      {
        id: new RecordId("concurrency_probe", input.id),
        owner: input.owner,
        fence: input.fence,
        now: input.now,
        lease_until: input.leaseUntil,
      },
    );
  }

  async mutateWithFence(input: {
    id: string;
    owner: string;
    fence: number;
    now: Date;
    value: string;
  }): Promise<boolean> {
    return this.conditionalUpdate(
      `UPDATE ONLY $id SET protected_value = $value
       WHERE owner = $owner AND fence = $fence
         AND lease_until > $now AND run_status = 'running'
       RETURN AFTER`,
      {
        id: new RecordId("concurrency_probe", input.id),
        owner: input.owner,
        fence: input.fence,
        now: input.now,
        value: input.value,
      },
    );
  }

  async compareAndSetVersion(input: {
    id: string;
    expectedVersion: number;
  }): Promise<boolean> {
    return this.conditionalUpdate(
      `UPDATE ONLY $id SET version += 1
       WHERE version = $expected_version
       RETURN AFTER`,
      {
        id: new RecordId("concurrency_probe", input.id),
        expected_version: input.expectedVersion,
      },
    );
  }

  async transitionRun(input: {
    id: string;
    expectedStatus: string;
    nextStatus: string;
  }): Promise<boolean> {
    return this.conditionalUpdate(
      `UPDATE ONLY $id SET run_status = $next_status
       WHERE run_status = $expected_status
         AND run_status IN ['queued', 'preparing', 'running', 'reviewing']
       RETURN AFTER`,
      {
        id: new RecordId("concurrency_probe", input.id),
        expected_status: input.expectedStatus,
        next_status: input.nextStatus,
      },
    );
  }

  private async conditionalUpdate(
    statement: string,
    variables: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const rows = await this.db.query<ExperimentRecord[]>(statement, variables);
      return rows.some((row) => row !== undefined);
    } catch (error) {
      if (isSurrealConcurrencyConflict(error)) return false;
      throw error;
    }
  }
}

export async function initializeSurrealConcurrencyExperiment(
  db: Surreal,
): Promise<void> {
  const statements = [
    "DEFINE TABLE IF NOT EXISTS concurrency_probe SCHEMAFULL TYPE NORMAL;",
    "DEFINE FIELD IF NOT EXISTS owner ON concurrency_probe TYPE string;",
    "DEFINE FIELD IF NOT EXISTS lease_until ON concurrency_probe TYPE datetime;",
    "DEFINE FIELD IF NOT EXISTS fence ON concurrency_probe TYPE int;",
    "DEFINE FIELD IF NOT EXISTS version ON concurrency_probe TYPE int;",
    "DEFINE FIELD IF NOT EXISTS run_status ON concurrency_probe TYPE string;",
    "DEFINE FIELD IF NOT EXISTS protected_value ON concurrency_probe TYPE string;",
  ];
  for (const statement of statements) await db.query(statement);
}

export async function connectSurrealConcurrencyExperiment(input: {
  endpoint: string;
  namespace: string;
  database: string;
}): Promise<{
  database: Surreal;
  experiment: SurrealConcurrencyExperiment;
  close: () => Promise<void>;
}> {
  const db = new Surreal();
  try {
    await db.connect(input.endpoint);
    await db.signin({ username: "root", password: "root" });
    await db.query("DEFINE NAMESPACE IF NOT EXISTS $namespace", {
      namespace: input.namespace,
    });
    await db.use({ namespace: input.namespace });
    await db.query("DEFINE DATABASE IF NOT EXISTS $database", {
      database: input.database,
    });
    await db.use({ namespace: input.namespace, database: input.database });
    await initializeSurrealConcurrencyExperiment(db);
    return {
      database: db,
      experiment: new SurrealConcurrencyExperiment(db),
      close: async () => {
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

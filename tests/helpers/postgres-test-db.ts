import { randomUUID } from "node:crypto";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";

/**
 * Hermetic PostgreSQL test database. Unlike the legacy PostgreSQL suites,
 * which share the `ai_office_test` database named by
 * `AI_OFFICE_TEST_POSTGRES_URL`, each instance here is a dedicated database
 * created from the admin connection and dropped with FORCE on dispose, so a
 * suite leaves no schema, data, or migrated state behind. Requires
 * PostgreSQL 13 or later (DROP DATABASE ... WITH (FORCE)).
 */
export interface PostgresTestDatabase {
  readonly name: string;
  readonly connectionString: string;
  readonly client: PostgresClient;
  /** Closes the client, then drops the database. Safe to call once. */
  dispose(): Promise<void>;
}

function withDatabaseName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(
  adminConnectionString: string,
  name: string,
): Promise<void> {
  const admin = new PostgresClient(
    withDatabaseName(adminConnectionString, "postgres"),
  );
  try {
    // Quoted identifier: the name is a fixed prefix literal plus a random
    // UUID; callers never supply arbitrary input.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

export async function createPostgresTestDatabase(options: {
  /** Admin-capable URL, typically `AI_OFFICE_TEST_POSTGRES_URL`. */
  adminConnectionString: string;
  /** Database name prefix; a dashless UUID suffix keeps it unique. */
  prefix?: string;
  migrationDirectory?: string;
}): Promise<PostgresTestDatabase> {
  const name = `${options.prefix ?? "ai_office_test_"}${randomUUID().replaceAll("-", "")}`;
  const connectionString = withDatabaseName(options.adminConnectionString, name);
  const admin = new PostgresClient(
    withDatabaseName(options.adminConnectionString, "postgres"),
  );
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }
  const client = new PostgresClient(connectionString);
  try {
    await migratePostgres(
      client,
      options.migrationDirectory ?? "supabase/migrations",
    );
  } catch (error) {
    await client.close();
    await dropDatabase(options.adminConnectionString, name);
    throw error;
  }
  return {
    name,
    connectionString,
    client,
    async dispose() {
      await client.close();
      await dropDatabase(options.adminConnectionString, name);
    },
  };
}

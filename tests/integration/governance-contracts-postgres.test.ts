import { join } from "node:path";
import { afterAll, beforeAll, describe } from "vitest";
import type { GovernanceEventRecord } from "@ai-office/application/ports/governance-repository.port.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresGovernanceRepository } from "@ai-office/storage-postgres/repositories/postgres-governance.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { defineGovernanceRepositoryContracts } from "../contracts/governance-repository.contract.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");
const tenantId = "governance-contract-tenant";

describe.skipIf(connectionString === undefined)(
  "PostgreSQL governance repository contracts",
  () => {
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
        [tenantId, "Governance Contract Tenant", new Date("2026-01-01T00:00:00.000Z")],
      );
    });

    afterAll(async () => {
      await database.close();
    });

    defineGovernanceRepositoryContracts(async () => ({
      projects: new PostgresProjectRepository(database, tenantId),
      governance: new PostgresGovernanceRepository(database, tenantId),
      async seedEvent(value: GovernanceEventRecord): Promise<void> {
        await database.query(
          `INSERT INTO core.governance_event(
             id, project_id, event_type, aggregate_id, metadata_json, occurred_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            value.id,
            value.projectId,
            value.eventType,
            value.aggregateId,
            value.metadata,
            value.occurredAt,
          ],
        );
      },
      async close(): Promise<void> {},
    }));
  },
);

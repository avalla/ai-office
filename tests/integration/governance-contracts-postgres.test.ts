import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GovernanceEventRecord } from "@ai-office/application/ports/governance-repository.port.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { Project } from "@ai-office/domain/project/project.ts";
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
        [
          tenantId,
          "Governance Contract Tenant",
          new Date("2026-01-01T00:00:00.000Z"),
        ],
      );
    });

    afterAll(async () => {
      await database.close();
    });

    test("a cancel racing the assignment is either waited for or refused", async () => {
      // Two connections: one holds an uncommitted cancel of the target while
      // the other tries the assignment. Without a lock on the milestone row the
      // assignment would read the old status and attach the requirement to a
      // milestone that is about to be cancelled.
      const rival = new PostgresClient(connectionString!);
      try {
        const id = `race-${crypto.randomUUID()}`;
        const at = new Date("2026-01-02T00:00:00.000Z");
        const projects = new PostgresProjectRepository(database, tenantId);
        const governance = new PostgresGovernanceRepository(database, tenantId);
        await projects.save(
          Project.create({ id: `${id}-project`, name: id, now: at }),
        );
        await governance.saveMilestone({
          id: `${id}-milestone`,
          projectId: `${id}-project`,
          title: "Racing",
          status: "planned",
          createdAt: at,
          updatedAt: at,
        });
        await governance.saveRequirement({
          id: `${id}-requirement`,
          projectId: `${id}-project`,
          key: "REQ-RACE",
          title: "Racing",
          description: "Racing",
          status: "proposed",
          createdAt: at,
          updatedAt: at,
        });

        let assignment: Promise<boolean> | undefined;
        await database.transaction(async () => {
          await database.query(
            "UPDATE core.milestone SET status = 'cancelled' WHERE id = $1",
            [`${id}-milestone`],
          );
          assignment = new PostgresGovernanceRepository(
            rival,
            tenantId,
          ).assignRequirementMilestone(
            `${id}-requirement`,
            `${id}-project`,
            `${id}-milestone`,
            at,
            { id: `${id}-event`, metadata: {} },
          );
          // Give the rival time to reach the lock before the cancel commits.
          await new Promise((resolve) => setTimeout(resolve, 300));
        });

        expect(await assignment).toBe(false);
        expect(
          (await governance.getSnapshot(`${id}-project`)).requirements[0]
            ?.milestoneId,
        ).toBeUndefined();
      } finally {
        await rival.close();
      }
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
      async failEventAppend(eventId: string): Promise<void> {
        await database.query(
          `CREATE OR REPLACE FUNCTION core.inject_event_failure()
           RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.id = TG_ARGV[0] THEN
               RAISE EXCEPTION 'injected audit failure';
             END IF;
             RETURN NEW;
           END $$`,
        );
        await database.query(
          `DROP TRIGGER IF EXISTS inject_event_failure ON core.governance_event`,
        );
        await database.query(
          `CREATE TRIGGER inject_event_failure
           BEFORE INSERT ON core.governance_event
           FOR EACH ROW EXECUTE FUNCTION core.inject_event_failure('${eventId.replaceAll("'", "''")}')`,
        );
      },
      async restoreEventAppend(): Promise<void> {
        await database.query(
          "DROP TRIGGER IF EXISTS inject_event_failure ON core.governance_event",
        );
      },
      async close(): Promise<void> {},
    }));
  },
);

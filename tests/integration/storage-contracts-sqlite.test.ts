import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe } from "vitest";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import { SqliteProjectDefinitionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-definition.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";
import { SqliteTaskRequirementRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-requirement.repository.ts";
import { defineProjectStorageContracts } from "../contracts/project-storage.contract.ts";

const migrationDirectory = join(process.cwd(), "migrations", "project");

describe("SQLite project storage contracts", () => {
  defineProjectStorageContracts(
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ai-office-sqlite-contract-"));
      const database = openDatabase(join(root, "project.sqlite"));
      migrate(database, migrationDirectory);

      return {
        projects: new SqliteProjectRepository(database),
        packBindings: new SqliteProjectPackBindingRepository(database),
        definitions: new SqliteProjectDefinitionRepository(database),
        async deleteProject(projectId: string): Promise<void> {
          database.query("DELETE FROM project WHERE id = ?").run(projectId);
        },
        async bindingRowCounts(projectId: string) {
          const count = (
            table: "project_pack_binding" | "project_pack_binding_pack",
          ) =>
            database
              .query<{ count: number }, [string]>(
                `SELECT count(*) AS count FROM ${table} WHERE project_id = ?`,
              )
              .get(projectId)!.count;
          return {
            heads: count("project_pack_binding"),
            packs: count("project_pack_binding_pack"),
          };
        },
        async definitionPayloadShapes(projectId: string) {
          return database
            .query<
              {
                table_name: "owned" | "override";
                local_id: string;
                json_type: string | null;
                title: string | null;
              },
              [string, string]
            >(
              // payload_json is TEXT guarded by json_valid on SQLite.
              `SELECT 'owned' AS table_name, local_id,
                      json_type(payload_json) AS json_type,
                      json_extract(payload_json, '$.title') AS title
                 FROM project_owned_definition WHERE project_id = ?
               UNION ALL
               SELECT 'override', local_id, json_type(payload_json),
                      json_extract(payload_json, '$.title')
                 FROM project_definition_override WHERE project_id = ?`,
            )
            .all(projectId, projectId)
            .map((row) => ({
              table: row.table_name,
              localId: row.local_id,
              jsonType: row.json_type,
              title: row.title,
            }));
        },
        async definitionRowCounts(projectId: string) {
          const count = (
            table:
              | "project_definition_head"
              | "project_owned_definition"
              | "project_definition_override",
          ) =>
            database
              .query<{ count: number }, [string]>(
                `SELECT count(*) AS count FROM ${table} WHERE project_id = ?`,
              )
              .get(projectId)!.count;
          return {
            heads: count("project_definition_head"),
            owned: count("project_owned_definition"),
            overrides: count("project_definition_override"),
          };
        },
        tasks: new SqliteTaskRepository(database),
        taskDependencies: new SqliteTaskDependencyRepository(database),
        taskRequirements: new SqliteTaskRequirementRepository(database),
        transactions: new SqliteTransactionRunner(database),
        async seedRequirement(input: {
          id: string;
          projectId: string;
          key: string;
          title: string;
          status: RequirementStatus;
        }): Promise<void> {
          database
            .prepare(
              `INSERT INTO requirement(
              id, project_id, requirement_key, title, description, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.id,
              input.projectId,
              input.key,
              input.title,
              input.title,
              input.status,
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
            );
        },
        async close(): Promise<void> {
          database.close();
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
    { packBindings: true, definitions: true },
  );
});

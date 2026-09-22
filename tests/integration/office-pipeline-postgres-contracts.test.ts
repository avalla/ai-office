import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresOfficeManifestRepository } from "@ai-office/storage-postgres/repositories/postgres-office-manifest.repository.ts";
import { PostgresPipelineRunRepository } from "@ai-office/storage-postgres/repositories/postgres-pipeline-run.repository.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficeManifestContractFixture } from "../contracts/office-manifest-repository.contract.ts";
import { defineOfficeManifestRepositoryContracts } from "../contracts/office-manifest-repository.contract.ts";
import type { PipelineRunContractFixture } from "../contracts/pipeline-run-repository.contract.ts";
import { definePipelineRunRepositoryContracts } from "../contracts/pipeline-run-repository.contract.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = `${process.cwd()}/supabase/migrations`;
const tenantId = "office-pipeline-contract-tenant";
let database: PostgresClient;

describe.skipIf(connectionString === undefined)(
  "PostgreSQL OfficeManifestRepository and PipelineRunRepository",
  () => {
    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
      await database.query(
        `INSERT INTO core.tenant(id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING`,
        [
          tenantId,
          "Office pipeline contract tenant",
          new Date("2026-01-01T00:00:00.000Z"),
        ],
      );
    });

    afterAll(async () => {
      await database.query(
        `ALTER TABLE core.pipeline_override DISABLE TRIGGER pipeline_override_prevent_delete;
         DELETE FROM core.pipeline_override
         WHERE project_id LIKE 'manifest-project%'
            OR project_id LIKE 'pipeline-project%'
            OR project_id LIKE 'cas-project%'
            OR project_id LIKE 'terminal-project%'
            OR project_id LIKE 'override-project%' OR project_id LIKE 'foreign-project%';
         ALTER TABLE core.pipeline_override ENABLE TRIGGER pipeline_override_prevent_delete;
         DELETE FROM core.pipeline_stage_run
         WHERE project_id LIKE 'manifest-project%'
            OR project_id LIKE 'pipeline-project%'
            OR project_id LIKE 'cas-project%'
            OR project_id LIKE 'terminal-project%'
            OR project_id LIKE 'override-project%' OR project_id LIKE 'foreign-project%';
         DELETE FROM core.pipeline_run
         WHERE project_id LIKE 'manifest-project%'
            OR project_id LIKE 'pipeline-project%'
            OR project_id LIKE 'cas-project%'
            OR project_id LIKE 'terminal-project%'
            OR project_id LIKE 'override-project%' OR project_id LIKE 'foreign-project%';
         DELETE FROM core.project
         WHERE id LIKE 'manifest-project%'
            OR id LIKE 'pipeline-project%'
            OR id LIKE 'cas-project%'
            OR id LIKE 'terminal-project%'
            OR id LIKE 'override-project%' OR id LIKE 'foreign-project%'`,
      );
      await database.query(
        "DELETE FROM core.tenant WHERE id = 'office-pipeline-foreign-tenant'",
      );
      await database.close();
    });

    async function createFixture(): Promise<
      OfficeManifestContractFixture & PipelineRunContractFixture
    > {
      const projects = new PostgresProjectRepository(database, tenantId);
      const tasks = new PostgresTaskRepository(database, tenantId);
      const manifests = new PostgresOfficeManifestRepository(
        database,
        tenantId,
      );
      const pipelines = new PostgresPipelineRunRepository(database, tenantId);
      const runtime = new PostgresAgentRuntimeRepository(database, tenantId);
      return {
        projects,
        tasks,
        manifests,
        pipelines,
        transactions: new PostgresTransactionRunner(database),
        async prepareAgents(projectId: string): Promise<void> {
          const now = new Date("2026-09-22T00:00:00.000Z");
          for (const [key, id] of [
            ["developer", "agent-1"],
            ["reviewer", "agent-2"],
          ] as const) {
            const role = Role.create({
              id: `${projectId}-role-${key}`,
              projectId,
              key,
              name: key,
              version: 1,
              capabilities: [],
              tools: [],
              modelPolicy: "default",
              limits: {
                maxIterations: 1,
                maxCostMicros: 0n,
                timeoutSeconds: 60,
              },
              sourcePath: `${key}.yaml`,
              now,
            });
            await runtime.saveRole(role);
            await runtime.saveAgent({
              id: `${projectId}-${id}`,
              projectId,
              roleId: role.snapshot().id,
              name: key,
              enabled: true,
              createdAt: now,
              updatedAt: now,
            });
          }
        },
        async close(): Promise<void> {
          await database.query(
            `ALTER TABLE core.pipeline_override DISABLE TRIGGER pipeline_override_prevent_delete;
             DELETE FROM core.pipeline_override
             WHERE project_id LIKE 'manifest-project%'
                OR project_id LIKE 'pipeline-project%'
                OR project_id LIKE 'cas-project%'
                OR project_id LIKE 'terminal-project%'
                OR project_id LIKE 'override-project%' OR project_id LIKE 'foreign-project%';
             ALTER TABLE core.pipeline_override ENABLE TRIGGER pipeline_override_prevent_delete;
             DELETE FROM core.pipeline_stage_run
             WHERE project_id LIKE 'manifest-project%'
                OR project_id LIKE 'pipeline-project%'
                OR project_id LIKE 'cas-project%'
                OR project_id LIKE 'terminal-project%'
                OR project_id LIKE 'override-project%' OR project_id LIKE 'foreign-project%';
             DELETE FROM core.pipeline_run
             WHERE project_id LIKE 'manifest-project%'
                OR project_id LIKE 'pipeline-project%'
                OR project_id LIKE 'cas-project%'
                OR project_id LIKE 'terminal-project%'
                OR project_id LIKE 'override-project%' OR project_id LIKE 'foreign-project%';
             DELETE FROM core.project
             WHERE id LIKE 'manifest-project%'
                OR id LIKE 'pipeline-project%'
                OR id LIKE 'cas-project%'
                OR id LIKE 'terminal-project%'
                OR id LIKE 'override-project%' OR id LIKE 'foreign-project%'`,
          );
        },
      };
    }

    defineOfficeManifestRepositoryContracts(createFixture);
    definePipelineRunRepositoryContracts(createFixture);

    test("does not read or write another tenant's manifest and pipeline rows", async () => {
      const fixture = await createFixture();
      const now = new Date("2026-09-22T00:00:00.000Z");
      try {
        await database.query(
          `INSERT INTO core.tenant(id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING`,
          ["office-pipeline-foreign-tenant", "Foreign", now],
        );
        await database.query(
          `INSERT INTO core.project(id, name, tenant_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [
            "foreign-project-tenant-b",
            "Foreign",
            "office-pipeline-foreign-tenant",
            now,
          ],
        );
        await database.query(
          `INSERT INTO core.task(id, project_id, title, status, priority, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', 0, $4, $4)`,
          [
            "foreign-project-task",
            "foreign-project-tenant-b",
            "Foreign task",
            now,
          ],
        );
        await database.query(
          `INSERT INTO core.office_manifest_revision(
             id, project_id, revision, schema_version, manifest_json,
             source_host, source_skill, source_skill_version, applied_at
           ) VALUES ($1, $2, 1, 1, $3::jsonb, 'codex', 'ai-office', '1.0.0', $4)`,
          [
            "foreign-project-manifest",
            "foreign-project-tenant-b",
            {
              schemaVersion: 1,
              provenance: {
                host: "codex",
                skill: "ai-office",
                skillVersion: "1.0.0",
              },
            },
            now,
          ],
        );
        await database.query(
          `INSERT INTO core.pipeline_run(
             id, project_id, task_id, manifest_revision_id, manifest_revision,
             definition_json, status, current_stage_index, started_by, version,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 1, $5::jsonb, 'active', 0, 'runtime', 1, $6, $6)`,
          [
            "foreign-project-run",
            "foreign-project-tenant-b",
            "foreign-project-task",
            "foreign-project-manifest",
            {
              id: "delivery",
              name: "Delivery",
              description: "Foreign",
              defaultFor: ["feature"],
              stages: [
                {
                  id: "build",
                  name: "Build",
                  roleId: "developer",
                  objective: "Build",
                  checks: [],
                  requiresApproval: false,
                },
              ],
            },
            now,
          ],
        );
        await expect(
          fixture.manifests.findLatest("foreign-project-tenant-b"),
        ).resolves.toBeNull();
        await expect(
          fixture.pipelines.findById(
            "foreign-project-run",
            "foreign-project-tenant-b",
          ),
        ).resolves.toBeNull();
      } finally {
        await fixture.close();
      }
    });

    test("keeps legacy projection rows compatible with worker-fence updates", async () => {
      const fixture = await createFixture();
      const projectId = "pipeline-project-legacy";
      const taskId = "pipeline-project-legacy-task";
      const stageId = "pipeline-project-legacy-stage";
      const now = new Date("2026-09-22T00:00:00.000Z");
      try {
        await fixture.projects.save(
          Project.create({ id: projectId, name: projectId, now }),
        );
        await fixture.tasks.save(
          Task.create({ id: taskId, projectId, title: "Legacy", now }),
        );
        await fixture.prepareAgents?.(projectId);
        await database.query(
          `INSERT INTO core.pipeline_run(
             id, project_id, task_id, status, current_stage_index, version,
             created_at, updated_at
           ) VALUES ($1, $2, $3, 'active', 0, 1, $4, $4)`,
          ["pipeline-project-legacy-run", projectId, taskId, now],
        );
        await database.query(
          `INSERT INTO core.pipeline_stage_run(
             id, pipeline_run_id, project_id, stage_id, stage_index, role_id,
             status, assigned_agent_id
           ) VALUES ($1, $2, $3, 'build', 0, 'developer', 'active', $4)`,
          [
            stageId,
            "pipeline-project-legacy-run",
            projectId,
            `${projectId}-agent-1`,
          ],
        );

        await expect(
          database.query(
            "UPDATE core.pipeline_run SET current_stage_index = 1, version = 2, updated_at = $2 WHERE id = $1",
            ["pipeline-project-legacy-run", new Date(now.getTime() + 1)],
          ),
        ).resolves.toBeDefined();
        await expect(
          database.query(
            "UPDATE core.pipeline_stage_run SET assigned_agent_id = NULL WHERE id = $1",
            [stageId],
          ),
        ).resolves.toBeDefined();
        await expect(
          database.query(
            "SELECT id, current_stage_index, version FROM core.pipeline_run WHERE id = $1",
            ["pipeline-project-legacy-run"],
          ),
        ).resolves.toEqual([
          {
            id: "pipeline-project-legacy-run",
            current_stage_index: 1,
            version: 2,
          },
        ]);
      } finally {
        await fixture.close();
      }
    });

    test("rolls back the whole run when a stage insert fails", async () => {
      const fixture = await createFixture();
      const now = new Date("2026-09-22T00:00:00.000Z");
      const projectId = "pipeline-project-atomic";
      const taskId = "pipeline-project-atomic-task";
      const manifestId = "pipeline-project-atomic-manifest";
      try {
        await fixture.projects.save(
          Project.create({ id: projectId, name: projectId, now }),
        );
        await fixture.tasks.save(
          Task.create({ id: taskId, projectId, title: "Atomic", now }),
        );
        await fixture.manifests.save({
          id: manifestId,
          projectId,
          revision: 1,
          manifest: {
            schemaVersion: 1,
            provenance: {
              host: "codex",
              skill: "ai-office",
              skillVersion: "1.0.0",
            },
            project: {
              mission: "Atomic",
              goals: ["Ship"],
              constraints: [],
              preferences: [],
              permissionPreferences: [],
            },
            office: {
              name: "Atomic office",
              roles: [
                {
                  id: "developer",
                  title: "Developer",
                  purpose: "Build",
                  responsibilities: ["Build"],
                },
              ],
            },
            pipelines: [
              {
                id: "delivery",
                name: "Delivery",
                description: "Atomic",
                defaultFor: ["feature"],
                enforcement: "enforced",
                stages: [
                  {
                    id: "build",
                    name: "Build",
                    roleId: "developer",
                    objective: "Build",
                    checks: ["Tests"],
                    requiresApproval: false,
                    capabilities: ["filesystem.read"],
                  },
                ],
              },
            ],
          },
          appliedAt: now,
        });
        const run = PipelineRun.create({
          id: "pipeline-project-atomic-run",
          projectId,
          taskId,
          manifestRevisionId: manifestId,
          manifestRevision: 1,
          definition: {
            id: "delivery",
            name: "Delivery",
            description: "Atomic",
            defaultFor: ["feature"],
            enforcement: "enforced",
            stages: [
              {
                id: "build",
                name: "Build",
                roleId: "developer",
                objective: "Build",
                checks: ["Tests"],
                requiresApproval: false,
                capabilities: ["filesystem.read"],
              },
            ],
          },
          startedBy: "runtime",
          stageRunIds: ["pipeline-project-atomic-stage"],
          now,
        });
        const snapshot = run.snapshot();
        const broken = PipelineRun.restore({
          ...snapshot,
          stages: [
            ...snapshot.stages,
            {
              ...snapshot.stages[0]!,
              id: snapshot.stages[0]!.id,
              stageIndex: 1,
            },
          ],
        });
        await expect(fixture.pipelines.insert(broken)).rejects.toBeDefined();
        await expect(
          fixture.pipelines.findById(snapshot.id, projectId),
        ).resolves.toBeNull();
      } finally {
        await fixture.close();
      }
    });
  },
);

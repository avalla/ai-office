import { RecordId, Surreal } from "surrealdb";
import { createSurrealProjectStorageSubsetExperiment } from "../project-storage-subset.ts";

export interface SurrealProjectStorageSubsetHarness {
  experiment: Awaited<ReturnType<typeof createSurrealProjectStorageSubsetExperiment>>;
  seedRequirement(input: {
    id: string;
    tenantId: string;
    projectId: string;
    key: string;
    title: string;
    status: string;
  }): Promise<void>;
  projectOwnsTask(projectId: string, taskId: string): Promise<boolean>;
  createRelationWithMissingEndpoints(taskId: string, requirementId: string): Promise<void>;
  close(): Promise<void>;
}

export async function connectSurrealProjectStorageSubsetHarness(input: {
  endpoint: string;
  namespace: string;
  database: string;
  tenantId: string;
}): Promise<SurrealProjectStorageSubsetHarness> {
  const db = new Surreal();
  try {
    await db.connect(input.endpoint);
    await db.signin({ username: "root", password: "root" });
    await db.query("DEFINE NAMESPACE IF NOT EXISTS $namespace", { namespace: input.namespace });
    await db.use({ namespace: input.namespace });
    await db.query("DEFINE DATABASE IF NOT EXISTS $database", { database: input.database });
    await db.use({ namespace: input.namespace, database: input.database });
    const experiment = await createSurrealProjectStorageSubsetExperiment(db, input.tenantId);
    return {
      experiment,
      async seedRequirement(value): Promise<void> {
        await db.query(
          `CREATE ONLY type::record('office_requirement', $key) CONTENT {
             tenant_id: $tenant, project_id: $project, external_id: $external_id,
             requirement_key: $requirement_key, title: $title, status: $status
           }`,
          {
            key: encodeURIComponent(value.id),
            tenant: value.tenantId,
            project: value.projectId,
            external_id: value.id,
            requirement_key: value.key,
            title: value.title,
            status: value.status,
          },
        );
      },
      async projectOwnsTask(projectId: string, taskId: string): Promise<boolean> {
        const [rows] = await db.query<[Record<string, unknown>[]]>(
          `SELECT id FROM office_project_task
           WHERE in = type::record('office_project', $project_key)
             AND out = type::record('office_task', $task_key)
             AND tenant_id = $tenant AND project_id = $project LIMIT 1`,
          {
            project_key: encodeURIComponent(projectId),
            task_key: encodeURIComponent(taskId),
            tenant: input.tenantId,
            project: projectId,
          },
        );
        return (rows?.length ?? 0) > 0;
      },
      async createRelationWithMissingEndpoints(taskId: string, requirementId: string): Promise<void> {
        await db.query(
          `RELATE ONLY $task_record->office_task_requirement->$requirement_record`,
          {
            task_record: new RecordId("office_task", encodeURIComponent(taskId)),
            requirement_record: new RecordId("office_requirement", encodeURIComponent(requirementId)),
          },
        );
      },
      close: async () => { await db.close(); },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

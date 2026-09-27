import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import { Project, type ProjectId } from "@ai-office/domain/project/project.ts";
import type { Surreal } from "surrealdb";
import { querySurreal, withSurrealTransaction } from "./transaction-context.ts";

type Row = Record<string, unknown>;

export class SurrealProjectRepository implements ProjectRepository {
  constructor(
    private readonly db: Surreal,
    private readonly tenantId: string,
  ) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const [rows] = await querySurreal<[Row[]]>(this.db,
      "SELECT * FROM type::record('office_project', $key) WHERE tenant_id = $tenant LIMIT 1",
      { key: recordKey(id), tenant: this.tenantId },
    );
    const row = rows?.[0];
    if (row === undefined) return null;
    return Project.restore({
      id: String(row.external_id),
      name: String(row.name),
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at),
    });
  }

  async save(project: Project): Promise<void> {
    const value = project.snapshot();
    await withSurrealTransaction(this.db, async () => querySurreal(this.db,
      `LET $updated = (UPDATE type::record('office_project', $key)
         MERGE { name: $name, description: $description, updated_at: $updated_at }
         WHERE tenant_id = $tenant RETURN AFTER);
       IF array::len($updated) = 0 {
         CREATE ONLY type::record('office_project', $key) CONTENT {
           tenant_id: $tenant, external_id: $external_id, name: $name,
           description: $description, created_at: $created_at, updated_at: $updated_at
         };
       };`,
      {
        key: recordKey(value.id),
        tenant: this.tenantId,
        external_id: value.id,
        name: value.name,
        description: value.description,
        created_at: value.createdAt,
        updated_at: value.updatedAt,
      },
    ));
  }
}

export function recordKey(id: string): string {
  return encodeURIComponent(id);
}

export function asDate(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

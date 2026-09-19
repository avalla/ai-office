import type { ProjectId } from "@ai-office/domain/project/project.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";
import { requirePostgresTenantId } from "../database/postgres-tenant-context.ts";

export {
  PostgresProjectTenantConflictError,
} from "@ai-office/application/ports/project-tenant-errors.ts";
import { PostgresProjectTenantConflictError } from "@ai-office/application/ports/project-tenant-errors.ts";

interface ProjectRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PostgresProjectRepository implements ProjectRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async findById(id: ProjectId): Promise<Project | null> {
    const [row] = await this.database.query<ProjectRow>(
      `
        SELECT id, name, description, created_at, updated_at
        FROM core.project
        WHERE id = $1 AND tenant_id = $2
      `,
      [id, this.tenantId],
    );
    if (row === undefined) return null;

    return Project.restore({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    });
  }

  async save(project: Project): Promise<void> {
    const value = project.snapshot();
    const rows = await this.database.query<{ id: string }>(
      `
        INSERT INTO core.project(
          id, name, description, created_at, updated_at, tenant_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          updated_at = excluded.updated_at
        WHERE core.project.tenant_id = excluded.tenant_id
        RETURNING id
      `,
      [
        value.id,
        value.name,
        value.description ?? null,
        value.createdAt,
        value.updatedAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1)
      throw new PostgresProjectTenantConflictError(value.id);
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

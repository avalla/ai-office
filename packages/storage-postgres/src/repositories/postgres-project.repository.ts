import type { ProjectId } from "@ai-office/domain/project/project.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";

interface ProjectRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly database: PostgresClient) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const [row] = await this.database.query<ProjectRow>(
      `
        SELECT id, name, description, created_at, updated_at
        FROM core.project
        WHERE id = $1
      `,
      [id],
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
    await this.database.query(
      `
        INSERT INTO core.project(id, name, description, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          updated_at = excluded.updated_at
      `,
      [
        value.id,
        value.name,
        value.description ?? null,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

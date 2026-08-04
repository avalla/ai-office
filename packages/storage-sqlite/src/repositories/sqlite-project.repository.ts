import type { Database } from "bun:sqlite";
import { Project } from "@ai-office/domain/project/project.ts";
import type { ProjectId } from "@ai-office/domain/project/project.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: Database) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const row = this.database
      .query<ProjectRow, [string]>(`
        SELECT id, name, description, created_at, updated_at
        FROM project
        WHERE id = ?
      `)
      .get(id);

    if (row === null) return null;

    return Project.restore({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    });
  }

  async save(project: Project): Promise<void> {
    const value = project.snapshot();

    this.database
      .prepare(`
        INSERT INTO project(id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          updated_at = excluded.updated_at
      `)
      .run(
        value.id,
        value.name,
        value.description ?? null,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString()
      );
  }
}

import type { Database } from "bun:sqlite";
import type {
  RepositoryIdentityAssociation,
  RepositoryIdentityRepository,
} from "@ai-office/application/ports/repository-identity-repository.port.ts";

interface ProjectRow {
  project_id: string;
}

interface RepositoryRow {
  repository_id: string;
}

export class SqliteRepositoryIdentityRepository
  implements RepositoryIdentityRepository
{
  constructor(private readonly database: Database) {}

  async findProjectId(repositoryId: string): Promise<string | null> {
    return (
      this.database
        .query<ProjectRow, [string]>(
          `SELECT project_id
           FROM project_repository_identity
           WHERE repository_id = ?`,
        )
        .get(repositoryId)?.project_id ?? null
    );
  }

  async findRepositoryId(projectId: string): Promise<string | null> {
    return (
      this.database
        .query<RepositoryRow, [string]>(
          `SELECT repository_id
           FROM project_repository_identity
           WHERE project_id = ?`,
        )
        .get(projectId)?.repository_id ?? null
    );
  }

  async associate(
    association: RepositoryIdentityAssociation,
  ): Promise<"created" | "existing" | "conflict"> {
    const result = this.database
      .prepare(
        `INSERT INTO project_repository_identity(repository_id, project_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        association.repositoryId,
        association.projectId,
        association.createdAt.toISOString(),
      );
    if (result.changes === 1) return "created";
    const projectId = await this.findProjectId(association.repositoryId);
    const repositoryId = await this.findRepositoryId(association.projectId);
    return projectId === association.projectId &&
      repositoryId === association.repositoryId
      ? "existing"
      : "conflict";
  }
}

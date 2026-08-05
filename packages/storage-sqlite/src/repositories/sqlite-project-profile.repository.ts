import type { Database } from "bun:sqlite";
import type { ProjectProfileRepository } from "@ai-office/application/ports/project-profile-repository.port.ts";
import type { ProjectProfileEntry } from "@ai-office/domain/project/project-profile.ts";

export class SqliteProjectProfileRepository implements ProjectProfileRepository {
  constructor(private readonly database: Database) {}

  async saveMany(entries: ProjectProfileEntry[]): Promise<void> {
    const statement = this.database.prepare(`
      INSERT INTO project_profile_entry(
        id, project_id, category, key, value_json, origin, confidence,
        source_reference, confirmed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.database.transaction(() => {
      for (const entry of entries) {
        statement.run(
          entry.id,
          entry.projectId,
          entry.category,
          entry.key,
          JSON.stringify(entry.value),
          entry.origin,
          entry.confidence,
          entry.sourceReference ?? null,
          entry.confirmedAt?.toISOString() ?? null,
          entry.createdAt.toISOString()
        );
      }
    })();
  }
}

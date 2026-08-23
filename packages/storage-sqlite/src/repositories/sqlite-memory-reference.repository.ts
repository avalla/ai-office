import type { Database } from "bun:sqlite";
import type { MemoryReferenceRepository } from "@ai-office/application/ports/memory-reference-repository.port.ts";
import { MemoryReference } from "@ai-office/domain/memory/memory-reference.ts";
import type { MemoryReferenceProps } from "@ai-office/domain/memory/memory-reference.ts";

interface ReferenceRow {
  id: string;
  project_id: string;
  target_id: string;
  target_version: number;
  target_type: string;
  reference_type: string;
  query: string | null;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

function restoreReference(row: ReferenceRow): MemoryReference {
  const props: MemoryReferenceProps = {
    id: row.id,
    projectId: row.project_id,
    targetId: row.target_id,
    targetVersion: row.target_version,
    targetType: row.target_type as "pattern",
    referenceType: row.reference_type as "adopted",
    ...(row.query === null ? {} : { query: row.query }),
    usageCount: row.usage_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  return MemoryReference.restore(props);
}

export class SqliteMemoryReferenceRepository implements MemoryReferenceRepository {
  constructor(private readonly database: Database) {}

  async saveReference(reference: MemoryReference): Promise<string> {
    const value = reference.snapshot();
    return this.database.transaction(() => {
      const existing = this.database
        .query<{ id: string }, [string, string, string, number, string]>(
          `SELECT id FROM project_memory_reference
           WHERE project_id = ? AND target_type = ? AND target_id = ?
             AND target_version = ? AND reference_type = ?`,
        )
        .get(
          value.projectId,
          value.targetType,
          value.targetId,
          value.targetVersion,
          value.referenceType,
        );
      if (existing !== null) {
        this.database
          .prepare(
            `UPDATE project_memory_reference
             SET usage_count = usage_count + 1,
               query = COALESCE(?, query), updated_at = ?
             WHERE id = ?`,
          )
          .run(value.query ?? null, value.updatedAt.toISOString(), existing.id);
        return existing.id;
      }
      this.database
        .prepare(
          `INSERT INTO project_memory_reference(
            id, project_id, target_type, target_id, target_version,
            reference_type, query, usage_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.projectId,
          value.targetType,
          value.targetId,
          value.targetVersion,
          value.referenceType,
          value.query ?? null,
          value.usageCount,
          value.createdAt.toISOString(),
          value.updatedAt.toISOString(),
        );
      return value.id;
    })();
  }

  async listReferences(projectId: string): Promise<readonly MemoryReference[]> {
    return this.database
      .query<ReferenceRow, [string]>(
        `SELECT * FROM project_memory_reference
         WHERE project_id = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(projectId)
      .map(restoreReference);
  }
}

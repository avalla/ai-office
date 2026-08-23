import type { Database } from "bun:sqlite";
import type {
  GlobalMemoryRepository,
  MemorySearchResult,
} from "@ai-office/application/ports/global-memory-repository.port.ts";
import { GlobalMemoryVersionConflictError } from "@ai-office/application/memory-errors.ts";
import { GlobalLesson } from "@ai-office/domain/memory/global-lesson.ts";
import type { GlobalLessonProps } from "@ai-office/domain/memory/global-lesson.ts";
import { GlobalPattern } from "@ai-office/domain/memory/global-pattern.ts";
import type { GlobalPatternProps } from "@ai-office/domain/memory/global-pattern.ts";
import { GlobalRole } from "@ai-office/domain/memory/global-role.ts";
import type {
  GlobalRoleDefinition,
  GlobalRoleProps,
  MemoryStatus,
} from "@ai-office/domain/memory/global-role.ts";
import type { MemoryTargetType } from "@ai-office/domain/memory/memory-reference.ts";

interface RoleRow {
  id: string;
  name: string;
  version: number;
  definition_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PatternRow {
  id: string;
  version: number;
  name: string;
  problem: string;
  context: string;
  solution: string;
  applicability_json: string;
  constraints_json: string;
  risks_json: string;
  status: string;
  source_project_id: string | null;
  success_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

interface LessonRow {
  id: string;
  source_project_id: string | null;
  source_task_id: string | null;
  title: string;
  content: string;
  confidence: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SearchRow {
  type: MemoryTargetType;
  id: string;
  version: number | null;
  name: string;
  summary: string;
  status: MemoryStatus;
  score: number;
}

function stringArray(value: string): readonly string[] {
  return JSON.parse(value) as readonly string[];
}

function roleDefinition(value: string): GlobalRoleDefinition {
  return JSON.parse(value) as GlobalRoleDefinition;
}

function restoreRole(row: RoleRow): GlobalRole {
  const props: GlobalRoleProps = {
    id: row.id,
    name: row.name,
    version: row.version,
    definition: roleDefinition(row.definition_json),
    status: row.status as MemoryStatus,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  return GlobalRole.restore(props);
}

function restorePattern(row: PatternRow): GlobalPattern {
  const props: GlobalPatternProps = {
    id: row.id,
    version: row.version,
    name: row.name,
    problem: row.problem,
    context: row.context,
    solution: row.solution,
    applicability: stringArray(row.applicability_json),
    constraints: stringArray(row.constraints_json),
    risks: stringArray(row.risks_json),
    status: row.status as MemoryStatus,
    ...(row.source_project_id === null
      ? {}
      : { sourceProjectId: row.source_project_id }),
    successCount: row.success_count,
    failureCount: row.failure_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  return GlobalPattern.restore(props);
}

function restoreLesson(row: LessonRow): GlobalLesson {
  const props: GlobalLessonProps = {
    id: row.id,
    ...(row.source_project_id === null
      ? {}
      : { sourceProjectId: row.source_project_id }),
    ...(row.source_task_id === null
      ? {}
      : { sourceTaskId: row.source_task_id }),
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    status: row.status as MemoryStatus,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  return GlobalLesson.restore(props);
}

export class SqliteGlobalMemoryRepository implements GlobalMemoryRepository {
  constructor(private readonly database: Database) {}

  async saveRole(role: GlobalRole): Promise<void> {
    const value = role.snapshot();
    const save = this.database.transaction(() => {
      const latest = this.database
        .query<{ id: string; version: number }, [string]>(
          `SELECT id, version FROM global_role
           WHERE json_extract(definition_json, '$.key') = ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(value.definition.key);
      if (
        latest !== null &&
        (latest.id !== value.id || value.version <= latest.version)
      )
        throw new GlobalMemoryVersionConflictError(
          "role",
          latest.id,
          value.version,
          latest.version,
        );
      this.database
        .prepare(
          `INSERT INTO global_role(
            id, name, version, definition_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.name,
          value.version,
          JSON.stringify(value.definition),
          value.status,
          value.createdAt.toISOString(),
          value.updatedAt.toISOString(),
        );
    });
    try {
      save();
    } catch (error) {
      if (error instanceof GlobalMemoryVersionConflictError) throw error;
      const latest = this.database
        .query<{ id: string; version: number }, [string]>(
          `SELECT id, version FROM global_role
           WHERE json_extract(definition_json, '$.key') = ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(value.definition.key);
      if (latest !== null)
        throw new GlobalMemoryVersionConflictError(
          "role",
          latest.id,
          value.version,
          latest.version,
        );
      throw error;
    }
  }

  async updateRoleStatus(role: GlobalRole): Promise<void> {
    const value = role.snapshot();
    this.database
      .prepare(
        `UPDATE global_role SET status = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        value.status,
        value.updatedAt.toISOString(),
        value.id,
        value.version,
      );
  }

  async findRole(id: string, version: number): Promise<GlobalRole | null> {
    const row = this.database
      .query<RoleRow, [string, number]>(
        "SELECT * FROM global_role WHERE id = ? AND version = ?",
      )
      .get(id, version);
    return row === null ? null : restoreRole(row);
  }

  async findLatestRole(id: string): Promise<GlobalRole | null> {
    const row = this.database
      .query<RoleRow, [string]>(
        `SELECT * FROM global_role
         WHERE id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(id);
    return row === null ? null : restoreRole(row);
  }

  async findLatestRoleByKey(key: string): Promise<GlobalRole | null> {
    const row = this.database
      .query<RoleRow, [string]>(
        `SELECT * FROM global_role
         WHERE json_extract(definition_json, '$.key') = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(key);
    return row === null ? null : restoreRole(row);
  }

  async savePattern(pattern: GlobalPattern): Promise<void> {
    const value = pattern.snapshot();
    this.database
      .prepare(
        `INSERT INTO pattern(
          id, version, name, problem, context, solution, applicability_json,
          constraints_json, risks_json, status, source_project_id,
          success_count, failure_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, version) DO UPDATE SET
          name = excluded.name,
          problem = excluded.problem,
          context = excluded.context,
          solution = excluded.solution,
          applicability_json = excluded.applicability_json,
          constraints_json = excluded.constraints_json,
          risks_json = excluded.risks_json,
          status = excluded.status,
          source_project_id = excluded.source_project_id,
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          updated_at = excluded.updated_at`,
      )
      .run(
        value.id,
        value.version,
        value.name,
        value.problem,
        value.context,
        value.solution,
        JSON.stringify(value.applicability),
        JSON.stringify(value.constraints),
        JSON.stringify(value.risks),
        value.status,
        value.sourceProjectId ?? null,
        value.successCount,
        value.failureCount,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString(),
      );
  }

  async findPattern(
    id: string,
    version: number,
  ): Promise<GlobalPattern | null> {
    const row = this.database
      .query<PatternRow, [string, number]>(
        "SELECT * FROM pattern WHERE id = ? AND version = ?",
      )
      .get(id, version);
    return row === null ? null : restorePattern(row);
  }

  async saveLesson(lesson: GlobalLesson): Promise<void> {
    const value = lesson.snapshot();
    this.database
      .prepare(
        `INSERT INTO lesson(
          id, source_project_id, source_task_id, title, content, confidence,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_project_id = excluded.source_project_id,
          source_task_id = excluded.source_task_id,
          title = excluded.title,
          content = excluded.content,
          confidence = excluded.confidence,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        value.id,
        value.sourceProjectId ?? null,
        value.sourceTaskId ?? null,
        value.title,
        value.content,
        value.confidence,
        value.status,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString(),
      );
  }

  async findLesson(id: string): Promise<GlobalLesson | null> {
    const row = this.database
      .query<LessonRow, [string]>("SELECT * FROM lesson WHERE id = ?")
      .get(id);
    return row === null ? null : restoreLesson(row);
  }

  async search(
    query: string,
    limit: number,
  ): Promise<readonly MemorySearchResult[]> {
    const normalized = query.trim().toLowerCase();
    const rows = this.database
      .query<
        SearchRow,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
        ]
      >(
        `SELECT type, id, version, name, summary, status, score
         FROM (
           SELECT
             'role' AS type,
             id,
             version,
             name,
             json_extract(definition_json, '$.description') AS summary,
             status,
             CASE
               WHEN lower(name) = ? THEN 1.0
               WHEN lower(name) LIKE ? THEN 0.9
               ELSE 0.7
             END AS score
           FROM global_role
           WHERE status = 'active'
             AND instr(lower(name || ' ' || definition_json), ?) > 0
           UNION ALL
           SELECT
             'pattern', id, version, name, solution, status,
             CASE
               WHEN lower(name) = ? THEN 1.0
               WHEN lower(name) LIKE ? THEN 0.9
               ELSE 0.7
             END
           FROM pattern
           WHERE status = 'active'
             AND instr(lower(name || ' ' || problem || ' ' || context || ' ' || solution), ?) > 0
           UNION ALL
           SELECT
             'lesson', id, NULL, title, content, status,
             CASE
               WHEN lower(title) = ? THEN 1.0
               WHEN lower(title) LIKE ? THEN 0.9
               ELSE 0.7
             END
           FROM lesson
           WHERE status = 'active'
             AND instr(lower(title || ' ' || content), ?) > 0
         )
         ORDER BY score DESC, type ASC, name ASC, id ASC, version ASC
         LIMIT ?`,
      )
      .all(
        normalized,
        `${normalized}%`,
        normalized,
        normalized,
        `${normalized}%`,
        normalized,
        normalized,
        `${normalized}%`,
        normalized,
        limit,
      );
    return rows.map((row) => ({
      type: row.type,
      id: row.id,
      ...(row.version === null ? {} : { version: row.version }),
      name: row.name,
      summary: row.summary,
      status: row.status,
      score: row.score,
    }));
  }
}

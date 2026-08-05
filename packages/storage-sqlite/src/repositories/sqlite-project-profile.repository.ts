import type { Database } from "bun:sqlite";
import type {
  NewProjectQuestion,
  ProjectProfileRepository,
  ProjectScan,
  ProjectSource
} from "@ai-office/application/ports/project-profile-repository.port.ts";
import type {
  ProjectAnswer,
  ProjectAnswerCategory,
  ProjectProfileEntry,
  ProjectProfileOrigin,
  ProjectQuestion
} from "@ai-office/domain/project/project-profile.ts";

interface ProjectIdRow {
  project_id: string;
}

interface ProjectQuestionRow {
  id: string;
  project_id: string;
  scan_id: string | null;
  key: string;
  question: string;
  reason: string;
  answer_category: ProjectAnswerCategory;
  answer_json: string | null;
  answered_at: string | null;
}

interface ProjectProfileEntryRow {
  id: string;
  project_id: string;
  category: string;
  key: string;
  value_json: string;
  origin: ProjectProfileOrigin;
  confidence: number;
  source_reference: string | null;
  confirmed_at: string | null;
  created_at: string;
}

function restoreQuestion(row: ProjectQuestionRow): ProjectQuestion {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.scan_id === null ? {} : { scanId: row.scan_id }),
    key: row.key,
    question: row.question,
    reason: row.reason,
    answerCategory: row.answer_category,
    ...(row.answer_json === null
      ? {}
      : { answer: JSON.parse(row.answer_json) as ProjectAnswer }),
    ...(row.answered_at === null ? {} : { answeredAt: new Date(row.answered_at) })
  };
}

function restoreProfileEntry(row: ProjectProfileEntryRow): ProjectProfileEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    category: row.category,
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    origin: row.origin,
    confidence: row.confidence,
    ...(row.source_reference === null ? {} : { sourceReference: row.source_reference }),
    ...(row.confirmed_at === null ? {} : { confirmedAt: new Date(row.confirmed_at) }),
    createdAt: new Date(row.created_at)
  };
}

export class SqliteProjectProfileRepository implements ProjectProfileRepository {
  constructor(private readonly database: Database) {}

  async findProjectIdByLocalPath(localPath: string): Promise<string | null> {
    const source = this.database
      .query<ProjectIdRow, [string]>(
        `SELECT project_id
         FROM project_source
         WHERE local_path = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(localPath);

    if (source !== null) return source.project_id;

    const legacyProfile = this.database
      .query<ProjectIdRow, [string]>(
        `SELECT project_id
         FROM project_profile_entry
         WHERE category = 'repository'
           AND key = 'root_path'
           AND json_extract(value_json, '$') = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(localPath);

    if (legacyProfile !== null) return legacyProfile.project_id;

    const legacyProject = this.database
      .query<ProjectIdRow, [string]>(
        `SELECT id AS project_id
         FROM project
         WHERE description = 'Imported from ' || ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(localPath);

    return legacyProject?.project_id ?? null;
  }

  async saveSource(source: ProjectSource): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO project_source(
           id, project_id, source_type, local_path, remote_url, default_branch, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_path) WHERE local_path IS NOT NULL DO UPDATE SET
           remote_url = excluded.remote_url,
           default_branch = excluded.default_branch`
      )
      .run(
        source.id,
        source.projectId,
        source.sourceType,
        source.localPath,
        source.remoteUrl ?? null,
        source.defaultBranch ?? null,
        source.createdAt.toISOString()
      );
  }

  async saveScan(scan: ProjectScan): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO project_scan(
           id, project_id, scan_type, status, started_at, completed_at,
           source_revision, summary_json, error_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        scan.id,
        scan.projectId,
        scan.scanType,
        scan.status,
        scan.startedAt.toISOString(),
        scan.completedAt.toISOString(),
        scan.sourceRevision ?? null,
        JSON.stringify(scan.summary)
      );
  }

  async replaceDetected(entries: ProjectProfileEntry[]): Promise<void> {
    const projectId = entries[0]?.projectId;
    if (projectId === undefined) return;

    this.database
      .prepare(
        `DELETE FROM project_profile_entry
         WHERE project_id = ? AND origin = 'detected'`
      )
      .run(projectId);

    for (const entry of entries) {
      await this.saveProfileEntry(entry);
    }
  }

  async ensureQuestions(questions: NewProjectQuestion[]): Promise<void> {
    const insert = this.database.prepare(
      `INSERT INTO project_question(
         id, project_id, scan_id, key, question, reason, answer_category
       )
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM project_question WHERE project_id = ? AND key = ?
       )`
    );

    for (const question of questions) {
      insert.run(
        question.id,
        question.projectId,
        question.scanId,
        question.key,
        question.question,
        question.reason,
        question.answerCategory,
        question.projectId,
        question.key
      );
    }
  }

  async findQuestion(projectId: string, questionId: string): Promise<ProjectQuestion | null> {
    const row = this.database
      .query<ProjectQuestionRow, [string, string]>(
        `SELECT id, project_id, scan_id, key, question, reason,
                answer_category, answer_json, answered_at
         FROM project_question
         WHERE project_id = ? AND id = ?`
      )
      .get(projectId, questionId);

    return row === null ? null : restoreQuestion(row);
  }

  async listOpenQuestions(projectId: string): Promise<ProjectQuestion[]> {
    return this.database
      .query<ProjectQuestionRow, [string]>(
        `SELECT id, project_id, scan_id, key, question, reason,
                answer_category, answer_json, answered_at
         FROM project_question
         WHERE project_id = ? AND answer_json IS NULL
         ORDER BY CASE key
           WHEN 'next_outcome' THEN 1
           WHEN 'agent_permissions' THEN 2
           WHEN 'architecture_constraints' THEN 3
           WHEN 'testing_strategy' THEN 4
           WHEN 'documentation_location' THEN 5
           ELSE 100
         END, key, id`
      )
      .all(projectId)
      .map(restoreQuestion);
  }

  async answerQuestion(
    questionId: string,
    answer: ProjectAnswer,
    answeredAt: Date
  ): Promise<void> {
    this.database
      .prepare(
        `UPDATE project_question
         SET answer_json = ?, answered_at = ?
         WHERE id = ? AND answer_json IS NULL`
      )
      .run(JSON.stringify(answer), answeredAt.toISOString(), questionId);
  }

  async saveProfileEntry(entry: ProjectProfileEntry): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO project_profile_entry(
           id, project_id, category, key, value_json, origin, confidence,
           source_reference, confirmed_at, superseded_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
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

  async listActiveProfileEntries(projectId: string): Promise<ProjectProfileEntry[]> {
    return this.database
      .query<ProjectProfileEntryRow, [string]>(
        `SELECT id, project_id, category, key, value_json, origin, confidence,
                source_reference, confirmed_at, created_at
         FROM project_profile_entry
         WHERE project_id = ? AND superseded_at IS NULL
         ORDER BY category, key, created_at, id`
      )
      .all(projectId)
      .map(restoreProfileEntry);
  }
}

import type { Database } from "bun:sqlite";
import type {
  NewProjectQuestion,
  OnboardingGeneration,
  ProjectProfileRepository,
  ProjectScan,
  ProjectSource,
} from "@ai-office/application/ports/project-profile-repository.port.ts";
import type {
  ProjectAnswer,
  ProjectAnswerCategory,
  OnboardingAnswerType,
  OnboardingQuestionSource,
  ProjectProfileEntry,
  ProjectProfileOrigin,
  ProjectQuestion,
} from "@ai-office/domain/project/project-profile.ts";

interface ProjectIdRow {
  project_id: string;
}

interface DetachmentRow {
  detached: number;
}

interface ProjectSourceRow {
  id: string;
  project_id: string;
  source_type: "local";
  local_path: string;
  remote_url: string | null;
  default_branch: string | null;
  created_at: string;
}

interface ProjectQuestionRow {
  id: string;
  project_id: string;
  scan_id: string | null;
  key: string;
  question: string;
  reason: string;
  answer_category: ProjectAnswerCategory;
  answer_type: OnboardingAnswerType;
  options_json: string | null;
  priority: number;
  source: OnboardingQuestionSource;
  generation_id: string | null;
  answer_json: string | null;
  answered_at: string | null;
}

interface OnboardingGenerationRow {
  id: string;
  project_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  input_hash: string;
  round: number;
  status: "completed" | "failed";
  batch_status: "needs_more_context" | "ready" | null;
  failure_code: string | null;
  created_at: string;
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
    answerType: row.answer_type,
    ...(row.options_json === null
      ? {}
      : { options: JSON.parse(row.options_json) as string[] }),
    priority: row.priority,
    source: row.source,
    ...(row.generation_id === null ? {} : { generationId: row.generation_id }),
    ...(row.answer_json === null
      ? {}
      : { answer: JSON.parse(row.answer_json) as ProjectAnswer }),
    ...(row.answered_at === null
      ? {}
      : { answeredAt: new Date(row.answered_at) }),
  };
}

function restoreGeneration(row: OnboardingGenerationRow): OnboardingGeneration {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    round: row.round,
    status: row.status,
    ...(row.batch_status === null ? {} : { batchStatus: row.batch_status }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: new Date(row.created_at),
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
    ...(row.source_reference === null
      ? {}
      : { sourceReference: row.source_reference }),
    ...(row.confirmed_at === null
      ? {}
      : { confirmedAt: new Date(row.confirmed_at) }),
    createdAt: new Date(row.created_at),
  };
}

export class SqliteProjectProfileRepository implements ProjectProfileRepository {
  constructor(private readonly database: Database) {}

  async findProjectIdByLocalPath(localPath: string): Promise<string | null> {
    const detachment = this.database
      .query<DetachmentRow, [string]>(
        `SELECT 1 AS detached
         FROM project_checkout_detachment
         WHERE local_path = ?`,
      )
      .get(localPath);

    if (detachment !== null) return null;

    const source = this.database
      .query<ProjectIdRow, [string]>(
        `SELECT project_id
         FROM project_source
         WHERE local_path = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
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
         LIMIT 1`,
      )
      .get(localPath);

    if (legacyProfile !== null) return legacyProfile.project_id;

    const legacyProject = this.database
      .query<ProjectIdRow, [string]>(
        `SELECT id AS project_id
         FROM project
         WHERE description = 'Imported from ' || ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(localPath);

    return legacyProject?.project_id ?? null;
  }

  async listSources(projectId: string): Promise<ProjectSource[]> {
    return this.database
      .query<ProjectSourceRow, [string]>(
        `SELECT id, project_id, source_type, local_path, remote_url,
                default_branch, created_at
         FROM project_source
         WHERE project_id = ? AND source_type = 'local'
         ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        sourceType: row.source_type,
        localPath: row.local_path,
        ...(row.remote_url === null ? {} : { remoteUrl: row.remote_url }),
        ...(row.default_branch === null
          ? {}
          : { defaultBranch: row.default_branch }),
        createdAt: new Date(row.created_at),
      }));
  }

  async saveSource(source: ProjectSource): Promise<void> {
    this.database
      .prepare(`DELETE FROM project_checkout_detachment WHERE local_path = ?`)
      .run(source.localPath);

    this.database
      .prepare(
        `INSERT INTO project_source(
           id, project_id, source_type, local_path, remote_url, default_branch, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_path) WHERE local_path IS NOT NULL DO UPDATE SET
           remote_url = excluded.remote_url,
           default_branch = excluded.default_branch`,
      )
      .run(
        source.id,
        source.projectId,
        source.sourceType,
        source.localPath,
        source.remoteUrl ?? null,
        source.defaultBranch ?? null,
        source.createdAt.toISOString(),
      );
  }

  async removeSource(projectId: string, localPath: string): Promise<boolean> {
    const detach = this.database.transaction(() => {
      const removed = this.database
        .prepare(
          `DELETE FROM project_source
           WHERE project_id = ? AND local_path = ?`,
        )
        .run(projectId, localPath).changes;

      if (removed !== 1) return false;

      this.database
        .prepare(
          `DELETE FROM project_profile_entry
           WHERE project_id = ?
             AND category = 'repository'
             AND key = 'root_path'
             AND origin = 'detected'
             AND value_json = ?`,
        )
        .run(projectId, JSON.stringify(localPath));

      this.database
        .prepare(
          `INSERT INTO project_checkout_detachment(local_path, project_id, detached_at)
           VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT(local_path) DO UPDATE SET
             project_id = excluded.project_id,
             detached_at = excluded.detached_at`,
        )
        .run(localPath, projectId);

      return true;
    });

    return detach();
  }

  async saveScan(scan: ProjectScan): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO project_scan(
           id, project_id, scan_type, status, started_at, completed_at,
           source_revision, summary_json, error_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        scan.id,
        scan.projectId,
        scan.scanType,
        scan.status,
        scan.startedAt.toISOString(),
        scan.completedAt.toISOString(),
        scan.sourceRevision ?? null,
        JSON.stringify(scan.summary),
      );
  }

  async replaceDetected(entries: ProjectProfileEntry[]): Promise<void> {
    const projectId = entries[0]?.projectId;
    if (projectId === undefined) return;

    this.database
      .prepare(
        `DELETE FROM project_profile_entry
         WHERE project_id = ? AND origin = 'detected'`,
      )
      .run(projectId);

    for (const entry of entries) {
      await this.saveProfileEntry(entry);
    }
  }

  async ensureQuestions(questions: NewProjectQuestion[]): Promise<void> {
    const insert = this.database.prepare(
      `INSERT INTO project_question(
         id, project_id, scan_id, generation_id, key, question,
         normalized_question, reason, answer_category, answer_type,
         options_json, priority, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const question of questions) {
      insert.run(
        question.id,
        question.projectId,
        question.scanId ?? null,
        question.generationId ?? null,
        question.key,
        question.question,
        question.normalizedQuestion,
        question.reason,
        question.answerCategory,
        question.answerType,
        question.options === undefined
          ? null
          : JSON.stringify(question.options),
        question.priority,
        question.source,
      );
    }
  }

  async saveOnboardingGeneration(
    generation: OnboardingGeneration,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO onboarding_generation(
           id, project_id, provider, model, prompt_version, input_hash,
           round, status, batch_status, failure_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generation.id,
        generation.projectId,
        generation.provider,
        generation.model,
        generation.promptVersion,
        generation.inputHash,
        generation.round,
        generation.status,
        generation.batchStatus ?? null,
        generation.failureCode ?? null,
        generation.createdAt.toISOString(),
      );
  }

  async findCompletedOnboardingGeneration(
    projectId: string,
    inputHash: string,
  ): Promise<OnboardingGeneration | null> {
    const row = this.database
      .query<OnboardingGenerationRow, [string, string]>(
        `SELECT id, project_id, provider, model, prompt_version, input_hash,
                round, status, batch_status, failure_code, created_at
         FROM onboarding_generation
         WHERE project_id = ? AND input_hash = ? AND status = 'completed'
         LIMIT 1`,
      )
      .get(projectId, inputHash);
    return row === null ? null : restoreGeneration(row);
  }

  async listOnboardingGenerations(
    projectId: string,
  ): Promise<OnboardingGeneration[]> {
    return this.database
      .query<OnboardingGenerationRow, [string]>(
        `SELECT id, project_id, provider, model, prompt_version, input_hash,
                round, status, batch_status, failure_code, created_at
         FROM onboarding_generation
         WHERE project_id = ?
         ORDER BY round, created_at, id`,
      )
      .all(projectId)
      .map(restoreGeneration);
  }

  async findQuestion(
    projectId: string,
    questionId: string,
  ): Promise<ProjectQuestion | null> {
    const row = this.database
      .query<ProjectQuestionRow, [string, string]>(
        `SELECT id, project_id, scan_id, generation_id, key, question, reason,
                answer_category, answer_type, options_json, priority, source,
                answer_json, answered_at
         FROM project_question
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, questionId);

    return row === null ? null : restoreQuestion(row);
  }

  async listOpenQuestions(projectId: string): Promise<ProjectQuestion[]> {
    return this.database
      .query<ProjectQuestionRow, [string]>(
        `SELECT id, project_id, scan_id, generation_id, key, question, reason,
                answer_category, answer_type, options_json, priority, source,
                answer_json, answered_at
         FROM project_question
         WHERE project_id = ? AND answer_json IS NULL
         ORDER BY priority DESC, key, id`,
      )
      .all(projectId)
      .map(restoreQuestion);
  }

  async listQuestions(projectId: string): Promise<ProjectQuestion[]> {
    return this.database
      .query<ProjectQuestionRow, [string]>(
        `SELECT id, project_id, scan_id, generation_id, key, question, reason,
                answer_category, answer_type, options_json, priority, source,
                answer_json, answered_at
         FROM project_question
         WHERE project_id = ?
         ORDER BY answered_at IS NOT NULL, priority DESC, key, id`,
      )
      .all(projectId)
      .map(restoreQuestion);
  }

  async answerQuestion(
    questionId: string,
    answer: ProjectAnswer,
    answeredAt: Date,
  ): Promise<void> {
    this.database
      .prepare(
        `UPDATE project_question
         SET answer_json = ?, answered_at = ?
         WHERE id = ? AND answer_json IS NULL`,
      )
      .run(JSON.stringify(answer), answeredAt.toISOString(), questionId);
  }

  async saveProfileEntry(entry: ProjectProfileEntry): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO project_profile_entry(
           id, project_id, category, key, value_json, origin, confidence,
           source_reference, confirmed_at, superseded_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
        entry.createdAt.toISOString(),
      );
  }

  async listActiveProfileEntries(
    projectId: string,
  ): Promise<ProjectProfileEntry[]> {
    return this.database
      .query<ProjectProfileEntryRow, [string]>(
        `SELECT id, project_id, category, key, value_json, origin, confidence,
                source_reference, confirmed_at, created_at
         FROM project_profile_entry
         WHERE project_id = ? AND superseded_at IS NULL
         ORDER BY category, key, created_at, id`,
      )
      .all(projectId)
      .map(restoreProfileEntry);
  }
}

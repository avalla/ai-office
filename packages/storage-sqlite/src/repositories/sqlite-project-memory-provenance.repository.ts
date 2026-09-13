import type { Database } from "bun:sqlite";
import type {
  ProjectMemoryProvenanceRepository,
  ProjectMemoryReferenceRecord,
  ProjectMemoryRetrievalRecord,
} from "@ai-office/application/ports/project-memory-provenance-repository.port.ts";

interface RetrievalRow {
  run_id: string;
  project_id: string;
  provider: string;
  provider_version: string | null;
  memory_project_id: string | null;
  scope: string;
  outcome: string;
  error_code: string | null;
  context_query_sha256: string | null;
  provider_query_sha256: string | null;
  result_count: number;
  injected_count: number;
  injected_characters: number;
  created_at: string;
}

interface ReferenceRow {
  rank: number;
  reference_id: string;
  content_digest: string | null;
  scope: string;
  injected: number;
  truncated: number;
}

const outcomes = new Set(["retrieved", "empty", "failed", "skipped"]);

export class SqliteProjectMemoryProvenanceRepository implements ProjectMemoryProvenanceRepository {
  constructor(private readonly database: Database) {}

  async recordRetrieval(record: ProjectMemoryRetrievalRecord): Promise<void> {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO agent_run_memory_retrieval(
             run_id, project_id, provider, provider_version, memory_project_id,
             scope, outcome, error_code, context_query_sha256,
             provider_query_sha256, result_count, injected_count,
             injected_characters, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.runId,
          record.projectId,
          record.provider,
          record.providerVersion,
          record.memoryProjectId,
          record.scope,
          record.outcome,
          record.errorCode,
          record.contextQuerySha256,
          record.providerQuerySha256,
          record.resultCount,
          record.injectedCount,
          record.injectedCharacters,
          record.createdAt.toISOString(),
        );
      const insert = this.database.prepare(
        `INSERT INTO agent_run_memory_reference(
           run_id, rank, reference_id, content_digest, scope, injected, truncated
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const reference of record.references)
        insert.run(
          record.runId,
          reference.rank,
          reference.referenceId,
          reference.contentDigest,
          reference.scope,
          reference.injected ? 1 : 0,
          reference.truncated ? 1 : 0,
        );
    })();
  }

  async findRetrieval(
    runId: string,
  ): Promise<ProjectMemoryRetrievalRecord | null> {
    const row = this.database
      .query<RetrievalRow, [string]>(
        `SELECT * FROM agent_run_memory_retrieval WHERE run_id = ?`,
      )
      .get(runId);
    return row === null ? null : this.restore(row);
  }

  async findLatestRetrieval(
    projectId: string,
  ): Promise<ProjectMemoryRetrievalRecord | null> {
    const row = this.database
      .query<RetrievalRow, [string]>(
        `SELECT * FROM agent_run_memory_retrieval
         WHERE project_id = ?
         ORDER BY created_at DESC, run_id DESC
         LIMIT 1`,
      )
      .get(projectId);
    return row === null ? null : this.restore(row);
  }

  private restore(row: RetrievalRow): ProjectMemoryRetrievalRecord {
    if (!outcomes.has(row.outcome) || row.scope !== "project")
      throw new Error("Stored project memory retrieval is invalid");
    const references = this.database
      .query<ReferenceRow, [string]>(
        `SELECT rank, reference_id, content_digest, scope, injected, truncated
         FROM agent_run_memory_reference
         WHERE run_id = ?
         ORDER BY rank`,
      )
      .all(row.run_id)
      .map((reference): ProjectMemoryReferenceRecord => ({
        rank: reference.rank,
        referenceId: reference.reference_id,
        contentDigest: reference.content_digest,
        scope: reference.scope,
        injected: reference.injected === 1,
        truncated: reference.truncated === 1,
      }));
    return {
      runId: row.run_id,
      projectId: row.project_id,
      provider: row.provider,
      providerVersion: row.provider_version,
      memoryProjectId: row.memory_project_id,
      scope: "project",
      outcome: row.outcome as ProjectMemoryRetrievalRecord["outcome"],
      errorCode: row.error_code as ProjectMemoryRetrievalRecord["errorCode"],
      contextQuerySha256: row.context_query_sha256,
      providerQuerySha256: row.provider_query_sha256,
      resultCount: row.result_count,
      injectedCount: row.injected_count,
      injectedCharacters: row.injected_characters,
      createdAt: new Date(row.created_at),
      references,
    };
  }
}

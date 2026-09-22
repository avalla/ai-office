import { afterEach, expect, test } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { SqliteProjectMemoryProvenanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-memory-provenance.repository.ts";
import type { ProjectMemoryRetrievalRecord } from "@ai-office/application/ports/project-memory-provenance-repository.port.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const at = "2026-09-13T00:00:00.000Z";

function database(upToExclusive?: string) {
  const root = mkdtempSync(join(tmpdir(), "ao-memory-provenance-"));
  const db = openDatabase(join(root, "project.sqlite"));
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const migrations = resolve("migrations/project");
  if (upToExclusive !== undefined) {
    const partial = join(root, "migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations))
      if (file < upToExclusive)
        copyFileSync(join(migrations, file), join(partial, file));
    migrate(db, partial);
  } else migrate(db, migrations);
  return db;
}

function seed(
  db: ReturnType<typeof openDatabase>,
  project: string,
  run: string,
) {
  db.exec(
    `INSERT OR IGNORE INTO project(id,name,created_at,updated_at) VALUES ('${project}','P','${at}','${at}')`,
  );
  db.exec(
    `INSERT OR IGNORE INTO task(id,project_id,title,status,priority,created_at,updated_at) VALUES ('t-${project}','${project}','T','pending',0,'${at}','${at}')`,
  );
  db.exec(
    `INSERT OR IGNORE INTO role(id,project_id,role_key,name,version,capabilities_json,tools_json,model_policy,limits_json,source_path,created_at,updated_at) VALUES ('role-${project}','${project}','dev','Dev',1,'[]','[]','balanced','{"maxCostMicros":"1","maxIterations":1,"timeoutSeconds":1}','x','${at}','${at}')`,
  );
  db.exec(
    `INSERT OR IGNORE INTO agent(id,project_id,role_id,name,enabled,created_at,updated_at) VALUES ('a-${project}','${project}','role-${project}','A',1,'${at}','${at}')`,
  );
  db.exec(
    `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at) VALUES ('${run}','${project}','t-${project}','a-${project}','completed','${at}','${at}')`,
  );
}

function retrieval(
  overrides: Partial<ProjectMemoryRetrievalRecord> = {},
): ProjectMemoryRetrievalRecord {
  return {
    runId: "run-a",
    projectId: "p",
    provider: "cairnkeep",
    providerVersion: "0.1.0",
    memoryProjectId: "aio-00000000000000000000000000000001",
    scope: "project",
    outcome: "retrieved",
    errorCode: null,
    contextQuerySha256: "a".repeat(64),
    providerQuerySha256: "c".repeat(64),
    resultCount: 2,
    injectedCount: 1,
    injectedCharacters: 42,
    createdAt: new Date(at),
    references: [
      {
        rank: 1,
        referenceId: "decisions/storage",
        contentDigest: `sha256:${"b".repeat(64)}`,
        scope: "aio-00000000000000000000000000000001",
        injected: true,
        truncated: false,
      },
      {
        rank: 2,
        referenceId: "notes/old",
        contentDigest: null,
        scope: "aio-00000000000000000000000000000001",
        injected: false,
        truncated: false,
      },
    ],
    ...overrides,
  };
}

test("retrieval provenance is attached to exactly its run and is append-only", async () => {
  const db = database();
  seed(db, "p", "run-a");
  seed(db, "p", "run-b");
  const repository = new SqliteProjectMemoryProvenanceRepository(db);
  await repository.recordRetrieval(retrieval());
  expect(await repository.findRetrieval("run-a")).toEqual(retrieval());
  expect(await repository.findRetrieval("run-b")).toBeNull();
  expect(await repository.findLatestRetrieval("p")).toMatchObject({
    runId: "run-a",
  });
  expect(() =>
    db.exec("UPDATE agent_run_memory_retrieval SET outcome='empty'"),
  ).toThrow("append-only");
  expect(() => db.exec("DELETE FROM agent_run_memory_reference")).toThrow(
    "append-only",
  );
  // A run has at most one retrieval; a second record cannot overwrite it.
  await expect(repository.recordRetrieval(retrieval())).rejects.toThrow();
  expect((await repository.findRetrieval("run-a"))?.references).toHaveLength(2);
  // Stored columns hold references and digests only, never memory bodies.
  const columns = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('agent_run_memory_reference')",
    )
    .all()
    .map((row) => row.name);
  expect(columns).toEqual([
    "run_id",
    "rank",
    "reference_id",
    "content_digest",
    "scope",
    "injected",
    "truncated",
  ]);
});

test("provenance cannot claim another project's run or a successful failure", async () => {
  const db = database();
  seed(db, "p", "run-a");
  seed(db, "q", "run-q");
  const repository = new SqliteProjectMemoryProvenanceRepository(db);
  await expect(
    repository.recordRetrieval(retrieval({ runId: "run-q", projectId: "p" })),
  ).rejects.toThrow("run project");
  await expect(
    repository.recordRetrieval(
      retrieval({ outcome: "failed", errorCode: "PROJECT_MEMORY_TIMEOUT" }),
    ),
  ).rejects.toThrow();
  await expect(
    repository.recordRetrieval(
      retrieval({ outcome: "retrieved", injectedCount: 0 }),
    ),
  ).rejects.toThrow();
  // The failed insert rolled back its references too.
  expect(
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM agent_run_memory_reference",
      )
      .get()?.count,
  ).toBe(0);
  await repository.recordRetrieval(
    retrieval({
      outcome: "failed",
      errorCode: "PROJECT_MEMORY_TIMEOUT",
      providerVersion: null,
      providerQuerySha256: null,
      resultCount: 0,
      injectedCount: 0,
      injectedCharacters: 0,
      references: [],
    }),
  );
  expect(await repository.findRetrieval("run-a")).toMatchObject({
    outcome: "failed",
    references: [],
  });
});

test("upgrading an existing database adds provenance without touching historical runs", () => {
  const db = database("0028");
  seed(db, "p", "historical");
  expect(migrate(db, resolve("migrations/project")).applied).toEqual([
    "0028_agent_run_memory_provenance.sql",
    "0029_agent_run_memory_query_digests.sql",
    "0030_agent_run_model_routing.sql",
    "0031_cost_event_charge_basis.sql",
    "0032_job_outbox.sql",
    "0033_role_execution_guidance.sql",
    "0034_exact_pipeline_stage_bindings.sql",
    "0035_pipeline_manifest_revision_tuple.sql",
  ]);
  expect(migrate(db, resolve("migrations/project")).applied).toEqual([]);
  expect(
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM agent_run WHERE id='historical'",
      )
      .get()?.count,
  ).toBe(1);
  expect(
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM agent_run_memory_retrieval",
      )
      .get()?.count,
  ).toBe(0);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
      ?.integrity_check,
  ).toBe("ok");
});

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

test("query provenance stores two exact digests, never query text, and they must be consistent", async () => {
  const db = database();
  seed(db, "p", "run-a");
  const repository = new SqliteProjectMemoryProvenanceRepository(db);
  await repository.recordRetrieval(
    retrieval({
      contextQuerySha256: sha256("Refactor the authentication middleware"),
      providerQuerySha256: sha256("authentication"),
    }),
  );
  expect(await repository.findRetrieval("run-a")).toMatchObject({
    contextQuerySha256: sha256("Refactor the authentication middleware"),
    providerQuerySha256: sha256("authentication"),
  });
  const columns = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('agent_run_memory_retrieval')",
    )
    .all()
    .map((row) => row.name);
  expect(columns).toContain("context_query_sha256");
  expect(columns).toContain("provider_query_sha256");
  expect(columns).not.toContain("query_sha256");
  // Neither plaintext query is anywhere in the stored rows.
  const dump = JSON.stringify([
    db.query("SELECT * FROM agent_run_memory_retrieval").all(),
    db.query("SELECT * FROM agent_run_memory_reference").all(),
  ]);
  expect(dump).not.toContain("Refactor");
  expect(dump).not.toContain("authentication");

  const nothing = {
    resultCount: 0,
    injectedCount: 0,
    injectedCharacters: 0,
    references: [],
  };
  const rejected: [string, Partial<ProjectMemoryRetrievalRecord>][] = [
    ["run-upper", { providerQuerySha256: "C".repeat(64) }],
    ["run-short", { contextQuerySha256: "a".repeat(63) }],
    // A completed search must name the exact query it sent.
    ["run-missing", { providerQuerySha256: null }],
    ["run-empty", { ...nothing, outcome: "empty", providerQuerySha256: null }],
    // A skip sent nothing.
    [
      "run-skipped",
      {
        ...nothing,
        outcome: "skipped",
        errorCode: "QUERY_UNAVAILABLE",
        contextQuerySha256: null,
      },
    ],
    // No outbound digest without the context query it was derived from.
    [
      "run-orphan",
      {
        ...nothing,
        outcome: "failed",
        errorCode: "PROJECT_MEMORY_FAILED",
        contextQuerySha256: null,
      },
    ],
  ];
  for (const [run, overrides] of rejected) {
    seed(db, "p", run);
    await expect(
      repository.recordRetrieval(retrieval({ runId: run, ...overrides })),
    ).rejects.toThrow();
    expect(await repository.findRetrieval(run)).toBeNull();
  }
});

test("upgrading 0028 provenance keeps its context digest and leaves the unreported outbound digest null", async () => {
  const db = database("0029");
  seed(db, "p", "legacy");
  db.exec(
    `INSERT INTO agent_run_memory_retrieval(run_id,project_id,provider,provider_version,memory_project_id,scope,outcome,error_code,query_sha256,result_count,injected_count,injected_characters,created_at)
     VALUES ('legacy','p','cairnkeep',NULL,'aio-00000000000000000000000000000001','project','empty',NULL,'${"d".repeat(64)}',0,0,0,'${at}')`,
  );
  expect(migrate(db, resolve("migrations/project")).applied).toEqual([
    "0029_agent_run_memory_query_digests.sql",
    "0030_agent_run_model_routing.sql",
    "0031_cost_event_charge_basis.sql",
    "0032_job_outbox.sql",
    "0033_role_execution_guidance.sql",
    "0034_exact_pipeline_stage_bindings.sql",
    "0035_pipeline_manifest_revision_tuple.sql",
  ]);
  expect(migrate(db, resolve("migrations/project")).applied).toEqual([]);
  const repository = new SqliteProjectMemoryProvenanceRepository(db);
  expect(await repository.findRetrieval("legacy")).toMatchObject({
    outcome: "empty",
    contextQuerySha256: "d".repeat(64),
    providerQuerySha256: null,
  });
  // Still append-only after the column rename.
  expect(() =>
    db.exec("UPDATE agent_run_memory_retrieval SET provider_query_sha256=NULL"),
  ).toThrow("append-only");
  expect(() => db.exec("DELETE FROM agent_run_memory_retrieval")).toThrow(
    "append-only",
  );
  seed(db, "p", "after");
  await repository.recordRetrieval(retrieval({ runId: "after" }));
  expect(await repository.findRetrieval("after")).toEqual(
    retrieval({ runId: "after" }),
  );
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
      ?.integrity_check,
  ).toBe("ok");
});

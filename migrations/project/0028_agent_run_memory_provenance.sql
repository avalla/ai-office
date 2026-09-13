-- Provenance of optional, non-authoritative project memory used by one agent run.
--
-- AI Office remains authoritative; an external memory provider only supplies
-- context. These rows answer "which remembered records influenced this run?"
-- without duplicating memory bodies, queries, prompts, provider paths, or
-- configuration. They are runtime-local evidence like `agent_run.execution_json`
-- and are not part of portable project snapshots.
--
-- One run has at most one retrieval record (its single bounded search). A
-- disabled provider records nothing, so runs without a provider are unchanged.

CREATE TABLE agent_run_memory_retrieval (
  run_id TEXT PRIMARY KEY REFERENCES agent_run(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (
    length(provider) BETWEEN 1 AND 64 AND provider NOT GLOB '*[^a-z0-9-]*'
  ),
  provider_version TEXT CHECK (
    provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 64
  ),
  memory_project_id TEXT CHECK (
    memory_project_id IS NULL OR length(memory_project_id) BETWEEN 1 AND 64
  ),
  scope TEXT NOT NULL CHECK (scope = 'project'),
  outcome TEXT NOT NULL CHECK (outcome IN ('retrieved', 'empty', 'failed', 'skipped')),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  query_sha256 TEXT CHECK (
    query_sha256 IS NULL OR (
      length(query_sha256) = 64 AND query_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_count INTEGER NOT NULL CHECK (result_count BETWEEN 0 AND 50),
  injected_count INTEGER NOT NULL CHECK (injected_count BETWEEN 0 AND result_count),
  injected_characters INTEGER NOT NULL CHECK (injected_characters >= 0),
  created_at TEXT NOT NULL,
  -- A failure or skip never pretends that anything was retrieved.
  CHECK (
    (outcome = 'retrieved' AND error_code IS NULL AND injected_count > 0
      AND memory_project_id IS NOT NULL AND query_sha256 IS NOT NULL)
    OR (outcome = 'empty' AND error_code IS NULL AND injected_count = 0
      AND injected_characters = 0 AND memory_project_id IS NOT NULL
      AND query_sha256 IS NOT NULL)
    OR (outcome IN ('failed', 'skipped') AND error_code IS NOT NULL
      AND result_count = 0 AND injected_count = 0 AND injected_characters = 0)
  )
);

CREATE INDEX agent_run_memory_retrieval_project_idx
ON agent_run_memory_retrieval(project_id, created_at, run_id);

CREATE TABLE agent_run_memory_reference (
  run_id TEXT NOT NULL REFERENCES agent_run_memory_retrieval(run_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 50),
  reference_id TEXT NOT NULL CHECK (length(reference_id) BETWEEN 1 AND 256),
  content_digest TEXT CHECK (
    content_digest IS NULL OR length(content_digest) BETWEEN 1 AND 256
  ),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  injected INTEGER NOT NULL CHECK (injected IN (0, 1)),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  PRIMARY KEY (run_id, rank)
);

-- The retrieval must describe a run of the same project; a foreign key alone
-- cannot express that.
CREATE TRIGGER agent_run_memory_retrieval_project_ownership
BEFORE INSERT ON agent_run_memory_retrieval
WHEN NOT EXISTS (
  SELECT 1 FROM agent_run r
  WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory retrieval must belong to the run project');
END;

-- Provenance is append-only evidence, following agent_run_event.
CREATE TRIGGER agent_run_memory_retrieval_no_update
BEFORE UPDATE ON agent_run_memory_retrieval
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_retrieval is append-only'); END;

CREATE TRIGGER agent_run_memory_retrieval_no_delete
BEFORE DELETE ON agent_run_memory_retrieval
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_retrieval is append-only'); END;

CREATE TRIGGER agent_run_memory_reference_no_update
BEFORE UPDATE ON agent_run_memory_reference
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_reference is append-only'); END;

CREATE TRIGGER agent_run_memory_reference_no_delete
BEFORE DELETE ON agent_run_memory_reference
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_reference is append-only'); END;

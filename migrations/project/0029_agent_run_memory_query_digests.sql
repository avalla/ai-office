-- Exact two-stage query provenance for optional project memory.
--
-- 0028 stored one `query_sha256`: the digest of the bounded query AI Office
-- derived from the task. A provider adapter may transform that query before
-- it crosses the provider boundary (CairnKeep sends one distinctive term), so
-- a single digest cannot describe both strings. The existing column keeps its
-- meaning under an explicit name, and the adapter-reported digest of the exact
-- outbound query gets its own column. Neither query text is ever stored.
--
-- Rows written before this migration keep `provider_query_sha256` NULL: the
-- outbound query was not reported then, and it is not reconstructed.

ALTER TABLE agent_run_memory_retrieval
RENAME COLUMN query_sha256 TO context_query_sha256;

ALTER TABLE agent_run_memory_retrieval
ADD COLUMN provider_query_sha256 TEXT CHECK (
  provider_query_sha256 IS NULL OR (
    length(provider_query_sha256) = 64
    AND provider_query_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

-- A completed search must name the exact query it sent; a skipped retrieval
-- sent nothing; an outbound digest never exists without the context query it
-- was derived from. Enforced on insert because the table is append-only and
-- SQLite cannot add a table constraint in place.
CREATE TRIGGER agent_run_memory_retrieval_query_digests
BEFORE INSERT ON agent_run_memory_retrieval
WHEN (NEW.outcome IN ('retrieved', 'empty') AND NEW.provider_query_sha256 IS NULL)
  OR (NEW.outcome = 'skipped' AND NEW.provider_query_sha256 IS NOT NULL)
  OR (NEW.provider_query_sha256 IS NOT NULL AND NEW.context_query_sha256 IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory retrieval query digests are inconsistent');
END;

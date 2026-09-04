-- Run-scoped and pipeline-scoped activity is filtered by aggregate before its
-- limit is applied, so the operational query surface can answer "what happened
-- to this run" without scanning the whole audit log. The column order matches
-- that access path: restrict by aggregate, then page by (occurred_at, id).
CREATE INDEX audit_event_aggregate_idx
ON audit_event(aggregate_id, occurred_at, id);

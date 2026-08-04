CREATE TABLE source_file (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE symbol (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES source_file(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX symbol_name_idx ON symbol(name);
CREATE INDEX symbol_file_idx ON symbol(file_id);

CREATE TABLE code_edge (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(source_id, target_id, edge_type)
);

CREATE INDEX code_edge_source_type_idx
ON code_edge(source_id, edge_type);

CREATE INDEX code_edge_target_type_idx
ON code_edge(target_id, edge_type);

CREATE TABLE chunk (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);

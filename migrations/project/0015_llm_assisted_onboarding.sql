CREATE TABLE onboarding_generation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  round INTEGER NOT NULL CHECK (round > 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  batch_status TEXT CHECK (batch_status IN ('needs_more_context', 'ready')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (status = 'completed' AND batch_status IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND batch_status IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX onboarding_generation_completed_input_idx
ON onboarding_generation(project_id, input_hash)
WHERE status = 'completed';

CREATE INDEX onboarding_generation_project_round_idx
ON onboarding_generation(project_id, round, created_at, id);

ALTER TABLE project_question
ADD COLUMN source TEXT NOT NULL DEFAULT 'deterministic'
CHECK (source IN ('deterministic', 'llm'));

ALTER TABLE project_question
ADD COLUMN generation_id TEXT REFERENCES onboarding_generation(id) ON DELETE SET NULL;

ALTER TABLE project_question
ADD COLUMN answer_type TEXT NOT NULL DEFAULT 'text'
CHECK (answer_type IN ('text', 'boolean', 'single_select', 'multi_select'));

ALTER TABLE project_question
ADD COLUMN options_json TEXT;

ALTER TABLE project_question
ADD COLUMN priority INTEGER NOT NULL DEFAULT 50
CHECK (priority >= 1 AND priority <= 100);

ALTER TABLE project_question
ADD COLUMN normalized_question TEXT NOT NULL DEFAULT '';

UPDATE project_question
SET normalized_question = answer_category || ':' || lower(trim(question));

UPDATE project_question
SET answer_type = 'multi_select',
    options_json = '["read_files","modify_files","run_tests","run_shell","install_dependencies","create_branches","create_commits","network_access"]'
WHERE answer_category = 'permission';

CREATE UNIQUE INDEX project_question_normalized_unique_idx
ON project_question(project_id, normalized_question);

CREATE INDEX project_question_generation_idx
ON project_question(generation_id, priority, id);

CREATE TRIGGER project_question_llm_generation_required_insert
BEFORE INSERT ON project_question
WHEN (NEW.source = 'llm' AND NEW.generation_id IS NULL)
  OR (NEW.source = 'deterministic' AND NEW.generation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'question source and generation do not match'); END;

CREATE TRIGGER project_question_llm_generation_required_update
BEFORE UPDATE OF source, generation_id ON project_question
WHEN (NEW.source = 'llm' AND NEW.generation_id IS NULL)
  OR (NEW.source = 'deterministic' AND NEW.generation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'question source and generation do not match'); END;

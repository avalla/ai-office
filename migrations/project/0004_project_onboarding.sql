ALTER TABLE project_question
ADD COLUMN answer_category TEXT NOT NULL DEFAULT 'preference'
CHECK (answer_category IN ('goal', 'preference', 'constraint', 'permission'));

UPDATE project_question
SET answer_category = CASE key
  WHEN 'next_outcome' THEN 'goal'
  WHEN 'agent_permissions' THEN 'permission'
  WHEN 'architecture_constraints' THEN 'constraint'
  ELSE 'preference'
END;

DELETE FROM project_question
WHERE answer_json IS NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM project_question
    WHERE answer_json IS NULL
    GROUP BY project_id, key
  );

CREATE UNIQUE INDEX project_question_open_unique_idx
ON project_question(project_id, key)
WHERE answer_json IS NULL;

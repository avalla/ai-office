-- GP-12 agent disable: a project may disable a pack agent as well as a prompt
-- or a role. Only the operation/kind/payload rule changes. Rows, keys, the
-- tenant ownership foreign key, RLS and its policies are left untouched, and
-- agent reference fields live in payload_json, which has no key constraint.
--
-- 20261005000100 named this constraint, so it is dropped by name and fails
-- closed if it is absent. Dropping it frees the name; no other constraint of
-- the table uses it (the column checks are named <table>_<column>_check, and
-- project_definition_override_operation_check stays).
ALTER TABLE core.project_definition_override
  DROP CONSTRAINT project_definition_override_operation_kind_payload_check;

ALTER TABLE core.project_definition_override
  ADD CONSTRAINT project_definition_override_operation_kind_payload_check CHECK (
    (operation = 'disable' AND kind IN ('prompts','roles','agents') AND payload_json IS NULL)
    OR (operation IN ('replace','extend') AND payload_json IS NOT NULL)
  );

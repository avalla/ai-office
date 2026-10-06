-- GP-13 workflow overrides: a project may replace, extend or disable a pack
-- workflow. Two rules change: the kinds an override may name, and the kinds a
-- disable applies to. Rows, keys, the tenant ownership foreign key, RLS and
-- its policies are left untouched, and a workflow envelope lives in
-- payload_json, whose arrays keep the stage order.
--
-- 20261003000100 declared the kind rule as an unnamed column check, which
-- PostgreSQL named project_definition_override_kind_check. 20261005000100
-- named the operation/kind/payload rule. Both are dropped by name and fail
-- closed if absent. Each drop frees its name, and no other constraint of the
-- table uses either (the remaining column checks are named
-- <table>_<column>_check for other columns), so each rule is added back
-- widened under the same name.
ALTER TABLE core.project_definition_override
  DROP CONSTRAINT project_definition_override_kind_check;

ALTER TABLE core.project_definition_override
  DROP CONSTRAINT project_definition_override_operation_kind_payload_check;

ALTER TABLE core.project_definition_override
  ADD CONSTRAINT project_definition_override_kind_check CHECK (
    kind IN ('roles','taskTypes','workflows','agents','artifactTypes','evidenceTypes','knowledge','prompts')
  );

ALTER TABLE core.project_definition_override
  ADD CONSTRAINT project_definition_override_operation_kind_payload_check CHECK (
    (operation = 'disable' AND kind IN ('prompts','roles','agents','workflows') AND payload_json IS NULL)
    OR (operation IN ('replace','extend') AND payload_json IS NOT NULL)
  );

-- GP-11 role omission: a project may disable a pack role as well as a prompt.
-- Only the operation/kind/payload rule changes. Rows, keys, the tenant
-- ownership foreign key, RLS and its policies are left untouched.
DO $$
DECLARE constraint_name text;
BEGIN
  -- 20261003000100 declared this table constraint without a name. Resolve it
  -- by definition and fail closed unless exactly one constraint matches.
  -- project_definition_override_operation_check is the column check on
  -- operation and stays; the new constraint must not reuse that name.
  SELECT conname INTO STRICT constraint_name
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'core.project_definition_override'::regclass
    AND contype = 'c'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%disable%'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%payload_json%';
  EXECUTE format(
    'ALTER TABLE core.project_definition_override DROP CONSTRAINT %I',
    constraint_name
  );
END;
$$;

ALTER TABLE core.project_definition_override
  ADD CONSTRAINT project_definition_override_operation_kind_payload_check CHECK (
    (operation = 'disable' AND kind IN ('prompts','roles') AND payload_json IS NULL)
    OR (operation IN ('replace','extend') AND payload_json IS NOT NULL)
  );

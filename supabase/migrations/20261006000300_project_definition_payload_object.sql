-- Project definition payloads become jsonb objects.
--
-- The PostgreSQL definition repository bound JSON text to a jsonb parameter,
-- and the driver serializes a string bound to jsonb as a JSON string. Every
-- payload it wrote is therefore a jsonb string scalar whose content is the
-- JSON text of the payload, not a jsonb object: SQL could not address its
-- members, and jsonb never inspected the text. This migration converts each
-- such value to the object it spells and then makes the object shape a rule of
-- both tables, as it already is for the other jsonb documents of this schema.
--
-- Rows, keys, the tenant ownership foreign keys, RLS, its policies and every
-- earlier constraint are left untouched. SQL NULL (a disable override) and
-- values that are already objects are not rewritten. jsonb keeps array order,
-- so a workflow stage list keeps its order; it does not keep object key order
-- or duplicate keys, and neither is part of a payload's meaning.
--
-- It fails closed. One statement does all of the work, so it is atomic under
-- any runner: if a single value cannot be converted, nothing is converted, no
-- constraint is added and the migration is not recorded. A value cannot be
-- converted when it is a jsonb string whose content is not JSON text, is JSON
-- text for something other than an object, or is JSON text holding an escaped
-- U+0000, which jsonb cannot store; or when it is any other non-object jsonb
-- value. The error names the rows by key and never quotes a payload. Nothing
-- is dropped, rewritten or skipped on the operator's behalf: see "Project
-- definition payload objects" in supabase/README.md for the repair.
DO $$
DECLARE
  candidate record;
  converted jsonb;
  reason text;
  offending text[] := ARRAY[]::text[];
  offending_count integer := 0;
BEGIN
  -- The lock the constraints below need anyway, taken first so the scan, the
  -- conversion and the validation see one state and no writer slips between.
  LOCK TABLE core.project_owned_definition, core.project_definition_override
    IN ACCESS EXCLUSIVE MODE;

  FOR candidate IN
    SELECT format(
             'core.project_owned_definition (project_id=%s, kind=%s, local_id=%s)',
             project_id, kind, local_id
           ) COLLATE "C" AS label,
           payload_json
      FROM core.project_owned_definition
     WHERE jsonb_typeof(payload_json) <> 'object'
    UNION ALL
    SELECT format(
             'core.project_definition_override (project_id=%s, pack=%s@%s, manifest_digest=%s, kind=%s, local_id=%s)',
             project_id, pack_id, pack_version, manifest_digest, kind, local_id
           ) COLLATE "C",
           payload_json
      FROM core.project_definition_override
     WHERE payload_json IS NOT NULL AND jsonb_typeof(payload_json) <> 'object'
     ORDER BY 1
  LOOP
    reason := NULL;
    IF jsonb_typeof(candidate.payload_json) = 'string' THEN
      BEGIN
        converted := (candidate.payload_json #>> '{}')::jsonb;
        IF jsonb_typeof(converted) <> 'object' THEN
          reason := format('JSON %s, not a JSON object', jsonb_typeof(converted));
        END IF;
      EXCEPTION
        -- The server's own message and context quote the text; neither is
        -- relayed.
        WHEN untranslatable_character THEN
          reason := 'JSON text holding an escaped U+0000, which jsonb cannot store';
        WHEN data_exception THEN
          reason := 'not JSON text';
      END;
    ELSE
      reason := format('jsonb %s, not a JSON object', jsonb_typeof(candidate.payload_json));
    END IF;
    IF reason IS NOT NULL THEN
      offending_count := offending_count + 1;
      IF offending_count <= 20 THEN
        offending := offending || (candidate.label || ': ' || reason);
      END IF;
    END IF;
  END LOOP;

  IF offending_count > 0 THEN
    RAISE EXCEPTION 'cannot convert % project definition payload(s) to jsonb objects', offending_count
      USING ERRCODE = 'data_exception',
            DETAIL = array_to_string(offending, '; ')
              || CASE WHEN offending_count > 20
                   THEN format('; and %s more', offending_count - 20) ELSE '' END,
            HINT = 'Nothing was changed. Repair or remove the listed rows, then apply the migration again: see "Project definition payload objects" in supabase/README.md.';
  END IF;

  UPDATE core.project_owned_definition
     SET payload_json = (payload_json #>> '{}')::jsonb
   WHERE jsonb_typeof(payload_json) = 'string';

  UPDATE core.project_definition_override
     SET payload_json = (payload_json #>> '{}')::jsonb
   WHERE payload_json IS NOT NULL AND jsonb_typeof(payload_json) = 'string';

  -- Named as PostgreSQL names a column check, like the other checks of these
  -- tables. Dropped first only so that applying this file again is a no-op.
  ALTER TABLE core.project_owned_definition
    DROP CONSTRAINT IF EXISTS project_owned_definition_payload_json_check;
  ALTER TABLE core.project_owned_definition
    ADD CONSTRAINT project_owned_definition_payload_json_check
    CHECK (jsonb_typeof(payload_json) = 'object');

  ALTER TABLE core.project_definition_override
    DROP CONSTRAINT IF EXISTS project_definition_override_payload_json_check;
  ALTER TABLE core.project_definition_override
    ADD CONSTRAINT project_definition_override_payload_json_check
    CHECK (payload_json IS NULL OR jsonb_typeof(payload_json) = 'object');
END;
$$;

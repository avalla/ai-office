-- Forward-only hardening for runtime authority and domain parity.

CREATE OR REPLACE FUNCTION core.jsonb_has_only_keys(value jsonb, allowed text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(value) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(value) AS object_key(key)
      WHERE NOT (object_key.key = ANY(allowed))
    );
$$;

ALTER TABLE core.role
  ALTER COLUMN version TYPE numeric USING version::numeric,
  ALTER COLUMN guidance_version TYPE numeric USING guidance_version::numeric;

ALTER TABLE core.role
  DROP CONSTRAINT IF EXISTS role_version_check,
  DROP CONSTRAINT IF EXISTS role_guidance_version_check,
  DROP CONSTRAINT IF EXISTS role_guidance_text_check,
  DROP CONSTRAINT IF EXISTS role_limits_json_check;

ALTER TABLE core.role
  ADD CONSTRAINT role_version_domain_check
    CHECK (version = trunc(version) AND version BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT role_guidance_version_domain_check
    CHECK (guidance_version = trunc(guidance_version) AND guidance_version BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT role_guidance_text_domain_check
    CHECK (octet_length(guidance_text) <= 65536),
  ADD CONSTRAINT role_limits_domain_check CHECK (
    jsonb_typeof(limits_json) = 'object'
    AND limits_json ?& ARRAY['maxIterations', 'maxCostMicros', 'timeoutSeconds']
    AND core.jsonb_has_only_keys(limits_json, ARRAY['maxIterations', 'maxCostMicros', 'timeoutSeconds'])
    AND jsonb_typeof(limits_json -> 'maxIterations') = 'number'
    AND CASE
      WHEN jsonb_typeof(limits_json -> 'maxIterations') = 'number'
      THEN (limits_json ->> 'maxIterations')::numeric = trunc((limits_json ->> 'maxIterations')::numeric)
        AND (limits_json ->> 'maxIterations')::numeric BETWEEN 1 AND 9007199254740991
      ELSE false
    END
    AND jsonb_typeof(limits_json -> 'timeoutSeconds') = 'number'
    AND CASE
      WHEN jsonb_typeof(limits_json -> 'timeoutSeconds') = 'number'
      THEN (limits_json ->> 'timeoutSeconds')::numeric = trunc((limits_json ->> 'timeoutSeconds')::numeric)
        AND (limits_json ->> 'timeoutSeconds')::numeric BETWEEN 1 AND 9007199254740991
      ELSE false
    END
    AND jsonb_typeof(limits_json -> 'maxCostMicros') = 'string'
    AND (limits_json ->> 'maxCostMicros') ~ '^[0-9]+$'
  );

ALTER TABLE core.agent_run
  DROP CONSTRAINT IF EXISTS agent_run_runtime_shape,
  DROP CONSTRAINT IF EXISTS agent_run_json_shape;

ALTER TABLE core.agent_run
  ADD CONSTRAINT agent_run_runtime_shape CHECK (
    (status IS NULL
      AND task_id IS NULL AND agent_id IS NULL
      AND action_intent_json IS NULL
      AND pipeline_run_id IS NULL AND pipeline_stage_run_id IS NULL
      AND worktree_path IS NULL AND result_json IS NULL AND error_json IS NULL
      AND created_at IS NULL AND started_at IS NULL AND completed_at IS NULL
      AND updated_at IS NULL AND execution_json IS NULL
      AND model_routing_json IS NULL AND role_guidance_json IS NULL)
    OR
    (status IN ('queued', 'preparing', 'running', 'reviewing', 'completed', 'failed', 'cancelled')
      AND task_id IS NOT NULL AND agent_id IS NOT NULL
      AND created_at IS NOT NULL AND updated_at IS NOT NULL)
  ),
  ADD CONSTRAINT agent_run_json_shape CHECK (
    (action_intent_json IS NULL OR jsonb_typeof(action_intent_json) = 'object')
    AND (result_json IS NULL OR jsonb_typeof(result_json) IS NOT NULL)
    AND (error_json IS NULL OR jsonb_typeof(error_json) IS NOT NULL)
    AND (execution_json IS NULL OR (
      jsonb_typeof(execution_json) = 'object'
      AND execution_json ?& ARRAY['kind', 'adapterId', 'adapterVersion']
      AND core.jsonb_has_only_keys(execution_json, ARRAY['kind', 'adapterId', 'adapterVersion', 'inputHash'])
      AND execution_json ->> 'kind' IN ('simulation', 'controlled_action', 'worker')
      AND execution_json ->> 'adapterId' ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      AND execution_json ->> 'adapterVersion' ~ '^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$'
      AND (NOT execution_json ? 'inputHash'
        OR (jsonb_typeof(execution_json -> 'inputHash') = 'string'
          AND execution_json ->> 'inputHash' ~ '^[a-f0-9]{64}$'))
      AND (execution_json ->> 'kind' <> 'worker' OR execution_json ? 'inputHash')
    ))
    AND (model_routing_json IS NULL OR (
      jsonb_typeof(model_routing_json) = 'object'
      AND (
        (model_routing_json ->> 'status' = 'unrouted'
          AND core.jsonb_has_only_keys(model_routing_json, ARRAY['status']))
        OR
        (model_routing_json ->> 'status' = 'resolved'
          AND core.jsonb_has_only_keys(model_routing_json, ARRAY['status', 'selection'])
          AND jsonb_typeof(model_routing_json -> 'selection') = 'object'
          AND (model_routing_json -> 'selection') ?& ARRAY['policy', 'profile', 'modelRef', 'providerId', 'model', 'reasoningEffort', 'maxOutputTokens', 'source']
          AND core.jsonb_has_only_keys(model_routing_json -> 'selection', ARRAY['policy', 'profile', 'modelRef', 'providerId', 'model', 'reasoningEffort', 'maxOutputTokens', 'source'])
          AND btrim(model_routing_json #>> '{selection,policy}') = model_routing_json #>> '{selection,policy}'
          AND char_length(model_routing_json #>> '{selection,policy}') BETWEEN 1 AND 200
          AND (model_routing_json #>> '{selection,policy}') !~ '[[:cntrl:]]'
          AND (jsonb_typeof(model_routing_json #> '{selection,profile}') = 'null'
            OR (jsonb_typeof(model_routing_json #> '{selection,profile}') = 'string'
              AND model_routing_json #>> '{selection,profile}' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'))
          AND model_routing_json #>> '{selection,modelRef}' = (model_routing_json #>> '{selection,providerId}') || ':' || (model_routing_json #>> '{selection,model}')
          AND model_routing_json #>> '{selection,providerId}' ~ '^[a-z][a-z0-9_-]{0,31}$'
          AND model_routing_json #>> '{selection,model}' ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'
          AND (jsonb_typeof(model_routing_json #> '{selection,reasoningEffort}') = 'null'
            OR (jsonb_typeof(model_routing_json #> '{selection,reasoningEffort}') = 'string'
              AND model_routing_json #>> '{selection,reasoningEffort}' ~ '^[a-z][a-z0-9_-]{0,31}$'))
          AND (jsonb_typeof(model_routing_json #> '{selection,maxOutputTokens}') = 'null'
            OR (jsonb_typeof(model_routing_json #> '{selection,maxOutputTokens}') = 'number'
              AND (model_routing_json #>> '{selection,maxOutputTokens}')::numeric = trunc((model_routing_json #>> '{selection,maxOutputTokens}')::numeric)
              AND (model_routing_json #>> '{selection,maxOutputTokens}')::numeric BETWEEN 1 AND 10000000))
          AND model_routing_json #>> '{selection,source}' IN ('project_agent_override', 'agent_override', 'role_policy', 'default', 'legacy_default')
          AND ((model_routing_json #> '{selection,profile}' = 'null'::jsonb
                AND model_routing_json #>> '{selection,source}' IN ('project_agent_override', 'agent_override', 'legacy_default'))
            OR (model_routing_json #> '{selection,profile}' <> 'null'::jsonb
                AND model_routing_json #>> '{selection,source}' <> 'legacy_default'))
        )
      )
    ))
    AND (role_guidance_json IS NULL OR (
      jsonb_typeof(role_guidance_json) = 'object'
      AND role_guidance_json ?& ARRAY['version', 'text']
      AND core.jsonb_has_only_keys(role_guidance_json, ARRAY['version', 'text'])
      AND jsonb_typeof(role_guidance_json -> 'version') = 'number'
      AND (role_guidance_json ->> 'version')::numeric = trunc((role_guidance_json ->> 'version')::numeric)
      AND (role_guidance_json ->> 'version')::numeric BETWEEN 1 AND 9007199254740991
      AND jsonb_typeof(role_guidance_json -> 'text') = 'string'
      AND btrim(role_guidance_json ->> 'text') <> ''
      AND octet_length(role_guidance_json ->> 'text') <= 65536
    ))
  );

COMMENT ON CONSTRAINT agent_run_runtime_shape ON core.agent_run IS
  'NULL status rows are identity-only governance subjects and contain no runtime state.';
COMMENT ON TABLE core.pipeline_run IS
  'Runtime authority writers must lock the task row before changing pipeline existence or active-stage authority.';
COMMENT ON TABLE core.pipeline_stage_run IS
  'Runtime authority writers must follow task, agent, role, lock, pipeline, stage lock order when racing admission/result acceptance.';

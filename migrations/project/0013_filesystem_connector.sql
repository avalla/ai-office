CREATE TABLE resources_m6b (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'filesystem_scope', 'github_repository', 'sqlite_database', 'shell_environment'
  )),
  provider TEXT NOT NULL CHECK (provider IN ('fake', 'filesystem')),
  external_ref TEXT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  configuration_json TEXT NOT NULL CHECK (
    json_valid(configuration_json) AND json_type(configuration_json) = 'object'
  ),
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  CHECK (
    (provider = 'fake' AND type = 'filesystem_scope')
    OR (provider = 'filesystem' AND type = 'filesystem_scope'
      AND external_ref IS NOT NULL AND length(trim(external_ref)) > 0)
  )
);

CREATE TABLE capability_grants_m6b (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN (
    'user', 'agent', 'role', 'workflow', 'application'
  )),
  principal_id TEXT NOT NULL CHECK (length(trim(principal_id)) > 0),
  resource_id TEXT NOT NULL,
  actions_json TEXT NOT NULL CHECK (
    json_valid(actions_json)
    AND json_type(actions_json) = 'array'
    AND json_array_length(actions_json) > 0
  ),
  constraints_json TEXT NOT NULL CHECK (
    json_valid(constraints_json) AND json_type(constraints_json) = 'object'
  ),
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  granted_by TEXT NOT NULL CHECK (length(trim(granted_by)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, resource_id)
    REFERENCES resources_m6b(project_id, id) ON DELETE CASCADE,
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE action_requests_m6b (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  normalized_arguments_json TEXT NOT NULL CHECK (
    json_valid(normalized_arguments_json) AND json_type(normalized_arguments_json) = 'object'
  ),
  effective_constraints_json TEXT NOT NULL CHECK (
    json_valid(effective_constraints_json) AND json_type(effective_constraints_json) = 'object'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  decision TEXT NOT NULL CHECK (decision IN (
    'allow', 'deny', 'allow_with_approval', 'allow_simulation_only'
  )),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  matched_grant_ids_json TEXT NOT NULL CHECK (
    json_valid(matched_grant_ids_json) AND json_type(matched_grant_ids_json) = 'array'
  ),
  reasons_json TEXT NOT NULL CHECK (
    json_valid(reasons_json) AND json_type(reasons_json) = 'array'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'authorized', 'denied', 'simulating', 'simulated',
    'approval_pending', 'approved', 'rejected', 'executing', 'completed',
    'failed', 'cancelled', 'expired'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, agent_id)
    REFERENCES agent(project_id, id),
  FOREIGN KEY(project_id, resource_id)
    REFERENCES resources_m6b(project_id, id),
  CHECK (
    (connector = 'fake' AND connector_version = '1')
    OR (connector = 'filesystem' AND connector_version = '1')
  )
);

INSERT INTO resources_m6b
SELECT * FROM resources;

INSERT INTO capability_grants_m6b
SELECT * FROM capability_grants;

INSERT INTO action_requests_m6b
SELECT * FROM action_requests;

DROP TRIGGER capability_grant_agent_delete_guard;
DROP TRIGGER capability_grant_role_delete_guard;
DROP TRIGGER capability_grant_agent_identity_guard;
DROP TRIGGER capability_grant_role_identity_guard;

DROP TABLE action_requests;
DROP TABLE capability_grants;
DROP TABLE resources;

ALTER TABLE resources_m6b RENAME TO resources;
ALTER TABLE capability_grants_m6b RENAME TO capability_grants;
ALTER TABLE action_requests_m6b RENAME TO action_requests;

CREATE TRIGGER capability_grant_agent_delete_guard
BEFORE DELETE ON agent
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'agent' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'agent has capability grants'); END;

CREATE TRIGGER capability_grant_role_delete_guard
BEFORE DELETE ON role
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'role' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'role has capability grants'); END;

CREATE TRIGGER capability_grant_agent_identity_guard
BEFORE UPDATE OF id, project_id ON agent
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'agent' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'agent with capability grants cannot change identity'); END;

CREATE TRIGGER capability_grant_role_identity_guard
BEFORE UPDATE OF id, project_id ON role
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'role' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'role with capability grants cannot change identity'); END;

CREATE INDEX resources_project_status_idx
ON resources(project_id, status, created_at, id);

CREATE INDEX resources_project_created_idx
ON resources(project_id, created_at, id);

CREATE INDEX capability_grants_project_principal_idx
ON capability_grants(project_id, principal_type, principal_id, created_at, id);

CREATE INDEX capability_grants_project_resource_idx
ON capability_grants(project_id, resource_id, created_at, id);

CREATE INDEX capability_grants_validity_idx
ON capability_grants(project_id, revoked_at, expires_at, valid_from);

CREATE INDEX action_requests_project_status_idx
ON action_requests(project_id, status, created_at, id);

CREATE INDEX action_requests_project_resource_idx
ON action_requests(project_id, resource_id, created_at, id);

CREATE INDEX action_requests_project_agent_idx
ON action_requests(project_id, agent_id, created_at, id);

CREATE INDEX action_requests_created_idx
ON action_requests(created_at, id);

CREATE TRIGGER resources_configuration_safe_insert
BEFORE INSERT ON resources
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.configuration_json)
  WHERE key IS NOT NULL AND (
    key IN ('__proto__', 'constructor', 'prototype')
    OR lower(replace(replace(replace(key, '_', ''), '-', ''), ' ', '')) IN (
      'apikey', 'authorization', 'credential', 'credentialref', 'credentials',
      'password', 'secret', 'token'
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'resource configuration contains a forbidden field'); END;

CREATE TRIGGER resources_configuration_safe_update
BEFORE UPDATE OF configuration_json ON resources
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.configuration_json)
  WHERE key IS NOT NULL AND (
    key IN ('__proto__', 'constructor', 'prototype')
    OR lower(replace(replace(replace(key, '_', ''), '-', ''), ' ', '')) IN (
      'apikey', 'authorization', 'credential', 'credentialref', 'credentials',
      'password', 'secret', 'token'
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'resource configuration contains a forbidden field'); END;

CREATE TRIGGER resources_immutable_fields
BEFORE UPDATE OF id, project_id, type, provider, external_ref, display_name,
  configuration_json, credential_ref, created_at ON resources
BEGIN SELECT RAISE(ABORT, 'resource registration fields are immutable'); END;

CREATE TRIGGER resources_status_transition
BEFORE UPDATE OF status ON resources
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'active' AND NEW.status = 'disabled')
BEGIN SELECT RAISE(ABORT, 'invalid resource status transition'); END;

CREATE TRIGGER resources_timestamp_with_status
BEFORE UPDATE OF updated_at ON resources
WHEN NEW.status = OLD.status AND NEW.updated_at IS NOT OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'resource timestamp requires a status transition'); END;

CREATE TRIGGER resources_prevent_delete
BEFORE DELETE ON resources
BEGIN SELECT RAISE(ABORT, 'resource registry entries cannot be deleted'); END;

CREATE TRIGGER capability_grant_actions_valid_insert
BEFORE INSERT ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.actions_json)
  WHERE type <> 'text' OR length(trim(value)) = 0
)
BEGIN SELECT RAISE(ABORT, 'capability actions must be non-empty strings'); END;

CREATE TRIGGER capability_grant_actions_valid_update
BEFORE UPDATE OF actions_json ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.actions_json)
  WHERE type <> 'text' OR length(trim(value)) = 0
)
BEGIN SELECT RAISE(ABORT, 'capability actions must be non-empty strings'); END;

CREATE TRIGGER capability_grant_constraints_safe_insert
BEFORE INSERT ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.constraints_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
BEGIN SELECT RAISE(ABORT, 'capability constraints contain a forbidden field'); END;

CREATE TRIGGER capability_grant_constraints_safe_update
BEFORE UPDATE OF constraints_json ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.constraints_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
BEGIN SELECT RAISE(ABORT, 'capability constraints contain a forbidden field'); END;

CREATE TRIGGER capability_grant_principal_ownership_insert
BEFORE INSERT ON capability_grants
WHEN
  (NEW.principal_type = 'agent' AND NOT EXISTS (
    SELECT 1 FROM agent WHERE id=NEW.principal_id AND project_id=NEW.project_id
  )) OR
  (NEW.principal_type = 'role' AND NOT EXISTS (
    SELECT 1 FROM role WHERE id=NEW.principal_id AND project_id=NEW.project_id
  ))
BEGIN SELECT RAISE(ABORT, 'capability principal must belong to the same project'); END;

CREATE TRIGGER capability_grant_principal_ownership_update
BEFORE UPDATE OF project_id, principal_type, principal_id ON capability_grants
WHEN
  (NEW.principal_type = 'agent' AND NOT EXISTS (
    SELECT 1 FROM agent WHERE id=NEW.principal_id AND project_id=NEW.project_id
  )) OR
  (NEW.principal_type = 'role' AND NOT EXISTS (
    SELECT 1 FROM role WHERE id=NEW.principal_id AND project_id=NEW.project_id
  ))
BEGIN SELECT RAISE(ABORT, 'capability principal must belong to the same project'); END;

CREATE TRIGGER capability_grant_immutable_fields
BEFORE UPDATE OF id, project_id, principal_type, principal_id, resource_id,
  actions_json, constraints_json, valid_from, expires_at, granted_by, reason,
  created_at ON capability_grants
BEGIN SELECT RAISE(ABORT, 'capability grant fields are immutable'); END;

CREATE TRIGGER capability_grant_revocation_monotonic
BEFORE UPDATE OF revoked_at ON capability_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.revoked_at < OLD.created_at
BEGIN SELECT RAISE(ABORT, 'capability grant revocation is immutable'); END;

CREATE TRIGGER capability_grant_prevent_delete
BEFORE DELETE ON capability_grants
BEGIN SELECT RAISE(ABORT, 'capability grants cannot be deleted'); END;

CREATE TRIGGER action_request_json_safe_insert
BEFORE INSERT ON action_requests
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.normalized_arguments_json)
  WHERE key IS NOT NULL AND (
    key IN ('__proto__', 'constructor', 'prototype')
    OR lower(replace(replace(replace(key, '_', ''), '-', ''), ' ', '')) IN (
      'apikey', 'authorization', 'credential', 'credentialref', 'credentials',
      'password', 'secret', 'token'
    )
  )
) OR EXISTS (
  SELECT 1 FROM json_tree(NEW.effective_constraints_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
BEGIN SELECT RAISE(ABORT, 'action request JSON contains a forbidden field'); END;

CREATE TRIGGER action_request_must_start_requested
BEFORE INSERT ON action_requests
WHEN NEW.status <> 'requested'
BEGIN SELECT RAISE(ABORT, 'action request must start requested'); END;

CREATE TRIGGER action_request_connector_matches_resource
BEFORE INSERT ON action_requests
WHEN NOT EXISTS (
  SELECT 1 FROM resources
  WHERE id=NEW.resource_id AND project_id=NEW.project_id
    AND provider=NEW.connector
)
BEGIN SELECT RAISE(ABORT, 'action connector must match resource provider'); END;

CREATE TRIGGER action_request_immutable_payload
BEFORE UPDATE OF id, project_id, agent_id, resource_id, connector,
  connector_version, operation, normalized_arguments_json,
  effective_constraints_json, payload_hash, decision, risk_level,
  matched_grant_ids_json, reasons_json, created_at ON action_requests
BEGIN SELECT RAISE(ABORT, 'action request payload is immutable'); END;

CREATE TRIGGER action_request_status_transition
BEFORE UPDATE OF status ON action_requests
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'requested' AND OLD.decision = 'deny' AND NEW.status = 'denied')
  OR (OLD.status = 'requested'
    AND OLD.decision IN ('allow', 'allow_simulation_only', 'allow_with_approval')
    AND NEW.status = 'authorized')
  OR (OLD.status = 'authorized' AND NEW.status = 'executing'
    AND OLD.decision = 'allow'
    AND OLD.connector = 'filesystem'
    AND OLD.operation IN ('filesystem.list', 'filesystem.read', 'filesystem.search'))
  OR (OLD.status = 'authorized' AND NEW.status = 'simulating' AND (
    (OLD.decision = 'allow_simulation_only' AND (
      (OLD.connector = 'filesystem' AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move'
      )) OR (OLD.connector = 'fake' AND OLD.operation = 'fake.write')
    ))
    OR (OLD.decision = 'allow_with_approval' AND (
      (OLD.connector = 'filesystem' AND OLD.operation = 'filesystem.delete')
      OR (OLD.connector = 'fake' AND OLD.operation IN ('fake.delete', 'fake.admin'))
    ))
  ))
  OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed')
    AND OLD.connector = 'filesystem'
    AND OLD.operation IN ('filesystem.list', 'filesystem.read', 'filesystem.search'))
  OR (OLD.status = 'simulating' AND NEW.status IN ('simulated', 'failed') AND (
    (OLD.connector = 'filesystem' AND OLD.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )) OR (OLD.connector = 'fake' AND OLD.operation IN (
      'fake.write', 'fake.delete', 'fake.admin'
    ))
  ))
  OR (OLD.status = 'simulated' AND NEW.status = 'approval_pending'
    AND OLD.decision = 'allow_with_approval' AND (
      (OLD.connector = 'filesystem' AND OLD.operation = 'filesystem.delete')
      OR (OLD.connector = 'fake' AND OLD.operation IN ('fake.delete', 'fake.admin'))
    ))
)
BEGIN SELECT RAISE(ABORT, 'invalid action request status transition'); END;

CREATE TRIGGER action_request_timestamp_monotonic
BEFORE UPDATE OF updated_at ON action_requests
WHEN NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'action request timestamp cannot move backwards'); END;

CREATE TRIGGER action_request_timestamp_with_transition
BEFORE UPDATE OF updated_at ON action_requests
WHEN NEW.status = OLD.status AND NEW.updated_at IS NOT OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'action request timestamp requires a status transition'); END;

CREATE TRIGGER action_request_prevent_delete
BEFORE DELETE ON action_requests
BEGIN SELECT RAISE(ABORT, 'action requests cannot be deleted'); END;

CREATE TABLE action_simulations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  authorization_payload_hash TEXT NOT NULL CHECK (
    length(authorization_payload_hash) = 64
    AND authorization_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  connector TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  preconditions_json TEXT NOT NULL CHECK (
    json_valid(preconditions_json) AND json_type(preconditions_json) = 'array'
  ),
  diff TEXT NOT NULL,
  diff_sha256 TEXT NOT NULL CHECK (
    length(diff_sha256) = 64 AND diff_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  UNIQUE(project_id, action_request_id),
  FOREIGN KEY(project_id, action_request_id)
    REFERENCES action_requests(project_id, id)
);

CREATE INDEX action_simulations_project_created_idx
ON action_simulations(project_id, created_at, id);

CREATE INDEX action_simulations_action_idx
ON action_simulations(action_request_id);

CREATE TRIGGER action_simulation_matches_action
BEFORE INSERT ON action_simulations
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests
  WHERE id=NEW.action_request_id AND project_id=NEW.project_id
    AND payload_hash=NEW.authorization_payload_hash
    AND connector=NEW.connector
    AND connector_version=NEW.connector_version
    AND operation=NEW.operation
    AND status='simulating'
)
BEGIN SELECT RAISE(ABORT, 'simulation must match a simulating action request'); END;

CREATE TRIGGER action_simulation_preconditions_safe
BEFORE INSERT ON action_simulations
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.preconditions_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.preconditions_json) AS item
  WHERE item.type <> 'object'
    OR typeof(json_extract(item.value, '$.kind')) <> 'text'
    OR json_extract(item.value, '$.kind') NOT IN ('absent', 'file')
    OR typeof(json_extract(item.value, '$.path')) <> 'text'
    OR length(json_extract(item.value, '$.path')) = 0
    OR EXISTS (
      SELECT 1 FROM json_each(item.value) AS field
      WHERE field.key NOT IN ('kind', 'path', 'sha256', 'size')
    )
    OR (
      json_extract(item.value, '$.kind') = 'absent'
      AND EXISTS (
        SELECT 1 FROM json_each(item.value) AS absent_field
        WHERE absent_field.key IN ('sha256', 'size')
      )
    )
    OR (
      json_extract(item.value, '$.kind') = 'file'
      AND (
        typeof(json_extract(item.value, '$.sha256')) <> 'text'
        OR length(json_extract(item.value, '$.sha256')) <> 64
        OR json_extract(item.value, '$.sha256') GLOB '*[^0-9a-f]*'
        OR typeof(json_extract(item.value, '$.size')) <> 'integer'
        OR json_extract(item.value, '$.size') < 0
      )
    )
)
OR EXISTS (
  SELECT 1
  FROM json_each(NEW.preconditions_json) AS item
  GROUP BY json_extract(item.value, '$.path')
  HAVING count(*) > 1
)
BEGIN SELECT RAISE(ABORT, 'simulation preconditions contain a forbidden field'); END;

CREATE TRIGGER action_request_simulation_requires_artifact
BEFORE UPDATE OF status ON action_requests
WHEN OLD.status = 'simulating' AND NEW.status = 'simulated'
  AND NOT EXISTS (
    SELECT 1 FROM action_simulations
    WHERE action_request_id=OLD.id AND project_id=OLD.project_id
      AND authorization_payload_hash=OLD.payload_hash
      AND connector=OLD.connector
      AND connector_version=OLD.connector_version
      AND operation=OLD.operation
  )
BEGIN SELECT RAISE(ABORT, 'simulated action requires a matching artifact'); END;

CREATE TRIGGER action_simulation_immutable
BEFORE UPDATE ON action_simulations
BEGIN SELECT RAISE(ABORT, 'action simulations are immutable'); END;

CREATE TRIGGER action_simulation_prevent_delete
BEFORE DELETE ON action_simulations
BEGIN SELECT RAISE(ABORT, 'action simulations cannot be deleted'); END;

CREATE TEMP TRIGGER m6b_legacy_simulation_upgrade_guard
BEFORE INSERT ON schema_migration
WHEN NEW.version = '0013_filesystem_connector.sql'
  AND EXISTS (
    SELECT 1 FROM action_requests
    WHERE status IN ('simulated', 'approval_pending')
      OR (status = 'simulating' AND NOT (
        connector = 'fake'
        AND connector_version = '1'
        AND (
          (operation = 'fake.write' AND decision = 'allow_simulation_only')
          OR (
            operation IN ('fake.delete', 'fake.admin')
            AND decision = 'allow_with_approval'
          )
        )
      ))
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'M6B upgrade requires remediation of legacy simulated action requests'
  );
END;

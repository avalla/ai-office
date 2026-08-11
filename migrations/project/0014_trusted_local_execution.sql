DROP TRIGGER IF EXISTS m6b_legacy_simulation_upgrade_guard;

CREATE TABLE action_requests_m6c_lite (
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
    'approval_pending', 'rejected', 'executing', 'completed',
    'failed', 'execution_unknown', 'cancelled', 'expired'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, agent_id) REFERENCES agent(project_id, id),
  FOREIGN KEY(project_id, resource_id) REFERENCES resources(project_id, id),
  CHECK (
    (connector = 'fake' AND connector_version = '1')
    OR (connector = 'filesystem' AND connector_version IN ('1', '2'))
  )
);

CREATE TABLE action_simulations_m6c_lite (
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
    REFERENCES action_requests_m6c_lite(project_id, id)
);

INSERT INTO action_requests_m6c_lite SELECT * FROM action_requests;
INSERT INTO action_simulations_m6c_lite SELECT * FROM action_simulations;

DROP TABLE action_simulations;
DROP TABLE action_requests;

ALTER TABLE action_requests_m6c_lite RENAME TO action_requests;
ALTER TABLE action_simulations_m6c_lite RENAME TO action_simulations;

CREATE INDEX action_requests_project_status_idx
ON action_requests(project_id, status, created_at, id);
CREATE INDEX action_requests_project_resource_idx
ON action_requests(project_id, resource_id, created_at, id);
CREATE INDEX action_requests_project_agent_idx
ON action_requests(project_id, agent_id, created_at, id);
CREATE INDEX action_requests_created_idx ON action_requests(created_at, id);

CREATE INDEX action_simulations_project_created_idx
ON action_simulations(project_id, created_at, id);
CREATE INDEX action_simulations_action_idx
ON action_simulations(action_request_id);

CREATE TABLE action_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  simulation_id TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL CHECK (
    length(action_payload_hash) = 64 AND action_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  simulation_artifact_hash TEXT NOT NULL CHECK (
    length(simulation_artifact_hash) = 64
    AND simulation_artifact_hash NOT GLOB '*[^0-9a-f]*'
  ),
  connector TEXT NOT NULL CHECK (connector = 'filesystem'),
  connector_version TEXT NOT NULL CHECK (connector_version = '2'),
  operation TEXT NOT NULL CHECK (operation IN (
    'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  actor TEXT,
  UNIQUE(project_id, id),
  UNIQUE(project_id, action_request_id),
  FOREIGN KEY(project_id, action_request_id)
    REFERENCES action_requests(project_id, id),
  FOREIGN KEY(project_id, simulation_id)
    REFERENCES action_simulations(project_id, id),
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND actor IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL
      AND actor IS NOT NULL AND length(trim(actor)) > 0 AND decided_at >= requested_at)
  )
);

CREATE INDEX action_approvals_project_status_idx
ON action_approvals(project_id, status, requested_at, id);
CREATE INDEX action_approvals_action_idx ON action_approvals(action_request_id);

CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  simulation_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('executing', 'completed', 'failed', 'execution_unknown')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT,
  result_hash TEXT CHECK (
    result_hash IS NULL OR (
      length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  UNIQUE(project_id, id),
  UNIQUE(project_id, action_request_id),
  FOREIGN KEY(project_id, action_request_id)
    REFERENCES action_requests(project_id, id),
  FOREIGN KEY(project_id, simulation_id)
    REFERENCES action_simulations(project_id, id),
  FOREIGN KEY(project_id, approval_id)
    REFERENCES action_approvals(project_id, id),
  CHECK (
    (status = 'executing' AND completed_at IS NULL
      AND failure_code IS NULL AND result_hash IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('failed', 'execution_unknown') AND completed_at IS NOT NULL
      AND failure_code IS NOT NULL AND length(trim(failure_code)) > 0)
  )
);

CREATE INDEX action_executions_project_status_idx
ON action_executions(project_id, status, started_at, id);
CREATE INDEX action_executions_action_idx ON action_executions(action_request_id);

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
  WHERE id=NEW.resource_id AND project_id=NEW.project_id AND provider=NEW.connector
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
    AND OLD.decision = 'allow' AND OLD.connector = 'filesystem'
    AND OLD.connector_version IN ('1', '2')
    AND OLD.operation IN ('filesystem.list', 'filesystem.read', 'filesystem.search'))
  OR (OLD.status = 'authorized' AND NEW.status = 'simulating' AND (
    (OLD.connector = 'filesystem' AND OLD.connector_version = '1' AND (
      (OLD.decision = 'allow_simulation_only' AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move'
      )) OR (OLD.decision = 'allow_with_approval' AND OLD.operation = 'filesystem.delete')
    ))
    OR (OLD.connector = 'filesystem' AND OLD.connector_version = '2'
      AND OLD.decision = 'allow_with_approval'
      AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
      ))
    OR (OLD.connector = 'fake' AND OLD.connector_version = '1' AND (
      (OLD.decision = 'allow_simulation_only' AND OLD.operation = 'fake.write')
      OR (OLD.decision = 'allow_with_approval'
        AND OLD.operation IN ('fake.delete', 'fake.admin'))
    ))
  ))
  OR (OLD.status = 'simulating' AND NEW.status IN ('simulated', 'failed') AND (
    (OLD.connector = 'filesystem' AND OLD.connector_version IN ('1', '2')
      AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
      ))
    OR (OLD.connector = 'fake' AND OLD.connector_version = '1'
      AND OLD.operation IN ('fake.write', 'fake.delete', 'fake.admin'))
  ))
  OR (OLD.status = 'simulated' AND NEW.status = 'approval_pending'
    AND OLD.decision = 'allow_with_approval' AND (
      (OLD.connector = 'filesystem' AND OLD.connector_version = '1'
        AND OLD.operation = 'filesystem.delete')
      OR (OLD.connector = 'fake' AND OLD.connector_version = '1'
        AND OLD.operation IN ('fake.delete', 'fake.admin'))
      OR (OLD.connector = 'filesystem' AND OLD.connector_version = '2'
        AND OLD.operation IN (
          'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
        ) AND EXISTS (
          SELECT 1 FROM action_approvals
          WHERE project_id=OLD.project_id AND action_request_id=OLD.id
            AND status='pending'
        ))
    ))
  OR (OLD.status = 'approval_pending' AND NEW.status = 'rejected'
    AND OLD.connector = 'filesystem' AND OLD.connector_version = '2'
    AND EXISTS (
      SELECT 1 FROM action_approvals
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status='rejected'
    ))
  OR (OLD.status = 'approval_pending' AND NEW.status = 'executing'
    AND OLD.connector = 'filesystem' AND OLD.connector_version = '2'
    AND OLD.decision = 'allow_with_approval'
    AND OLD.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )
    AND EXISTS (
      SELECT 1 FROM action_approvals
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status='approved'
    )
    AND EXISTS (
      SELECT 1 FROM action_executions
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status='executing'
    ))
  OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed')
    AND OLD.connector = 'filesystem' AND OLD.connector_version IN ('1', '2')
    AND OLD.operation IN ('filesystem.list', 'filesystem.read', 'filesystem.search'))
  OR (OLD.status = 'executing'
    AND NEW.status IN ('completed', 'failed', 'execution_unknown')
    AND OLD.connector = 'filesystem' AND OLD.connector_version = '2'
    AND OLD.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )
    AND EXISTS (
      SELECT 1 FROM action_executions
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status=NEW.status
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

CREATE TRIGGER action_simulation_matches_action
BEFORE INSERT ON action_simulations
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests
  WHERE id=NEW.action_request_id AND project_id=NEW.project_id
    AND payload_hash=NEW.authorization_payload_hash
    AND connector=NEW.connector AND connector_version=NEW.connector_version
    AND operation=NEW.operation AND status='simulating'
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
    OR (json_extract(item.value, '$.kind') = 'absent' AND EXISTS (
      SELECT 1 FROM json_each(item.value) AS absent_field
      WHERE absent_field.key IN ('sha256', 'size')
    ))
    OR (json_extract(item.value, '$.kind') = 'file' AND (
      typeof(json_extract(item.value, '$.sha256')) <> 'text'
      OR length(json_extract(item.value, '$.sha256')) <> 64
      OR json_extract(item.value, '$.sha256') GLOB '*[^0-9a-f]*'
      OR typeof(json_extract(item.value, '$.size')) <> 'integer'
      OR json_extract(item.value, '$.size') < 0
    ))
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.preconditions_json) AS item
  GROUP BY json_extract(item.value, '$.path') HAVING count(*) > 1
)
BEGIN SELECT RAISE(ABORT, 'simulation preconditions contain a forbidden field'); END;

CREATE TRIGGER action_request_simulation_requires_artifact
BEFORE UPDATE OF status ON action_requests
WHEN OLD.status = 'simulating' AND NEW.status = 'simulated'
  AND NOT EXISTS (
    SELECT 1 FROM action_simulations
    WHERE action_request_id=OLD.id AND project_id=OLD.project_id
      AND authorization_payload_hash=OLD.payload_hash
      AND connector=OLD.connector AND connector_version=OLD.connector_version
      AND operation=OLD.operation
  )
BEGIN SELECT RAISE(ABORT, 'simulated action requires a matching artifact'); END;

CREATE TRIGGER action_simulation_immutable
BEFORE UPDATE ON action_simulations
BEGIN SELECT RAISE(ABORT, 'action simulations are immutable'); END;
CREATE TRIGGER action_simulation_prevent_delete
BEFORE DELETE ON action_simulations
BEGIN SELECT RAISE(ABORT, 'action simulations cannot be deleted'); END;

CREATE TRIGGER action_approval_matches_action
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests AS request
  JOIN action_simulations AS simulation
    ON simulation.project_id=request.project_id
    AND simulation.action_request_id=request.id
  WHERE request.project_id=NEW.project_id AND request.id=NEW.action_request_id
    AND request.status='simulated' AND request.decision='allow_with_approval'
    AND request.payload_hash=NEW.action_payload_hash
    AND request.connector=NEW.connector
    AND request.connector_version=NEW.connector_version
    AND request.operation=NEW.operation
    AND simulation.id=NEW.simulation_id
    AND simulation.artifact_sha256=NEW.simulation_artifact_hash
)
BEGIN SELECT RAISE(ABORT, 'approval must match a simulated action artifact'); END;

CREATE TRIGGER action_approval_immutable_binding
BEFORE UPDATE OF id, project_id, action_request_id, simulation_id,
  action_payload_hash, simulation_artifact_hash, connector, connector_version,
  operation, requested_at ON action_approvals
BEGIN SELECT RAISE(ABORT, 'action approval binding is immutable'); END;

CREATE TRIGGER action_approval_status_transition
BEFORE UPDATE OF status, decided_at, actor ON action_approvals
WHEN NOT (
  OLD.status='pending' AND NEW.status IN ('approved', 'rejected')
  AND NEW.decided_at IS NOT NULL AND NEW.decided_at >= OLD.requested_at
  AND NEW.actor IS NOT NULL AND length(trim(NEW.actor)) > 0
)
BEGIN SELECT RAISE(ABORT, 'invalid action approval transition'); END;

CREATE TRIGGER action_approval_prevent_delete
BEFORE DELETE ON action_approvals
BEGIN SELECT RAISE(ABORT, 'action approvals cannot be deleted'); END;

CREATE TRIGGER action_execution_matches_approval
BEFORE INSERT ON action_executions
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests AS request
  JOIN action_approvals AS approval
    ON approval.project_id=request.project_id
    AND approval.action_request_id=request.id
  WHERE request.project_id=NEW.project_id AND request.id=NEW.action_request_id
    AND request.status='approval_pending'
    AND request.connector='filesystem' AND request.connector_version='2'
    AND request.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )
    AND approval.id=NEW.approval_id AND approval.status='approved'
    AND approval.simulation_id=NEW.simulation_id
)
BEGIN SELECT RAISE(ABORT, 'execution must match an approved action'); END;

CREATE TRIGGER action_execution_immutable_binding
BEFORE UPDATE OF id, project_id, action_request_id, simulation_id, approval_id,
  started_at ON action_executions
BEGIN SELECT RAISE(ABORT, 'action execution binding is immutable'); END;

CREATE TRIGGER action_execution_status_transition
BEFORE UPDATE OF status, completed_at, failure_code, result_hash ON action_executions
WHEN NOT (
  OLD.status='executing'
  AND NEW.status IN ('completed', 'failed', 'execution_unknown')
  AND NEW.completed_at IS NOT NULL AND NEW.completed_at >= OLD.started_at
  AND (
    (NEW.status='completed' AND NEW.failure_code IS NULL)
    OR (NEW.status IN ('failed', 'execution_unknown')
      AND NEW.failure_code IS NOT NULL AND length(trim(NEW.failure_code)) > 0)
  )
)
BEGIN SELECT RAISE(ABORT, 'invalid action execution transition'); END;

CREATE TRIGGER action_execution_prevent_delete
BEFORE DELETE ON action_executions
BEGIN SELECT RAISE(ABORT, 'action executions cannot be deleted'); END;

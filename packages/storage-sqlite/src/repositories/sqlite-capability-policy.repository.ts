import type { Database } from "bun:sqlite";
import type { CapabilityPolicyRepository } from "@ai-office/application/ports/capability-policy-repository.port.ts";
import {
  ActionRequest,
  type ActionRequestProps,
  type ActionStatus,
} from "@ai-office/domain/capability/action-request.ts";
import {
  ActionSimulation,
  normalizeFilePreconditions,
} from "@ai-office/domain/capability/action-simulation.ts";
import type {
  CapabilityGrant,
  CapabilityPrincipalType,
  PolicyDecisionKind,
  Resource,
  ResourceStatus,
  ResourceType,
  RiskLevel,
} from "@ai-office/domain/capability/capability.ts";
import { normalizeCanonicalJson } from "@ai-office/domain/capability/canonical-json.ts";

interface ResourceRow {
  id: string;
  project_id: string;
  type: ResourceType;
  provider: string;
  external_ref: string | null;
  display_name: string;
  configuration_json: string;
  status: ResourceStatus;
  created_at: string;
  updated_at: string;
}

interface GrantRow {
  id: string;
  project_id: string;
  principal_type: CapabilityPrincipalType;
  principal_id: string;
  resource_id: string;
  actions_json: string;
  constraints_json: string;
  valid_from: string;
  expires_at: string | null;
  revoked_at: string | null;
  granted_by: string;
  reason: string;
  created_at: string;
}

interface ActionRow {
  id: string;
  project_id: string;
  agent_id: string;
  resource_id: string;
  connector: string;
  connector_version: string;
  operation: string;
  normalized_arguments_json: string;
  effective_constraints_json: string;
  payload_hash: string;
  decision: PolicyDecisionKind;
  risk_level: RiskLevel;
  matched_grant_ids_json: string;
  reasons_json: string;
  status: ActionStatus;
  created_at: string;
  updated_at: string;
  agent_run_id?: string | null;
  pipeline_run_id?: string | null;
  pipeline_stage_run_id?: string | null;
}

interface SimulationRow {
  id: string;
  project_id: string;
  action_request_id: string;
  authorization_payload_hash: string;
  connector: string;
  connector_version: string;
  operation: string;
  preconditions_json: string;
  diff: string;
  diff_sha256: string;
  artifact_sha256: string;
  created_at: string;
}

const resourceColumns =
  "id, project_id, type, provider, external_ref, display_name, configuration_json, status, created_at, updated_at";
const grantColumns =
  "id, project_id, principal_type, principal_id, resource_id, actions_json, constraints_json, valid_from, expires_at, revoked_at, granted_by, reason, created_at";
const baseActionColumns =
  "id, project_id, agent_id, resource_id, connector, connector_version, operation, normalized_arguments_json, effective_constraints_json, payload_hash, decision, risk_level, matched_grant_ids_json, reasons_json, status, created_at, updated_at";

function parseRecord(json: string): Readonly<Record<string, unknown>> {
  const value = JSON.parse(json) as unknown;
  const normalized = normalizeCanonicalJson(value);
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  )
    throw new Error("Stored capability JSON is not an object");
  return normalized as Readonly<Record<string, unknown>>;
}

function parseStringArray(json: string, field: string): readonly string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value))
    throw new Error(`Stored capability ${field} is not a string array`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string")
      throw new Error(`Stored capability ${field} is not a string array`);
    result.push(item);
  }
  return Object.freeze(result);
}

function resource(row: ResourceRow): Resource {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    provider: row.provider,
    ...(row.external_ref === null ? {} : { externalRef: row.external_ref }),
    displayName: row.display_name,
    configuration: parseRecord(row.configuration_json),
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function grant(row: GrantRow): CapabilityGrant {
  return {
    id: row.id,
    projectId: row.project_id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    resourceId: row.resource_id,
    actions: parseStringArray(row.actions_json, "actions"),
    constraints: parseRecord(row.constraints_json),
    validFrom: new Date(row.valid_from),
    ...(row.expires_at === null ? {} : { expiresAt: new Date(row.expires_at) }),
    ...(row.revoked_at === null ? {} : { revokedAt: new Date(row.revoked_at) }),
    grantedBy: row.granted_by,
    reason: row.reason,
    createdAt: new Date(row.created_at),
  };
}

function action(row: ActionRow): ActionRequest {
  const props: ActionRequestProps = {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    resourceId: row.resource_id,
    connector: row.connector,
    connectorVersion: row.connector_version,
    operation: row.operation,
    normalizedArguments: parseRecord(row.normalized_arguments_json),
    effectiveConstraints: parseRecord(row.effective_constraints_json),
    payloadHash: row.payload_hash,
    decision: row.decision,
    riskLevel: row.risk_level,
    matchedGrantIds: parseStringArray(
      row.matched_grant_ids_json,
      "matched grant IDs",
    ),
    reasons: parseStringArray(row.reasons_json, "reasons"),
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.agent_run_id == null ? {} : { agentRunId: row.agent_run_id }),
    ...(row.pipeline_run_id == null
      ? {}
      : { pipelineRunId: row.pipeline_run_id }),
    ...(row.pipeline_stage_run_id == null
      ? {}
      : { pipelineStageRunId: row.pipeline_stage_run_id }),
  };
  return ActionRequest.restore(props);
}

function simulation(row: SimulationRow): ActionSimulation {
  const preconditions = JSON.parse(row.preconditions_json) as unknown;
  if (!Array.isArray(preconditions))
    throw new Error("Stored simulation preconditions are not an array");
  return ActionSimulation.create({
    id: row.id,
    projectId: row.project_id,
    actionRequestId: row.action_request_id,
    authorizationPayloadHash: row.authorization_payload_hash,
    connector: row.connector,
    connectorVersion: row.connector_version,
    operation: row.operation,
    preconditions: normalizeFilePreconditions(preconditions),
    diff: row.diff,
    diffSha256: row.diff_sha256,
    artifactSha256: row.artifact_sha256,
    createdAt: new Date(row.created_at),
  });
}

export class SqliteCapabilityPolicyRepository implements CapabilityPolicyRepository {
  private readonly hasPipelineBindingColumns: boolean;
  private readonly hasAgentRunBindingColumn: boolean;

  constructor(private readonly database: Database) {
    this.hasPipelineBindingColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(action_requests)")
      .all()
      .some((column) => column.name === "pipeline_run_id");
    this.hasAgentRunBindingColumn = database
      .query<{ name: string }, []>("PRAGMA table_info(action_requests)")
      .all()
      .some((column) => column.name === "agent_run_id");
  }

  async saveResource(value: Resource): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO resources(
        id, project_id, type, provider, external_ref, display_name,
        configuration_json, credential_ref, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.type,
        value.provider,
        value.externalRef ?? null,
        value.displayName,
        JSON.stringify(value.configuration),
        value.status,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString(),
      );
  }

  async findResource(id: string): Promise<Resource | null> {
    const row = this.database
      .query<ResourceRow, [string]>(
        `SELECT ${resourceColumns} FROM resources WHERE id=?`,
      )
      .get(id);
    return row === null ? null : resource(row);
  }

  async listResources(projectId: string): Promise<Resource[]> {
    return this.database
      .query<ResourceRow, [string]>(
        `SELECT ${resourceColumns} FROM resources WHERE project_id=? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map(resource);
  }

  async disableResource(
    id: string,
    projectId: string,
    now: Date,
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          "UPDATE resources SET status='disabled', updated_at=? WHERE id=? AND project_id=? AND status='active'",
        )
        .run(now.toISOString(), id, projectId).changes === 1
    );
  }

  async saveGrant(value: CapabilityGrant): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO capability_grants(
        id, project_id, principal_type, principal_id, resource_id, actions_json,
        constraints_json, valid_from, expires_at, revoked_at, granted_by, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.principalType,
        value.principalId,
        value.resourceId,
        JSON.stringify(value.actions),
        JSON.stringify(value.constraints),
        value.validFrom.toISOString(),
        value.expiresAt?.toISOString() ?? null,
        value.revokedAt?.toISOString() ?? null,
        value.grantedBy,
        value.reason,
        value.createdAt.toISOString(),
      );
  }

  async findGrant(id: string): Promise<CapabilityGrant | null> {
    const row = this.database
      .query<GrantRow, [string]>(
        `SELECT ${grantColumns} FROM capability_grants WHERE id=?`,
      )
      .get(id);
    return row === null ? null : grant(row);
  }

  async listGrants(
    projectId: string,
    resourceId?: string,
  ): Promise<CapabilityGrant[]> {
    const rows =
      resourceId === undefined
        ? this.database
            .query<GrantRow, [string]>(
              `SELECT ${grantColumns} FROM capability_grants WHERE project_id=? ORDER BY created_at, id`,
            )
            .all(projectId)
        : this.database
            .query<GrantRow, [string, string]>(
              `SELECT ${grantColumns} FROM capability_grants WHERE project_id=? AND resource_id=? ORDER BY created_at, id`,
            )
            .all(projectId, resourceId);
    return rows.map(grant);
  }

  async revokeGrant(
    id: string,
    projectId: string,
    now: Date,
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          "UPDATE capability_grants SET revoked_at=? WHERE id=? AND project_id=? AND revoked_at IS NULL",
        )
        .run(now.toISOString(), id, projectId).changes === 1
    );
  }

  async insertActionRequest(value: ActionRequest): Promise<void> {
    const request = value.snapshot();
    const columns = this.actionInsertColumns();
    const values = [
      request.id,
      request.projectId,
      request.agentId,
      request.resourceId,
      request.connector,
      request.connectorVersion,
      request.operation,
      JSON.stringify(request.normalizedArguments),
      JSON.stringify(request.effectiveConstraints),
      request.payloadHash,
      request.decision,
      request.riskLevel,
      JSON.stringify(request.matchedGrantIds),
      JSON.stringify(request.reasons),
      request.status,
      request.createdAt.toISOString(),
      request.updatedAt.toISOString(),
      ...(this.hasAgentRunBindingColumn ? [request.agentRunId ?? null] : []),
      ...(this.hasPipelineBindingColumns
        ? [request.pipelineRunId ?? null, request.pipelineStageRunId ?? null]
        : []),
    ];
    this.database
      .prepare(
        `INSERT INTO action_requests(${columns}) VALUES (${values.map(() => "?").join(", ")})`,
      )
      .run(...values);
  }

  private actionInsertColumns(): string {
    return [
      "id",
      "project_id",
      "agent_id",
      "resource_id",
      "connector",
      "connector_version",
      "operation",
      "normalized_arguments_json",
      "effective_constraints_json",
      "payload_hash",
      "decision",
      "risk_level",
      "matched_grant_ids_json",
      "reasons_json",
      "status",
      "created_at",
      "updated_at",
      ...(this.hasAgentRunBindingColumn ? ["agent_run_id"] : []),
      ...(this.hasPipelineBindingColumns
        ? ["pipeline_run_id", "pipeline_stage_run_id"]
        : []),
    ].join(", ");
  }

  async transitionActionRequest(input: {
    id: string;
    projectId: string;
    expectedStatus: ActionStatus;
    status: ActionStatus;
    updatedAt: Date;
  }): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE action_requests
           SET status=?, updated_at=?
           WHERE id=? AND project_id=? AND status=?`,
        )
        .run(
          input.status,
          input.updatedAt.toISOString(),
          input.id,
          input.projectId,
          input.expectedStatus,
        ).changes === 1
    );
  }

  async insertActionSimulation(value: ActionSimulation): Promise<boolean> {
    const simulation = value.snapshot();
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO action_simulations(
            id, project_id, action_request_id, authorization_payload_hash,
            connector, connector_version, operation, preconditions_json, diff,
            diff_sha256, artifact_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          simulation.id,
          simulation.projectId,
          simulation.actionRequestId,
          simulation.authorizationPayloadHash,
          simulation.connector,
          simulation.connectorVersion,
          simulation.operation,
          JSON.stringify(simulation.preconditions),
          simulation.diff,
          simulation.diffSha256,
          simulation.artifactSha256,
          simulation.createdAt.toISOString(),
        ).changes === 1
    );
  }

  async findActionSimulationByAction(
    actionRequestId: string,
    projectId: string,
  ): Promise<ActionSimulation | null> {
    const row = this.database
      .query<SimulationRow, [string, string]>(
        `SELECT id, project_id, action_request_id, authorization_payload_hash,
          connector, connector_version, operation, preconditions_json, diff,
          diff_sha256, artifact_sha256, created_at
         FROM action_simulations
         WHERE action_request_id=? AND project_id=?`,
      )
      .get(actionRequestId, projectId);
    return row === null ? null : simulation(row);
  }

  async findActionRequest(id: string): Promise<ActionRequest | null> {
    const row = this.database
      .query<ActionRow, [string]>(
        `SELECT ${this.actionColumns()} FROM action_requests WHERE id=?`,
      )
      .get(id);
    return row === null ? null : action(row);
  }

  async listActionRequests(projectId: string): Promise<ActionRequest[]> {
    return this.database
      .query<ActionRow, [string]>(
        `SELECT ${this.actionColumns()} FROM action_requests WHERE project_id=? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map(action);
  }

  private actionColumns(): string {
    return [
      baseActionColumns,
      ...(this.hasAgentRunBindingColumn ? ["agent_run_id"] : []),
      ...(this.hasPipelineBindingColumns
        ? ["pipeline_run_id", "pipeline_stage_run_id"]
        : []),
    ].join(", ");
  }
}

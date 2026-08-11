import type { ActionApproval } from "@ai-office/domain/capability/action-approval.ts";
import type { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import type { ActionSimulation } from "@ai-office/domain/capability/action-simulation.ts";
import {
  InvalidActionApprovalStateError,
  StaleActionSimulationError,
} from "../capability-errors.ts";
import {
  hashActionSimulationArtifact,
  sha256Text,
} from "./action-simulation-hash.ts";

export function assertSimulationIntegrity(
  request: ActionRequest,
  simulation: ActionSimulation,
): void {
  const action = request.snapshot();
  const artifact = simulation.snapshot();
  const diffSha256 = sha256Text(artifact.diff);
  const artifactSha256 = hashActionSimulationArtifact({
    schemaVersion: 1,
    actionRequestId: action.id,
    authorizationPayloadHash: action.payloadHash,
    connector: action.connector,
    connectorVersion: action.connectorVersion,
    operation: action.operation,
    preconditions: artifact.preconditions,
    diffSha256,
  });
  if (
    artifact.projectId !== action.projectId ||
    artifact.actionRequestId !== action.id ||
    artifact.authorizationPayloadHash !== action.payloadHash ||
    artifact.connector !== action.connector ||
    artifact.connectorVersion !== action.connectorVersion ||
    artifact.operation !== action.operation ||
    artifact.diffSha256 !== diffSha256 ||
    artifact.artifactSha256 !== artifactSha256
  )
    throw new StaleActionSimulationError();
}

export function assertApprovalBinding(
  request: ActionRequest,
  simulation: ActionSimulation,
  approval: ActionApproval,
): void {
  assertSimulationIntegrity(request, simulation);
  const action = request.snapshot();
  const artifact = simulation.snapshot();
  const binding = approval.snapshot();
  if (
    binding.projectId !== action.projectId ||
    binding.actionRequestId !== action.id ||
    binding.simulationId !== artifact.id ||
    binding.actionPayloadHash !== action.payloadHash ||
    binding.simulationArtifactHash !== artifact.artifactSha256 ||
    binding.connector !== action.connector ||
    binding.connectorVersion !== action.connectorVersion ||
    binding.operation !== action.operation
  )
    throw new InvalidActionApprovalStateError();
}

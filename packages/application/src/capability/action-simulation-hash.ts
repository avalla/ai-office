import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type { FilePrecondition } from "@ai-office/domain/capability/action-simulation.ts";

export interface CanonicalActionSimulationPayload {
  schemaVersion: 1;
  actionRequestId: string;
  authorizationPayloadHash: string;
  connector: string;
  connectorVersion: string;
  operation: string;
  preconditions: readonly FilePrecondition[];
  diffSha256: string;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashActionSimulationArtifact(
  payload: CanonicalActionSimulationPayload,
): string {
  return sha256Text(canonicalStringify(payload));
}

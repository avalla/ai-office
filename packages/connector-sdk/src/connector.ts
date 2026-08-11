import type {
  ConnectorConstraintHandler,
  PolicyConnectorDescriptor,
  ResourceType,
  RiskLevel,
} from "@ai-office/domain/capability/capability.ts";

export interface ConnectorOperationDescriptor {
  operation: string;
  mode: "read" | "mutation";
  riskLevel: RiskLevel;
  supportsSimulation: boolean;
  supportsExecution: boolean;
  requiresApproval: boolean;
}

export interface ConnectorDescriptor {
  id: string;
  version: string;
  supportedResourceTypes: readonly ResourceType[];
  operations: readonly ConnectorOperationDescriptor[];
}

export interface ConnectorResourceRegistrationInput {
  type: ResourceType;
  externalRef?: string;
  configuration: Readonly<Record<string, unknown>>;
}

export interface PreparedConnectorResource {
  externalRef?: string;
  configuration: Readonly<Record<string, unknown>>;
}

export interface ConnectorResourceScope {
  id: string;
  type: ResourceType;
  provider: string;
  externalRef?: string;
  configuration: Readonly<Record<string, unknown>>;
}

export interface ConnectorInvocation {
  resource: ConnectorResourceScope;
  operation: string;
  arguments: Readonly<Record<string, unknown>>;
  effectiveConstraints: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface ConnectorReadResult {
  kind: "read";
  output: Readonly<Record<string, unknown>>;
  audit: {
    relativePath?: string;
    byteLength?: number;
    resultCount?: number;
    contentSha256?: string;
    truncated?: boolean;
  };
}

export interface ConnectorFilePrecondition {
  kind: "absent" | "file";
  path: string;
  sha256?: string;
  size?: number;
}

export interface ConnectorSimulationResult {
  kind: "simulation";
  diff: string;
  preconditions: readonly ConnectorFilePrecondition[];
}

export type ConnectorInvocationResult =
  ConnectorReadResult | ConnectorSimulationResult;

/** Connector callbacks are context-free and must not depend on `this` or mutable receiver state. */
export type NormalizeConnectorArguments = (
  this: void,
  operation: string,
  value: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

export type NormalizeConnectorConstraints = (
  this: void,
  value: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

export type PrepareConnectorResource = (
  this: void,
  input: ConnectorResourceRegistrationInput,
) => Promise<PreparedConnectorResource>;

export type InvokeConnector = (
  this: void,
  input: ConnectorInvocation,
) => Promise<ConnectorInvocationResult>;

export interface ConnectorDefinition {
  readonly descriptor: ConnectorDescriptor;
  readonly constraintHandler: ConnectorConstraintHandler;
  readonly normalizeArguments: NormalizeConnectorArguments;
  readonly normalizeConstraints: NormalizeConnectorConstraints;
  readonly prepareResource: PrepareConnectorResource;
  readonly invoke?: InvokeConnector;
}

export function asPolicyDescriptor(
  descriptor: ConnectorDescriptor,
): PolicyConnectorDescriptor {
  return descriptor;
}

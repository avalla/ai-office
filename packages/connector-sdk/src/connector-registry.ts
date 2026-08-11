import type {
  ConnectorPolicyDefinition,
  ConnectorPolicyRegistry,
} from "@ai-office/domain/capability/capability.ts";
import type {
  ConnectorDefinition,
  ConnectorDescriptor,
  ConnectorOperationDescriptor,
} from "./connector.ts";
import {
  ConnectorRegistryError,
  UnsupportedConnectorError,
  UnsupportedConnectorOperationError,
} from "./errors.ts";

const resourceTypes = new Set([
  "filesystem_scope",
  "github_repository",
  "sqlite_database",
  "shell_environment",
]);
const riskLevels = new Set(["low", "medium", "high", "critical"]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new ConnectorRegistryError(`${field} cannot be empty`);
  if (normalized !== value)
    throw new ConnectorRegistryError(`${field} must be canonical`);
  return normalized;
}

function freezeOperation(
  operation: ConnectorOperationDescriptor,
): ConnectorOperationDescriptor {
  if (!riskLevels.has(operation.riskLevel))
    throw new ConnectorRegistryError("Connector operation risk is invalid");
  if (operation.mode !== "read" && operation.mode !== "mutation")
    throw new ConnectorRegistryError("Connector operation mode is invalid");
  for (const flag of [
    operation.supportsSimulation,
    operation.supportsExecution,
    operation.requiresApproval,
  ])
    if (typeof flag !== "boolean")
      throw new ConnectorRegistryError("Connector operation flags are invalid");
  return Object.freeze({
    ...operation,
    operation: required(operation.operation, "connector operation"),
  });
}

function freezeDefinition(
  definition: ConnectorDefinition,
): ConnectorDefinition {
  const id = required(definition.descriptor.id, "connector id");
  const version = required(definition.descriptor.version, "connector version");
  if (definition.constraintHandler.connector !== id)
    throw new ConnectorRegistryError(
      `Constraint handler ${definition.constraintHandler.connector} does not match connector ${id}`,
    );
  const operations = definition.descriptor.operations.map(freezeOperation);
  operations.sort((left, right) =>
    compareText(left.operation, right.operation),
  );
  const operationIds = new Set<string>();
  for (const operation of operations) {
    if (operationIds.has(operation.operation))
      throw new ConnectorRegistryError(
        `Duplicate connector operation: ${operation.operation}`,
      );
    if (!operation.operation.startsWith(`${id}.`))
      throw new ConnectorRegistryError(
        `Connector operation must use ${id}. namespace: ${operation.operation}`,
      );
    if (operation.mode === "read" && operation.supportsSimulation)
      throw new ConnectorRegistryError(
        `Read operation cannot require simulation: ${operation.operation}`,
      );
    if (
      operation.mode === "mutation" &&
      operation.supportsExecution &&
      !operation.requiresApproval
    )
      throw new ConnectorRegistryError(
        `Executable mutation operation must require approval: ${operation.operation}`,
      );
    if (operation.mode === "mutation" && !operation.supportsSimulation)
      throw new ConnectorRegistryError(
        `M6B mutation operation must support simulation: ${operation.operation}`,
      );
    if (operation.mode === "read" && operation.requiresApproval)
      throw new ConnectorRegistryError(
        `Read operation cannot require approval: ${operation.operation}`,
      );
    operationIds.add(operation.operation);
  }
  if (operations.length === 0)
    throw new ConnectorRegistryError(`Connector ${id} has no operations`);
  const hasExecutableMutation = operations.some(
    (operation) => operation.mode === "mutation" && operation.supportsExecution,
  );
  if (hasExecutableMutation && definition.executeMutation === undefined)
    throw new ConnectorRegistryError(
      `Connector ${id} has executable mutations without an execution boundary`,
    );
  if (!hasExecutableMutation && definition.executeMutation !== undefined)
    throw new ConnectorRegistryError(
      `Connector ${id} exposes an unused mutation execution boundary`,
    );
  const supportedResourceTypes = Object.freeze(
    [...new Set(definition.descriptor.supportedResourceTypes)].sort(
      compareText,
    ),
  );
  if (supportedResourceTypes.length === 0)
    throw new ConnectorRegistryError(`Connector ${id} has no resource types`);
  if (supportedResourceTypes.some((type) => !resourceTypes.has(type)))
    throw new ConnectorRegistryError(
      `Connector ${id} has an invalid resource type`,
    );
  const descriptor: ConnectorDescriptor = Object.freeze({
    id,
    version,
    supportedResourceTypes,
    operations: Object.freeze(operations),
  });
  const sourceHandler = definition.constraintHandler;
  const combineAndValidate = sourceHandler.combineAndValidate;
  const constraintHandler = Object.freeze({
    connector: id,
    combineAndValidate: (
      operation: Parameters<typeof combineAndValidate>[0],
      arguments_: Parameters<typeof combineAndValidate>[1],
      constraints: Parameters<typeof combineAndValidate>[2],
      resourceConfiguration: Parameters<typeof combineAndValidate>[3],
    ) =>
      combineAndValidate.call(
        undefined,
        operation,
        arguments_,
        constraints,
        resourceConfiguration,
      ),
  });
  const sourceNormalizeArguments = definition.normalizeArguments;
  const sourceNormalizeConstraints = definition.normalizeConstraints;
  const sourcePrepareResource = definition.prepareResource;
  const sourceInvoke = definition.invoke;
  const sourceExecuteMutation = definition.executeMutation;
  const normalizeArguments: ConnectorDefinition["normalizeArguments"] = (
    operation,
    value,
  ) => sourceNormalizeArguments.call(undefined, operation, value);
  const normalizeConstraints: ConnectorDefinition["normalizeConstraints"] = (
    value,
  ) => sourceNormalizeConstraints.call(undefined, value);
  const prepareResource: ConnectorDefinition["prepareResource"] = (input) =>
    sourcePrepareResource.call(undefined, input);
  const invoke: ConnectorDefinition["invoke"] =
    sourceInvoke === undefined
      ? undefined
      : (input) => sourceInvoke.call(undefined, input);
  const executeMutation: ConnectorDefinition["executeMutation"] =
    sourceExecuteMutation === undefined
      ? undefined
      : (input) => sourceExecuteMutation.call(undefined, input);
  return Object.freeze({
    descriptor,
    constraintHandler,
    normalizeArguments,
    normalizeConstraints,
    prepareResource,
    ...(invoke === undefined ? {} : { invoke }),
    ...(executeMutation === undefined ? {} : { executeMutation }),
  });
}

export class ConnectorRegistry implements ConnectorPolicyRegistry {
  private readonly definitions: ReadonlyMap<string, ConnectorDefinition>;

  constructor(definitions: readonly ConnectorDefinition[]) {
    const entries: Array<readonly [string, ConnectorDefinition]> = [];
    const ids = new Set<string>();
    for (const candidate of definitions) {
      const definition = freezeDefinition(candidate);
      if (ids.has(definition.descriptor.id))
        throw new ConnectorRegistryError(
          `Duplicate connector descriptor: ${definition.descriptor.id}`,
        );
      ids.add(definition.descriptor.id);
      entries.push([definition.descriptor.id, definition]);
    }
    entries.sort(([left], [right]) => compareText(left, right));
    this.definitions = new Map(entries);
    Object.freeze(this);
  }

  get(provider: string): ConnectorDescriptor | null {
    return this.definitions.get(provider)?.descriptor ?? null;
  }

  getDefinition(provider: string): ConnectorDefinition | null {
    return this.definitions.get(provider) ?? null;
  }

  getPolicyDefinition(provider: string): ConnectorPolicyDefinition | null {
    const definition = this.definitions.get(provider);
    return definition === undefined
      ? null
      : Object.freeze({
          descriptor: definition.descriptor,
          constraintHandler: definition.constraintHandler,
        });
  }

  requireDefinition(provider: string): ConnectorDefinition {
    const definition = this.getDefinition(provider);
    if (definition === null) throw new UnsupportedConnectorError(provider);
    return definition;
  }

  requireOperation(
    provider: string,
    operation: string,
  ): ConnectorOperationDescriptor {
    const definition = this.requireDefinition(provider);
    const descriptor = definition.descriptor.operations.find(
      (candidate) => candidate.operation === operation,
    );
    if (descriptor === undefined)
      throw new UnsupportedConnectorOperationError(provider, operation);
    return descriptor;
  }
}

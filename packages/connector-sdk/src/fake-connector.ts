import type { ConnectorDefinition } from "./connector.ts";
import { normalizeCanonicalJson } from "@ai-office/domain/capability/canonical-json.ts";
import {
  CapabilityValidationError,
  UnsupportedConnectorResourceTypeError,
} from "@ai-office/domain/capability/errors.ts";
import {
  FakeConnectorConstraintHandler,
  validateFakeConnectorConstraints,
} from "@ai-office/domain/capability/fake-connector-policy.ts";

function record(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeCanonicalJson(value);
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  )
    throw new CapabilityValidationError("Connector value must be an object");
  return normalized as Readonly<Record<string, unknown>>;
}

export const fakeConnectorDescriptor = {
  id: "fake",
  version: "1",
  supportedResourceTypes: ["filesystem_scope"],
  operations: [
    {
      operation: "fake.read",
      mode: "read",
      riskLevel: "low",
      supportsSimulation: false,
      supportsExecution: false,
      requiresApproval: false,
    },
    {
      operation: "fake.write",
      mode: "mutation",
      riskLevel: "medium",
      supportsSimulation: true,
      supportsExecution: false,
      requiresApproval: false,
    },
    {
      operation: "fake.delete",
      mode: "mutation",
      riskLevel: "high",
      supportsSimulation: true,
      supportsExecution: false,
      requiresApproval: true,
    },
    {
      operation: "fake.admin",
      mode: "mutation",
      riskLevel: "critical",
      supportsSimulation: true,
      supportsExecution: false,
      requiresApproval: true,
    },
  ],
} as const;

export const fakeConnectorDefinition: ConnectorDefinition = {
  descriptor: fakeConnectorDescriptor,
  constraintHandler: new FakeConnectorConstraintHandler(),
  normalizeArguments: (_operation, value) => record(value),
  normalizeConstraints: (value) =>
    validateFakeConnectorConstraints(record(value)) as Readonly<
      Record<string, unknown>
    >,
  prepareResource: async (input) => {
    if (input.type !== "filesystem_scope")
      throw new UnsupportedConnectorResourceTypeError("fake", input.type);
    return {
      ...(input.externalRef === undefined
        ? {}
        : { externalRef: input.externalRef }),
      configuration: record(input.configuration),
    };
  },
};

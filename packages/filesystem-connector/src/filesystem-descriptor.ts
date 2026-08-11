import type { ConnectorDescriptor } from "@ai-office/connector-sdk/connector.ts";

export const filesystemConnectorDescriptor = {
  id: "filesystem",
  version: "1",
  supportedResourceTypes: ["filesystem_scope"],
  operations: [
    {
      operation: "filesystem.list",
      mode: "read",
      riskLevel: "low",
      supportsSimulation: false,
      supportsExecution: true,
      requiresApproval: false,
    },
    {
      operation: "filesystem.read",
      mode: "read",
      riskLevel: "low",
      supportsSimulation: false,
      supportsExecution: true,
      requiresApproval: false,
    },
    {
      operation: "filesystem.search",
      mode: "read",
      riskLevel: "low",
      supportsSimulation: false,
      supportsExecution: true,
      requiresApproval: false,
    },
    ...["create", "write", "move"].map((operation) => ({
      operation: `filesystem.${operation}`,
      mode: "mutation" as const,
      riskLevel: "medium" as const,
      supportsSimulation: true,
      supportsExecution: false,
      requiresApproval: false,
    })),
    {
      operation: "filesystem.delete",
      mode: "mutation",
      riskLevel: "high",
      supportsSimulation: true,
      supportsExecution: false,
      requiresApproval: true,
    },
  ],
} as const satisfies ConnectorDescriptor;

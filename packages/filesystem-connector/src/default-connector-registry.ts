import { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import { fakeConnectorDefinition } from "@ai-office/connector-sdk/fake-connector.ts";
import { filesystemConnectorDefinition } from "./filesystem-connector.ts";

export function createDefaultConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([
    fakeConnectorDefinition,
    filesystemConnectorDefinition,
  ]);
}

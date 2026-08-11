export class ConnectorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorRegistryError";
  }
}

export class UnsupportedConnectorError extends UnsupportedConnectorProviderError {
  constructor(provider: string) {
    super(provider);
    this.name = "UnsupportedConnectorError";
  }
}

export class UnsupportedConnectorOperationError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
  ) {
    super(`Unsupported operation for connector ${provider}: ${operation}`);
    this.name = "UnsupportedConnectorOperationError";
  }
}

export class ConnectorExecutionUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`Connector has no executable boundary: ${provider}`);
    this.name = "ConnectorExecutionUnavailableError";
  }
}
import { UnsupportedConnectorProviderError } from "@ai-office/domain/capability/errors.ts";

import type {
  OperationProvider,
  OperationProviderCatalog,
} from "@ai-office/application/ports/operation-provider-catalog.port.ts";
import type { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";

/**
 * The operation providers of one composed connector registry: each
 * descriptor's ID, version and operations with their mode, copied once and
 * frozen. No connector function, resource type, risk level or approval flag
 * crosses the port, so holding the catalog cannot invoke or authorize
 * anything.
 */
export function createOperationProviderCatalog(
  registry: ConnectorRegistry,
): OperationProviderCatalog {
  const providers: readonly OperationProvider[] = Object.freeze(
    registry.descriptors().map(({ id, version, operations }) =>
      Object.freeze({
        id,
        version,
        operations: Object.freeze(
          operations.map(({ operation, mode }) =>
            Object.freeze({ operation, mode }),
          ),
        ),
      }),
    ),
  );
  return Object.freeze({ list: () => providers });
}

/**
 * What the Runtime host has registered to carry out operations, as data. A
 * provider is identified by its ID and version and lists the operations it
 * offers with their mode. The port exposes nothing that could invoke,
 * authorize or configure a provider: no function, resource, risk level,
 * approval flag, grant or credential.
 *
 * Availability on one Runtime installation, like the installed pack catalog.
 * It is never project state and never a permission.
 */
export interface OperationProviderOperation {
  readonly operation: string;
  readonly mode: "read" | "mutation";
}

export interface OperationProvider {
  readonly id: string;
  readonly version: string;
  readonly operations: readonly OperationProviderOperation[];
}

export interface OperationProviderCatalog {
  list(): readonly OperationProvider[];
}

/** No provider: every required operation is unmet. The fail-closed default. */
export const noOperationProviders: OperationProviderCatalog = Object.freeze({
  list: () => [],
});

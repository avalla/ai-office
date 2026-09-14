/**
 * Read-only view of the gateway's provider registry for diagnostics. It
 * constructs no provider client, sends no model request, and exposes
 * credential environment variable names only, never their values.
 */
export interface ModelProviderCatalog {
  supportedProviders(): readonly string[];
  /** Missing credential variable names, or null for an unsupported provider. */
  missingCredentials(providerId: string): readonly string[] | null;
  /** Whether the metered gateway worker can execute the provider's models. */
  supportsGatewayExecution(providerId: string): boolean;
}

export const emptyModelProviderCatalog: ModelProviderCatalog = {
  supportedProviders: () => [],
  missingCredentials: () => null,
  supportsGatewayExecution: () => false,
};

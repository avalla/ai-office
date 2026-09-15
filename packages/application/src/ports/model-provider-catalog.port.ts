import type { ProviderCredentialStatus } from "./provider-credential-source.port.ts";

/**
 * Read-only view of the gateway's provider registry for diagnostics. It
 * constructs no provider client, sends no model request, and exposes
 * credential names and presence only, never their values or locations.
 */
export interface ModelProviderCatalog {
  supportedProviders(): readonly string[];
  /** Unusable (missing or invalid) credential names, or null for an unsupported provider. */
  missingCredentials(providerId: string): readonly string[] | null;
  /** Credential statuses by name, or null for an unsupported provider. */
  credentialStatuses(
    providerId: string,
  ): readonly ProviderCredentialStatus[] | null;
  /** True when the Runtime reads provider credentials only from its Runtime home. */
  credentialsManaged(): boolean;
  /** Whether the metered gateway worker can execute the provider's models. */
  supportsGatewayExecution(providerId: string): boolean;
}

export const emptyModelProviderCatalog: ModelProviderCatalog = {
  supportedProviders: () => [],
  missingCredentials: () => null,
  credentialStatuses: () => null,
  credentialsManaged: () => false,
  supportsGatewayExecution: () => false,
};

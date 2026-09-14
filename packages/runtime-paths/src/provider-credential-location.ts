import { join } from "node:path";

/**
 * The canonical provider credential directory of a Runtime home. It holds one
 * owner-only file per credential, named by the credential's logical name (for
 * example `OPENAI_API_KEY`). It is separate from `model-routing.yaml` and the
 * SQLite databases, and nothing copies it into project or portable state.
 */
export const runtimeHomeProviderCredentialsDirectoryName = "credentials";

/**
 * Written into generated Runtime service definitions next to the routing
 * source marker. With this value the Runtime reads provider credentials only
 * from the Runtime home directory and ignores credential variables of the
 * service manager's environment. The marker itself is not a secret.
 */
export const providerCredentialSourceEnvironmentVariable =
  "AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE";
export const runtimeHomeProviderCredentialSource = "runtime_home";

export function runtimeHomeProviderCredentialsDirectory(
  runtimeHome: string,
): string {
  return join(runtimeHome, runtimeHomeProviderCredentialsDirectoryName);
}

/**
 * Runtime host provider credentials, loaded once by the composition root.
 *
 * Credentials are host configuration, not model routing, project state, agent
 * state or a capability. Diagnostics see only {@link ProviderCredentialStatus}
 * by logical name; the value is available solely to a gateway adapter that
 * authenticates a provider request, and is never logged, persisted, audited,
 * returned in a command result or serialized.
 */
export type ProviderCredentialState = "present" | "missing" | "invalid";

/**
 * `environment`: the foreground Runtime's own environment variable.
 * `runtime_home`: the owner-only file `<AI_OFFICE_HOME>/credentials/<NAME>`.
 */
export type ProviderCredentialOrigin = "environment" | "runtime_home";

/** Sanitized reasons a credential is unusable; they never carry a value or path. */
export type ProviderCredentialIssueCode =
  | "CREDENTIAL_SOURCE_INVALID"
  | "CREDENTIAL_DIRECTORY_INSECURE"
  | "CREDENTIAL_SYMLINK"
  | "CREDENTIAL_NOT_REGULAR_FILE"
  | "CREDENTIAL_WRONG_OWNER"
  | "CREDENTIAL_INSECURE_PERMISSIONS"
  | "CREDENTIAL_TOO_LARGE"
  | "CREDENTIAL_MALFORMED"
  | "CREDENTIAL_UNREADABLE";

export interface ProviderCredentialStatus {
  /** Logical credential name, such as `OPENAI_API_KEY`. */
  readonly name: string;
  readonly state: ProviderCredentialState;
  /** Where a present or invalid credential was found; null when missing. */
  readonly origin: ProviderCredentialOrigin | null;
  readonly issue: ProviderCredentialIssueCode | null;
  /**
   * A managed Runtime found this name in its service manager environment and
   * ignored it. Only the name is reported.
   */
  readonly ambientIgnored: boolean;
}

/**
 * What application code may know about host credentials: presence by name.
 * Values stay in infrastructure (`packages/llm-gateway`), where only the
 * gateway's provider construction boundary obtains the credentials of the one
 * provider it resolves.
 */
export interface ProviderCredentialSource {
  /** True when the Runtime reads credentials only from its Runtime home. */
  readonly managed: boolean;
  status(name: string): ProviderCredentialStatus;
}

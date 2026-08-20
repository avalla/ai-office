export const agentClientIds = ["codex", "claude"] as const;
export type AgentClientId = (typeof agentClientIds)[number];

export type AgentClientFileOwnership =
  "absent" | "user_owned" | "ai_office_owned" | "merged";

export interface AgentClientDetection {
  clientId: AgentClientId;
  displayName: string;
  status: "detected" | "not_detected";
  executablePath?: string;
}

export interface AgentClientFileState {
  relativePath: string;
  exists: boolean;
  ownership: AgentClientFileOwnership;
  sha256?: string;
  /** Integration state at this file's boundary; see the client integration contract. */
  integrationStatus: "missing" | "integrated" | "unmanaged" | "conflict";
}

export interface AgentClientIntegrationIssue {
  severity: "warning" | "conflict";
  code: string;
  message: string;
}

export interface AgentClientInspection {
  clientId: AgentClientId;
  rootPath: string;
  canonicalInstructions: AgentClientFileState;
  clientInstructions?: AgentClientFileState;
  legacyInstructions: AgentClientFileState;
  issues: readonly AgentClientIntegrationIssue[];
}

export interface AgentClientFileOperation {
  kind: "create" | "update";
  relativePath: string;
  expectedSha256: string | null;
  nextContent: string;
  ownershipAfter: "ai_office_owned" | "merged";
  summary: string;
}

export interface AgentClientIntegrationDraft {
  contractVersion: 1;
  clientId: AgentClientId;
  rootPath: string;
  operations: readonly AgentClientFileOperation[];
  issues: readonly AgentClientIntegrationIssue[];
}

export interface AgentClientValidation {
  clientId: AgentClientId;
  rootPath: string;
  /** True when client wiring can consume project instructions without a conflict. */
  valid: boolean;
  issues: readonly AgentClientIntegrationIssue[];
}

export interface AgentClientAdapter {
  readonly id: AgentClientId;
  detect(): Promise<AgentClientDetection>;
  inspect(rootPath: string): Promise<AgentClientInspection>;
  plan(input: {
    rootPath: string;
    canonicalInstructions: string;
  }): Promise<AgentClientIntegrationDraft>;
  apply(plan: AgentClientIntegrationDraft): Promise<void>;
  validate(rootPath: string): Promise<AgentClientValidation>;
}

export interface AgentClientCatalog {
  list(): readonly AgentClientAdapter[];
  get(id: AgentClientId): AgentClientAdapter;
}

import type {
  AgentClientFileOperation,
  AgentClientIntegrationIssue,
} from "./agent-client-adapter.port.ts";

export interface SharedProjectArtifactDraft {
  rootPath: string;
  operations: readonly AgentClientFileOperation[];
  issues: readonly AgentClientIntegrationIssue[];
}

/** Reconciles AI Office guidance shared by all supported host clients. */
export interface SharedProjectArtifactAdapter {
  plan(input: {
    rootPath: string;
    canonicalInstructions: string;
    projectSkill: string;
  }): Promise<SharedProjectArtifactDraft>;
  apply(draft: SharedProjectArtifactDraft): Promise<void>;
}

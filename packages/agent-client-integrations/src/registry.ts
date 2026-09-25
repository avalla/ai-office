import { AgentClientIntegrationError } from "@ai-office/application/agent-client/errors.ts";
import type {
  AgentClientAdapter,
  AgentClientCatalog,
  AgentClientId,
} from "@ai-office/application/ports/agent-client-adapter.port.ts";
import {
  ClaudeAgentClientAdapter,
  CodexAgentClientAdapter,
  SharedProjectArtifactsAdapter,
} from "./adapters.ts";
import {
  LocalAgentClientFiles,
  PathExecutableLocator,
  type LocalAgentClientFilesHooks,
} from "./local-agent-client-files.ts";

export class DefaultAgentClientCatalog implements AgentClientCatalog {
  private readonly clients: readonly AgentClientAdapter[];
  readonly sharedProjectArtifacts: SharedProjectArtifactsAdapter;

  constructor(
    input: {
      pathValue?: string;
      fileHooks?: LocalAgentClientFilesHooks;
    } = {},
  ) {
    const files = new LocalAgentClientFiles(input.fileHooks);
    const executables = new PathExecutableLocator(input.pathValue);
    this.sharedProjectArtifacts = new SharedProjectArtifactsAdapter(files);
    this.clients = [
      new CodexAgentClientAdapter(files, executables),
      new ClaudeAgentClientAdapter(files, executables),
    ];
  }

  list(): readonly AgentClientAdapter[] {
    return this.clients;
  }

  get(id: AgentClientId): AgentClientAdapter {
    const client = this.clients.find((candidate) => candidate.id === id);
    if (client === undefined)
      throw new AgentClientIntegrationError(`Unsupported agent client: ${id}`);
    return client;
  }
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  InvalidAgentDefinitionError,
  parseAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.ts";

export interface LoadedAgentDefinition {
  definition: AgentDefinition;
  sourcePath: string;
}

export class AgentDefinitionDirectoryError extends Error {
  constructor(directory: string, detail: string) {
    super(`Cannot load agent definitions from ${directory}: ${detail}`);
    this.name = "AgentDefinitionDirectoryError";
  }
}

export class YamlAgentDefinitionLoader {
  load(directory: string): LoadedAgentDefinition[] {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new AgentDefinitionDirectoryError(
        directory,
        error instanceof Error ? error.message : "directory is not readable",
      );
    }
    const paths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, "agent.yaml"))
      .sort();
    const loaded: LoadedAgentDefinition[] = [];
    const agentIds = new Set<string>();
    const roleKeys = new Set<string>();
    for (const sourcePath of paths) {
      if (!existsSync(sourcePath))
        throw new AgentDefinitionDirectoryError(
          directory,
          `missing ${sourcePath}`,
        );
      let value: unknown;
      try {
        value = Bun.YAML.parse(readFileSync(sourcePath, "utf8"));
      } catch (error) {
        throw new InvalidAgentDefinitionError(
          sourcePath,
          error instanceof Error ? error.message : "invalid YAML",
        );
      }
      const definition = parseAgentDefinition(value, sourcePath);
      if (agentIds.has(definition.id))
        throw new InvalidAgentDefinitionError(
          sourcePath,
          `duplicate agent id ${definition.id}`,
        );
      if (roleKeys.has(definition.roleKey))
        throw new InvalidAgentDefinitionError(
          sourcePath,
          `duplicate role_key ${definition.roleKey}`,
        );
      agentIds.add(definition.id);
      roleKeys.add(definition.roleKey);
      loaded.push({ definition, sourcePath });
    }
    return loaded;
  }
}

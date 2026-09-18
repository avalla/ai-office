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

export interface AgentDefinitionLoadOptions {
  requireGuidance?: boolean;
}

export class AgentDefinitionDirectoryError extends Error {
  constructor(directory: string, detail: string) {
    super(`Cannot load agent definitions from ${directory}: ${detail}`);
    this.name = "AgentDefinitionDirectoryError";
  }
}

export class YamlAgentDefinitionLoader {
  load(
    directory: string,
    options: AgentDefinitionLoadOptions = {},
  ): LoadedAgentDefinition[] {
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
      let definition = parseAgentDefinition(value, sourcePath);
      if (options.requireGuidance) {
        const guidancePath = join(sourcePath, "..", "system.md");
        if (!existsSync(guidancePath))
          throw new AgentDefinitionDirectoryError(
            directory,
            `missing ${guidancePath}`,
          );
        let guidance: string;
        try {
          guidance = readFileSync(guidancePath, "utf8");
        } catch (error) {
          throw new InvalidAgentDefinitionError(
            guidancePath,
            error instanceof Error ? error.message : "guidance is not readable",
          );
        }
        if (
          guidance.trim() === "" ||
          new TextEncoder().encode(guidance).byteLength > 65536
        )
          throw new InvalidAgentDefinitionError(
            guidancePath,
            "guidance must be non-empty and at most 65536 bytes",
          );
        definition = { ...definition, roleGuidance: guidance };
      }
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

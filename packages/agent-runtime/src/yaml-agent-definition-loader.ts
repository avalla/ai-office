import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.ts";

export interface LoadedAgentDefinition {
  definition: AgentDefinition;
  sourcePath: string;
}

export class YamlAgentDefinitionLoader {
  load(directory: string): LoadedAgentDefinition[] {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, "agent.yaml"))
      .sort()
      .map((sourcePath) => ({
        definition: parseAgentDefinition(
          Bun.YAML.parse(readFileSync(sourcePath, "utf8")),
          sourcePath,
        ),
        sourcePath,
      }));
  }
}

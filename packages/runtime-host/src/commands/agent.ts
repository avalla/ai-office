import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import { SyncAgentDefinitions } from "@ai-office/application/commands/sync-agent-definitions.ts";
import {
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

export async function handleAgentCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const { projects, runtime, ids, clock, transactions, io } = context;
  if (command === "agent:sync") {
    const parsed = parseArguments(args, new Set(["project", "directory"]));
    const projectId = requiredOption(parsed, "project");
    const directory = requiredOption(parsed, "directory");
    const count = await new SyncAgentDefinitions(
      projects,
      runtime,
      ids,
      clock,
      transactions,
    ).execute(projectId, new YamlAgentDefinitionLoader().load(directory));
    io.stdout(`Agent definitions synchronized: ${count}`);
    return 0;
  }
  if (command === "agent:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    const values = await runtime.listAgents(requiredOption(parsed, "project"));
    if (values.length === 0) {
      io.stdout("No agents found.");
      return 0;
    }
    io.stdout("ID\tROLE\tENABLED\tNAME");
    for (const value of values)
      io.stdout(
        `${value.id}\t${value.roleId}\t${value.enabled}\t${value.name}`,
      );
    return 0;
  }
  return null;
}

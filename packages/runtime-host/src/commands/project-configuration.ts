import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ProjectConfigurationResolutionError } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
} from "./shared.ts";

export async function handleProjectConfigurationCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command !== "project:configuration:show") return null;
  const parsed = parseArguments(args, new Set(["project"]), new Set(["json"]));
  if (parsed.positionals.length)
    throw new CliUsageError(`${command} only accepts named options`);
  const service = new ReadProjectConfiguration({
    projects: context.projects,
    bindings: context.packBindings,
    definitions: context.definitions,
    transactions: context.transactions,
    catalog: context.installedPacks,
  });
  try {
    const result = await service.read(requiredOption(parsed, "project"));
    context.io.stdout(
      JSON.stringify(
        { ok: true, configuration: result },
        null,
        parsed.flags.has("json") ? 0 : 2,
      ),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ProjectConfigurationResolutionError)) throw error;
    context.io.stdout(
      JSON.stringify(
        {
          ok: false,
          diagnostics: [{ code: error.code, message: error.message }],
        },
        null,
        parsed.flags.has("json") ? 0 : 2,
      ),
    );
    return 1;
  }
}

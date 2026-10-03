import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
} from "./shared.ts";

export async function handleProjectDefinitionCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (
    ![
      "project:definition:show",
      "project:definition:preview",
      "project:definition:apply",
    ].includes(command)
  )
    return null;
  const options =
    command === "project:definition:show"
      ? new Set(["project"])
      : command === "project:definition:preview"
        ? new Set(["project", "mutation"])
        : new Set(["project", "mutation", "expected-revision"]);
  const parsed = parseArguments(args, options, new Set(["json"]));
  if (parsed.positionals.length > 0)
    throw new CliUsageError(`${command} only accepts named options`);
  const service = new ManageProjectDefinitions({
    projects: context.projects,
    definitions: context.definitions,
    bindings: context.packBindings,
    catalog: context.installedPacks,
    auditEvents: context.auditEvents,
    transactions: context.transactions,
    clock: context.clock,
    ids: context.ids,
  });
  const projectId = requiredOption(parsed, "project");
  if (command === "project:definition:show") {
    const result = await service.inspect(projectId);
    context.io.stdout(
      JSON.stringify(result, null, parsed.flags.has("json") ? 0 : 2),
    );
    return result.issues.length === 0 ? 0 : 1;
  }
  let mutation: unknown;
  try {
    mutation = JSON.parse(requiredOption(parsed, "mutation")) as unknown;
  } catch {
    throw new CliUsageError("--mutation must be a JSON object");
  }
  if (command === "project:definition:preview") {
    const result = await service.preview(projectId, mutation);
    context.io.stdout(
      JSON.stringify(result, null, parsed.flags.has("json") ? 0 : 2),
    );
    return result.issues.length === 0 ? 0 : 1;
  }
  const expectedRevision = Number(requiredOption(parsed, "expected-revision"));
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new CliUsageError(
      "--expected-revision must be a nonnegative safe integer",
    );
  const result = await service.apply({
    projectId,
    mutation,
    expectedRevision,
    actorId: context.principal.id,
  });
  context.io.stdout(
    JSON.stringify(result, null, parsed.flags.has("json") ? 0 : 2),
  );
  return 0;
}

import { GetPlanningSnapshot } from "@ai-office/application/coordination/get-planning-snapshot.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

/** Plain decimal text only; `1e3`, `0x10`, `-1` and whitespace are refused. */
function windowOption(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new CliUsageError(`--${name} must be a non-negative decimal integer`);
  return Number(value);
}

/**
 * Read-only planning read model (CB-02). Appends no planning or domain audit;
 * the host still records its per-command envelope, as for every command.
 */
export async function handlePlanningCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command !== "planning:snapshot") return null;
  const parsed = parseArguments(
    args,
    new Set([
      "project",
      "milestone",
      "collection",
      "offset",
      "limit",
      "classes",
    ]),
  );
  if (parsed.positionals.length > 0)
    throw new CliUsageError("planning:snapshot only accepts named options");
  const page = await new GetPlanningSnapshot(context.planningReads).execute({
    projectId: requiredOption(parsed, "project"),
    milestoneId: parsed.options.get("milestone") ?? null,
    collection: parsed.options.get("collection"),
    offset: windowOption("offset", parsed.options.get("offset")),
    limit: windowOption("limit", parsed.options.get("limit")),
    classes: parsed.options.get("classes")?.split(","),
  });
  context.io.stdout(JSON.stringify(page));
  return 0;
}

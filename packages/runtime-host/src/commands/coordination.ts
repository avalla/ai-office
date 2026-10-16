import { GetPlanningSnapshot } from "@ai-office/application/coordination/get-planning-snapshot.ts";
import { CoordinationReadService } from "@ai-office/application/coordination/coordination-read-service.ts";
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
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value))
    throw new CliUsageError(`--${name} must be a non-negative decimal integer`);
  return Number(value);
}

/**
 * Read-only coordination API (CB-10): the same service and response the
 * coordination listener serves. Appends no planning or domain audit; the host
 * still records its per-command envelope, as for every command.
 */
export async function handleCoordinationCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command !== "coordination:read") return null;
  const parsed = parseArguments(
    args,
    new Set([
      "project",
      "operation",
      "milestone",
      "offset",
      "limit",
      "classes",
    ]),
  );
  if (parsed.positionals.length > 0)
    throw new CliUsageError("coordination:read only accepts named options");
  const response = await new CoordinationReadService(
    new GetPlanningSnapshot(context.planningReads),
  ).execute({
    projectId: requiredOption(parsed, "project"),
    operation: requiredOption(parsed, "operation"),
    milestoneId: parsed.options.get("milestone") ?? null,
    offset: windowOption("offset", parsed.options.get("offset")),
    limit: windowOption("limit", parsed.options.get("limit")),
    classes: parsed.options.get("classes")?.split(","),
  });
  context.io.stdout(JSON.stringify(response));
  return 0;
}

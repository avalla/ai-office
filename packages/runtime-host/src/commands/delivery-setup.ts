import { ReadTaskDeliverySetup } from "@ai-office/application/task-delivery-setup/read-task-delivery-setup.ts";
import { WriteTaskDeliverySetup } from "@ai-office/application/task-delivery-setup/write-task-delivery-setup.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
  type ParsedArguments,
} from "./shared.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Selectors of a read: show accepts both, and the service merges
 * project -> run -> task, so a task override can refine its run's.
 */
function showScopeSelection(parsed: ParsedArguments): {
  runId?: string;
  taskId?: string;
} {
  const runId = parsed.options.get("run");
  const taskId = parsed.options.get("task");
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

/**
 * The single scope of a write: set must name at most one, or the target row
 * would be ambiguous.
 */
function setScopeSelection(
  command: string,
  parsed: ParsedArguments,
): { runId?: string; taskId?: string } {
  const runId = parsed.options.get("run");
  const taskId = parsed.options.get("task");
  if (runId !== undefined && taskId !== undefined)
    throw new CliUsageError(`${command} accepts at most one of --run and --task`);
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

function parseJsonValue(command: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliUsageError(
      `${command} --value must be valid JSON (${errorMessage(error)})`,
    );
  }
}

export async function handleDeliverySetupCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command === "delivery:setup:show") {
    const parsed = parseArguments(args, new Set(["project", "run", "task"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError("delivery:setup:show only accepts named options");
    const filter = showScopeSelection(parsed);
    const service = new ReadTaskDeliverySetup({
      projects: context.projects,
      setup: context.taskDeliverySetup,
      transactions: context.transactions,
    });
    const resolved = await service.read(
      requiredOption(parsed, "project"),
      filter,
    );
    context.io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        source: "runtime",
        project: resolved.project,
        overrides: resolved.overrides,
      }),
    );
    return 0;
  }
  if (command === "delivery:setup:set") {
    const parsed = parseArguments(
      args,
      new Set(["project", "run", "task", "key", "value", "actor"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("delivery:setup:set only accepts named options");
    const filter = setScopeSelection(command, parsed);
    const scope = filter.taskId !== undefined ? "task" : filter.runId !== undefined ? "run" : "project";
    const service = new WriteTaskDeliverySetup({
      projects: context.projects,
      setup: context.taskDeliverySetup,
      transactions: context.transactions,
    });
    const result = await service.set(
      {
        projectId: requiredOption(parsed, "project"),
        scope,
        ...(scope === "project"
          ? {}
          : { scopeRef: filter.taskId ?? filter.runId! }),
        key: requiredOption(parsed, "key"),
        value: parseJsonValue(command, requiredOption(parsed, "value")),
        actor: parsed.options.get("actor") ?? context.principal.id,
      },
      context.clock.now(),
    );
    context.io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        key: result.key,
        value: result.value,
        scope: result.scope,
        updatedAt: result.updatedAt.toISOString(),
      }),
    );
    return 0;
  }
  return null;
}

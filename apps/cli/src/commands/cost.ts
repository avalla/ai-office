import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import {
  CliUsageError,
  type CommandContext,
  currency,
  nonNegativeBigInt,
  parseArguments,
  requiredOption,
} from "./shared.ts";

export async function handleCostCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const { costs, projects, ids, clock, io } = context;
  if (command === "pricing:set") {
    const parsed = parseArguments(
      args,
      new Set([
        "provider",
        "model",
        "currency",
        "input",
        "cached-input",
        "output",
        "reasoning",
      ]),
    );
    const now = clock.now();
    const id = ids.generate();
    await costs.savePricing(
      {
        id,
        provider: requiredOption(parsed, "provider"),
        model: requiredOption(parsed, "model"),
        currency: currency(requiredOption(parsed, "currency")),
        inputPerMillionMicros: nonNegativeBigInt(
          requiredOption(parsed, "input"),
          "input",
        ),
        cachedInputPerMillionMicros: nonNegativeBigInt(
          requiredOption(parsed, "cached-input"),
          "cached-input",
        ),
        outputPerMillionMicros: nonNegativeBigInt(
          requiredOption(parsed, "output"),
          "output",
        ),
        reasoningPerMillionMicros: nonNegativeBigInt(
          requiredOption(parsed, "reasoning"),
          "reasoning",
        ),
        effectiveFrom: now,
      },
      now,
    );
    io.stdout(`Pricing version saved: ${id}`);
    return 0;
  }
  if (command === "budget:set") {
    const parsed = parseArguments(
      args,
      new Set(["project", "limit", "currency"]),
    );
    const projectId = requiredOption(parsed, "project");
    if ((await projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
    const now = clock.now();
    const id = ids.generate();
    await costs.saveBudget(
      {
        id,
        projectId,
        scopeType: "project",
        scopeId: projectId,
        limitMicros: nonNegativeBigInt(
          requiredOption(parsed, "limit"),
          "limit",
        ),
        currency: currency(parsed.options.get("currency") ?? "USD"),
      },
      now,
    );
    io.stdout(`Budget saved: ${id}`);
    return 0;
  }
  if (command === "cost:list") {
    const parsed = parseArguments(args, new Set(["project", "group-by"]));
    const group = parsed.options.get("group-by") ?? "project";
    if (!["project", "task", "agent", "agent_run"].includes(group))
      throw new CliUsageError(
        "Group must be project, task, agent, or agent_run",
      );
    const values = await costs.aggregate(
      requiredOption(parsed, "project"),
      group as "project" | "task" | "agent" | "agent_run",
    );
    if (values.length === 0) {
      io.stdout("No cost events found.");
      return 0;
    }
    io.stdout("DIMENSION\tACTUAL_MICROS\tCURRENCY");
    for (const value of values)
      io.stdout(`${value.dimension}\t${value.actualMicros}\t${value.currency}`);
    return 0;
  }
  return null;
}

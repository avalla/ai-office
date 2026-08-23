import { ManageGlobalMemory } from "@ai-office/application/memory/manage-global-memory.ts";
import type { GlobalRoleDefinition } from "@ai-office/domain/memory/global-role.ts";
import type { MemoryTargetType } from "@ai-office/domain/memory/memory-reference.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new CliUsageError(`Option --${name} must be a positive integer`);
  return parsed;
}

function confidence(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    throw new CliUsageError("Option --confidence must be between 0 and 1");
  return parsed;
}

function csv(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((item) => item.trim());
}

function memoryService(context: CommandContext): ManageGlobalMemory {
  if (context.memory === undefined)
    throw new Error("Global memory is not configured for this command");
  return new ManageGlobalMemory(
    context.memory,
    context.memoryReferences,
    context.projects,
    context.tasks,
    context.ids,
    context.clock,
  );
}

export async function handleMemoryCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (!command.startsWith("memory:")) return null;
  const service = memoryService(context);

  if (command === "memory:role:create") {
    const parsed = parseArguments(
      args,
      new Set([
        "name",
        "key",
        "version",
        "description",
        "responsibilities",
        "capabilities",
        "tools",
        "model-policy",
        "max-iterations",
        "max-cost",
        "timeout",
      ]),
    );
    const definition: GlobalRoleDefinition = {
      key: requiredOption(parsed, "key"),
      description: parsed.options.get("description") ?? "",
      responsibilities: csv(parsed.options.get("responsibilities")),
      capabilities: csv(parsed.options.get("capabilities")),
      tools: csv(parsed.options.get("tools")),
      modelPolicy: requiredOption(parsed, "model-policy"),
      limits: {
        maxIterations: positiveInteger(
          requiredOption(parsed, "max-iterations"),
          "max-iterations",
        ),
        maxCostMicros: requiredOption(parsed, "max-cost"),
        timeoutSeconds: positiveInteger(
          requiredOption(parsed, "timeout"),
          "timeout",
        ),
      },
    };
    const id = await service.createRole({
      name: requiredOption(parsed, "name"),
      version: positiveInteger(requiredOption(parsed, "version"), "version"),
      definition,
    });
    context.io.stdout(`Global role saved: ${id}`);
    return 0;
  }

  if (command === "memory:pattern:create") {
    const parsed = parseArguments(
      args,
      new Set([
        "id",
        "name",
        "version",
        "problem",
        "context",
        "solution",
        "applicability",
        "constraints",
        "risks",
        "source-project",
      ]),
    );
    const id = await service.createPattern({
      ...(parsed.options.get("id") === undefined
        ? {}
        : { id: parsed.options.get("id")! }),
      name: requiredOption(parsed, "name"),
      version: positiveInteger(requiredOption(parsed, "version"), "version"),
      problem: requiredOption(parsed, "problem"),
      context: requiredOption(parsed, "context"),
      solution: requiredOption(parsed, "solution"),
      applicability: csv(parsed.options.get("applicability")),
      constraints: csv(parsed.options.get("constraints")),
      risks: csv(parsed.options.get("risks")),
      ...(parsed.options.get("source-project") === undefined
        ? {}
        : { sourceProjectId: parsed.options.get("source-project")! }),
    });
    context.io.stdout(`Global pattern saved: ${id}`);
    return 0;
  }

  if (command === "memory:lesson:create") {
    const parsed = parseArguments(
      args,
      new Set([
        "source-project",
        "source-task",
        "title",
        "content",
        "confidence",
      ]),
    );
    const id = await service.extractLesson({
      ...(parsed.options.get("source-project") === undefined
        ? {}
        : { sourceProjectId: parsed.options.get("source-project")! }),
      ...(parsed.options.get("source-task") === undefined
        ? {}
        : { sourceTaskId: parsed.options.get("source-task")! }),
      title: requiredOption(parsed, "title"),
      content: requiredOption(parsed, "content"),
      confidence: confidence(requiredOption(parsed, "confidence")),
    });
    context.io.stdout(`Global lesson saved: ${id}`);
    return 0;
  }

  if (command === "memory:search") {
    const parsed = parseArguments(
      args,
      new Set(["query", "limit"]),
      new Set(["json"]),
    );
    const results = await service.search({
      query: requiredOption(parsed, "query"),
      limit: positiveInteger(parsed.options.get("limit") ?? "10", "limit"),
    });
    if (parsed.flags.has("json")) {
      context.io.stdout(JSON.stringify({ results }));
      return 0;
    }
    for (const result of results)
      context.io.stdout(
        `${result.type}:${result.id}${result.version === undefined ? "" : `@${result.version}`} ${result.name} (${result.score.toFixed(2)})`,
      );
    return 0;
  }

  if (command === "memory:pattern:adopt") {
    const parsed = parseArguments(
      args,
      new Set(["project", "pattern", "version", "query"]),
    );
    const id = await service.adoptPattern({
      projectId: requiredOption(parsed, "project"),
      patternId: requiredOption(parsed, "pattern"),
      version: positiveInteger(requiredOption(parsed, "version"), "version"),
      ...(parsed.options.get("query") === undefined
        ? {}
        : { query: parsed.options.get("query")! }),
    });
    context.io.stdout(`Pattern adopted: ${id}`);
    return 0;
  }

  if (command === "memory:references") {
    const parsed = parseArguments(
      args,
      new Set(["project"]),
      new Set(["json"]),
    );
    const references = (
      await service.listReferences(requiredOption(parsed, "project"))
    ).map((reference) => reference.snapshot());
    if (parsed.flags.has("json")) {
      context.io.stdout(JSON.stringify({ references }));
      return 0;
    }
    for (const reference of references)
      context.io.stdout(
        `${reference.targetType}:${reference.targetId}${reference.targetVersion === undefined ? "" : `@${reference.targetVersion}`} usages=${reference.usageCount}`,
      );
    return 0;
  }

  if (command === "memory:deprecate") {
    const parsed = parseArguments(args, new Set(["type", "id", "version"]));
    const type = requiredOption(parsed, "type");
    if (type !== "role" && type !== "pattern" && type !== "lesson")
      throw new CliUsageError("Option --type must be role, pattern, or lesson");
    if (type === "pattern" && parsed.options.get("version") === undefined)
      throw new CliUsageError("Pattern deprecation requires --version");
    await service.deprecate({
      type: type as MemoryTargetType,
      id: requiredOption(parsed, "id"),
      ...(parsed.options.get("version") === undefined
        ? {}
        : {
            version: positiveInteger(parsed.options.get("version")!, "version"),
          }),
    });
    context.io.stdout(`Global memory deprecated: ${type}`);
    return 0;
  }

  return null;
}

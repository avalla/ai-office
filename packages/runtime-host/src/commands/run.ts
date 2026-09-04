import { ControlledActionAgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { InvokeControlledConnectorAction } from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { EvaluatePipelineAuthorization } from "@ai-office/application/pipeline/evaluate-pipeline-authorization.ts";
import {
  CliUsageError,
  type CommandContext,
  jsonObject,
  parseArguments,
  requiredOption,
} from "./shared.ts";

function controlledActionExecutor(
  context: CommandContext,
): ControlledActionAgentExecutor {
  const evaluator = new EvaluateActionPolicy(
    context.runtime,
    context.capabilities,
    context.clock,
    context.connectors,
    new EvaluatePipelineAuthorization(context.pipelines),
  );
  const request = new RequestControlledAction(
    evaluator,
    context.capabilities,
    context.audit,
    context.ids,
    context.clock,
    context.transactions,
    context.runtime,
  );
  const invoke = new InvokeControlledConnectorAction(
    request,
    context.capabilities,
    context.audit,
    context.ids,
    context.clock,
    context.transactions,
    context.connectors,
    evaluator,
    context.controlled,
    {},
    context.runtime,
  );
  return new ControlledActionAgentExecutor({
    invoke: async (input) => {
      const result = await invoke.execute({
        agentRunId: input.agentRunId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return {
        requestId: result.requestId,
        outcome: result.outcome,
        status: result.status,
      };
    },
  });
}

export async function handleRunCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const { projects, tasks, runtime, ids, clock, transactions, io } = context;
  if (command === "run:schedule") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "task",
        "agent",
        "resource",
        "operation",
        "arguments",
      ]),
    );
    const hasActionIntent = ["resource", "operation", "arguments"].some(
      (name) => parsed.options.has(name),
    );
    if (
      hasActionIntent &&
      (!parsed.options.has("resource") || !parsed.options.has("operation"))
    )
      throw new CliUsageError(
        "Controlled runs require both --resource and --operation",
      );
    const id = await new ScheduleAgentRun(
      projects,
      tasks,
      runtime,
      ids,
      clock,
      transactions,
      context.pipelines,
    ).execute({
      projectId: requiredOption(parsed, "project"),
      taskId: requiredOption(parsed, "task"),
      agentId: requiredOption(parsed, "agent"),
      ...(hasActionIntent
        ? {
            actionIntent: {
              resourceId: requiredOption(parsed, "resource"),
              operation: requiredOption(parsed, "operation"),
              arguments: jsonObject(
                parsed.options.get("arguments"),
                "arguments",
              ),
            },
          }
        : {}),
    });
    io.stdout(`Agent run scheduled: ${id}`);
    return 0;
  }
  if (command === "run:tick") {
    const parsed = parseArguments(args, new Set(["project", "capacity"]));
    const projectId = requiredOption(parsed, "project");
    const capacity = Number(parsed.options.get("capacity") ?? "1");
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new CliUsageError("Capacity must be a positive integer");
    const queued = await runtime.listQueuedRuns(projectId, capacity);
    const execute = new ExecuteAgentRun(
      runtime,
      controlledActionExecutor(context),
      new InMemoryWorktreeManager(),
      clock,
    );
    const results = await Promise.all(
      queued.map((value) => execute.execute(value)),
    );
    io.stdout(`Agent runs executed: ${queued.length}`);
    for (const result of results) {
      const run = await runtime.findRun(result.runId);
      const value = run?.snapshot().result;
      if (typeof value !== "object" || value === null || Array.isArray(value))
        continue;
      const actions = (value as { actions?: unknown }).actions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        if (typeof action !== "object" || action === null) continue;
        const record = action as Record<string, unknown>;
        if (
          typeof record.requestId === "string" &&
          typeof record.status === "string"
        )
          io.stdout(
            `Run ${result.runId} action: ${record.requestId} (${record.status})`,
          );
      }
    }
    return 0;
  }
  if (command === "run:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    const values = await runtime.listRuns(requiredOption(parsed, "project"));
    if (values.length === 0) {
      io.stdout("No agent runs found.");
      return 0;
    }
    io.stdout("ID\tSTATUS\tTASK\tAGENT");
    for (const value of values) {
      const snapshot = value.snapshot();
      io.stdout(
        `${snapshot.id}\t${snapshot.status}\t${snapshot.taskId}\t${snapshot.agentId}`,
      );
    }
    return 0;
  }
  if (command === "run:show") {
    const parsed = parseArguments(args, new Set(["project", "run"]));
    const projectId = requiredOption(parsed, "project");
    const run = await runtime.findRun(requiredOption(parsed, "run"));
    const snapshot = run?.snapshot();
    if (snapshot === undefined || snapshot.projectId !== projectId)
      throw new CliUsageError("Agent run not found in project");
    io.stdout(`Run: ${snapshot.id}`);
    io.stdout(`Status: ${snapshot.status}`);
    io.stdout(`Task: ${snapshot.taskId}`);
    io.stdout(`Agent: ${snapshot.agentId}`);
    if (snapshot.result !== undefined)
      io.stdout(`Result: ${canonicalStringify(snapshot.result)}`);
    if (snapshot.error !== undefined)
      io.stdout(`Error: ${canonicalStringify(snapshot.error)}`);
    return 0;
  }
  return null;
}

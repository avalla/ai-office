import { ControlledActionAgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { InvokeControlledConnectorAction } from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { AdmitAgentRun } from "@ai-office/application/commands/admit-agent-run.ts";
import { manageAgentRuns } from "./run-services.ts";
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
  if (command === "run:cancel" || command === "run:reconcile") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "run",
        "reason",
        ...(command === "run:reconcile" ? ["approve"] : []),
      ]),
      new Set(["json"]),
    );
    const input = {
      projectId: requiredOption(parsed, "project"),
      runId: requiredOption(parsed, "run"),
      reason: requiredOption(parsed, "reason"),
      actorId: context.principal.id,
    };
    const approve = parsed.options.get("approve");
    const result =
      command === "run:cancel"
        ? await manageAgentRuns(context).cancel(input)
        : await manageAgentRuns(context).reconcile({
            ...input,
            ...(approve === undefined ? {} : { approve }),
          });
    io.stdout(JSON.stringify({ schemaVersion: 1, ...result }));
    return 0;
  }
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
    const parsed = parseArguments(
      args,
      new Set(["project", "capacity"]),
      new Set(["json"]),
    );
    const projectId = requiredOption(parsed, "project");
    const capacity = Number(parsed.options.get("capacity") ?? "1");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100)
      throw new CliUsageError("Capacity must be an integer between 1 and 100");
    const queued = await runtime.listQueuedRuns(projectId, capacity);
    const execute = new ExecuteAgentRun(
      runtime,
      context.agentExecutor ?? controlledActionExecutor(context),
      new InMemoryWorktreeManager(),
      clock,
    );
    const admission = new AdmitAgentRun(
      runtime,
      tasks,
      context.pipelines,
      clock,
      context.executionControl.ownerId,
    );
    const results = (
      await Promise.all(
        queued.map(async (value) => {
          const id = value.snapshot().id;
          const signal = context.executionControl.reserve(
            id,
            value.snapshot().taskId,
          );
          if (signal === null) return null;
          try {
            const claimed = await admission.execute(value);
            if (claimed === null) return null;
            if (claimed.snapshot().status === "cancelled")
              return {
                runId: claimed.snapshot().id,
                status: "cancelled" as const,
                actions: [],
                error: {
                  code: "RUN_NOT_ELIGIBLE",
                  message: "Run authority is no longer eligible",
                },
              };
            return await execute.execute(claimed, signal);
          } finally {
            context.executionControl.release(id);
          }
        }),
      )
    ).filter((value) => value !== null);
    const unsuccessful = results.filter(
      (result) =>
        result.status !== "completed" || result.cleanupError !== undefined,
    ).length;
    if (parsed.flags.has("json"))
      io.stdout(JSON.stringify({ schemaVersion: 1, results, unsuccessful }));
    else {
      io.stdout(`Agent runs executed: ${results.length}`);
      for (const result of results) {
        io.stdout(`Run ${result.runId}: ${result.status}`);
        if (result.error !== undefined)
          io.stderr(
            `${result.runId}: ${result.error.code}: ${result.error.message}`,
          );
        if (result.cleanupError !== undefined)
          io.stderr(
            `${result.runId}: ${result.cleanupError.code}: ${result.cleanupError.message}`,
          );
        for (const action of result.actions)
          io.stdout(
            `Run ${result.runId} action: ${action.requestId} (${action.status})`,
          );
      }
      io.stdout(`Unsuccessful runs: ${unsuccessful}`);
    }
    return unsuccessful === 0 ? 0 : 1;
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

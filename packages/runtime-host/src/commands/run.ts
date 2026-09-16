import {
  ControlledActionAgentExecutor,
  AuthoritativeWorkerAgentExecutor,
  SimulatedAgentExecutor,
  UnconfiguredAgentExecutor,
  type AgentExecutor,
} from "@ai-office/agent-runtime/executor.ts";
import { ClaudeWorkerRuntime } from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import { GatewayWorkerRuntime } from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { WorkerAgentExecutor } from "@ai-office/application/commands/worker-agent-executor.ts";
import { RunContextAssembler } from "@ai-office/application/context/run-context-assembler.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { InvokeControlledConnectorAction } from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { AdmitAgentRun } from "@ai-office/application/commands/admit-agent-run.ts";
import { manageAgentRuns } from "./run-services.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { projectWorkerOutput } from "@ai-office/application/read-models/worker-output.ts";
import { EvaluatePipelineAuthorization } from "@ai-office/application/pipeline/evaluate-pipeline-authorization.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import {
  CliUsageError,
  type CommandContext,
  jsonObject,
  parseArguments,
  requiredOption,
} from "./shared.ts";

/** Role limits recorded on a worker result; malformed evidence is not shown. */
function appliedRoleLimits(result: unknown): {
  maxIterations: number;
  maxCostMicros: string;
  timeoutSeconds: number;
} | null {
  const limits =
    typeof result === "object" && result !== null && "roleLimits" in result
      ? (result as { roleLimits: unknown }).roleLimits
      : null;
  if (typeof limits !== "object" || limits === null) return null;
  const value = limits as Record<string, unknown>;
  return Number.isSafeInteger(value.maxIterations) &&
    Number.isSafeInteger(value.timeoutSeconds) &&
    typeof value.maxCostMicros === "string" &&
    /^\d{1,20}$/.test(value.maxCostMicros)
    ? {
        maxIterations: value.maxIterations as number,
        maxCostMicros: value.maxCostMicros,
        timeoutSeconds: value.timeoutSeconds as number,
      }
    : null;
}

function controlledActionExecutor(
  context: CommandContext,
  fallback?: AgentExecutor,
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
  return new ControlledActionAgentExecutor(
    {
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
    },
    fallback,
    async (run) => {
      const snapshot = run.snapshot();
      const agent = await context.runtime.findAgent(snapshot.agentId);
      const role =
        agent === null
          ? null
          : await context.runtime.findRole(agent.roleId, snapshot.projectId);
      const seconds = role?.snapshot().limits.timeoutSeconds ?? 30;
      return seconds * 1000;
    },
  );
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
      context.modelRouting,
      context.jobOutbox,
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
      new Set(["project", "run", "capacity", "worker", "worker-model"]),
      new Set(["json", "simulate"]),
    );
    const projectOption = parsed.options.get("project");
    const runOption = parsed.options.get("run");
    if (projectOption === undefined && runOption === undefined)
      throw new CliUsageError("run:tick requires --project or --run");
    const capacity = Number(parsed.options.get("capacity") ?? "1");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100)
      throw new CliUsageError("Capacity must be an integer between 1 and 100");
    const selected =
      runOption === undefined ? null : await runtime.findRun(runOption);
    if (runOption !== undefined && selected === null)
      throw new CliUsageError("Agent run not found");
    if (
      selected !== null &&
      projectOption !== undefined &&
      selected.snapshot().projectId !== projectOption
    )
      throw new CliUsageError("Agent run does not belong to project");
    const projectId = projectOption ?? selected!.snapshot().projectId;
    const queued =
      selected === null
        ? await runtime.listQueuedRuns(projectId, capacity)
        : selected.snapshot().status === "queued"
          ? [selected]
          : [];
    const worker = parsed.options.get("worker");
    if (worker !== undefined && worker !== "claude" && worker !== "gateway")
      throw new CliUsageError(
        "Unsupported worker. Available workers: claude, gateway",
      );
    const model = parsed.options.get("worker-model");
    if (parsed.flags.has("simulate") && worker !== undefined)
      throw new CliUsageError("Choose --worker or --simulate");
    if (
      model !== undefined &&
      (worker === undefined ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))
    )
      throw new CliUsageError(
        "--worker-model requires a worker and a valid model name",
      );
    // The gateway worker has no default model: it executes assigned models only.
    if (model !== undefined && worker === "gateway")
      throw new CliUsageError(
        "--worker-model applies only to --worker claude; the gateway worker executes each run's assigned model and accepts no model option. No runs were started.",
      );
    if (
      context.agentExecutor === undefined &&
      worker === undefined &&
      !parsed.flags.has("simulate") &&
      queued.some((run) => run.snapshot().actionIntent === undefined)
    )
      throw new CliUsageError(
        "Queued tasks need a real worker: use --worker claude or --worker gateway, or explicitly use --simulate for a test run. No runs were started.",
      );
    const claude =
      worker === "claude"
        ? new ClaudeWorkerRuntime("claude", undefined, model)
        : undefined;
    const gateway =
      worker === "gateway"
        ? new GatewayWorkerRuntime(
            context.gatewayProviders,
            context.costs,
            ids,
            clock,
          )
        : undefined;
    // Assigned models are checked before any run is admitted, so a batch the
    // worker cannot honor leaves the queue unchanged.
    for (const run of queued) {
      const snapshot = run.snapshot();
      if (snapshot.actionIntent !== undefined) continue;
      const routing = snapshot.modelRouting;
      if (gateway !== undefined) {
        if (routing?.status !== "resolved")
          throw new CliUsageError(
            `Run ${snapshot.id} has no assigned model (${routing === undefined ? "scheduled before model routing" : "unrouted"}); the gateway worker executes only routed runs and never uses an ambient default. No runs were started.`,
          );
        const selection = routing.selection;
        if (!gateway.supportsModel(selection).supported)
          throw new CliUsageError(
            `Run ${snapshot.id} is assigned ${selection.modelRef}, which the gateway worker cannot execute with its assigned parameters. Cancel it with run:cancel or correct model routing before scheduling. No runs were started.`,
          );
        const missing = gateway.missingCredentials(selection);
        if (missing.length > 0)
          throw new CliUsageError(
            `Run ${snapshot.id} is assigned ${selection.modelRef}, but the Runtime host has no usable ${missing.join(", ")}. A managed Runtime reads provider credentials only from the credentials directory in AI_OFFICE_HOME (ai-office credential set); a foreground Runtime reads only its own environment. Credentials are loaded at Runtime start; see model:check. No runs were started.`,
          );
        continue;
      }
      if (claude === undefined || routing?.status !== "resolved") continue;
      const support = claude.supportsModel(routing.selection);
      if (!support.supported)
        throw new CliUsageError(
          support.code === "WORKER_MODEL_CONFLICT"
            ? `Run ${snapshot.id} is assigned ${routing.selection.modelRef}; --worker-model cannot replace an assigned model. No runs were started.`
            : `Run ${snapshot.id} is assigned ${routing.selection.modelRef}, which the claude worker cannot execute with its assigned parameters. Cancel it with run:cancel or correct model routing before scheduling. No runs were started.`,
        );
    }
    const realWorker = claude ?? gateway;
    const selectedExecutor: AgentExecutor =
      realWorker !== undefined
        ? new WorkerAgentExecutor(
            realWorker,
            runtime,
            tasks,
            context.pipelines,
            clock,
            new RunContextAssembler({
              clock,
              ...(context.memory === undefined
                ? {}
                : { globalMemory: context.memory }),
              projectMemory: {
                provider: context.projectMemory,
                identities: context.repositoryIdentities,
                provenance: context.projectMemoryProvenance,
              },
            }),
          )
        : parsed.flags.has("simulate")
          ? new SimulatedAgentExecutor()
          : context.agentExecutor === undefined
            ? new UnconfiguredAgentExecutor()
            : new AuthoritativeWorkerAgentExecutor(context.agentExecutor);
    const execute = new ExecuteAgentRun(
      runtime,
      controlledActionExecutor(context, selectedExecutor),
      new InMemoryWorktreeManager(),
      clock,
      context.onRunChanged,
    );
    const admission = new AdmitAgentRun(
      runtime,
      tasks,
      context.pipelines,
      clock,
      context.executionControl.ownerId,
    );
    const pipelineManager = new ManagePipelineRuns(
      context.officeManifests,
      context.pipelines,
      tasks,
      runtime,
      context.audit,
      ids,
      clock,
      transactions,
      context.jobOutbox,
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
            const result = await execute.execute(claimed, signal);
            if (
              result.status === "completed" &&
              claimed.snapshot().pipelineRunId !== undefined
            )
              await pipelineManager.completeStageFromAgentRun({
                projectId: claimed.snapshot().projectId,
                agentRunId: claimed.snapshot().id,
                ...(claimed.snapshot().pipelineRunId === undefined
                  ? {}
                  : {
                      expectedPipelineRunId: claimed.snapshot().pipelineRunId,
                    }),
              });
            return result;
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
    const parsed = parseArguments(
      args,
      new Set(["project", "run"]),
      new Set(["json"]),
    );
    const projectId = requiredOption(parsed, "project");
    const run = await runtime.findRun(requiredOption(parsed, "run"));
    const snapshot = run?.snapshot();
    if (snapshot === undefined || snapshot.projectId !== projectId)
      throw new CliUsageError("Agent run not found in project");
    const routing = snapshot.modelRouting;
    const workerOutput = projectWorkerOutput(snapshot.result);
    const roleLimits = appliedRoleLimits(snapshot.result);
    if (parsed.flags.has("json")) {
      io.stdout(
        JSON.stringify({
          schemaVersion: 1,
          run: {
            id: snapshot.id,
            projectId: snapshot.projectId,
            taskId: snapshot.taskId,
            agentId: snapshot.agentId,
            pipelineRunId: snapshot.pipelineRunId ?? null,
            status: snapshot.status,
            createdAt: snapshot.createdAt.toISOString(),
            startedAt: snapshot.startedAt?.toISOString() ?? null,
            completedAt: snapshot.completedAt?.toISOString() ?? null,
          },
          execution: snapshot.execution ?? null,
          model: {
            status: routing?.status ?? "not_recorded",
            selection:
              routing?.status === "resolved" ? routing.selection : null,
          },
          usage:
            workerOutput === null
              ? null
              : {
                  reportedModel: workerOutput.model,
                  tokens: workerOutput.usage,
                  // Client-reported estimate; never derived for gateway runs.
                  estimatedCostUsd: workerOutput.estimatedCostUsd,
                  // Gateway-recorded cost evidence; absent for client-login workers.
                  metering: workerOutput.metering ?? null,
                },
          roleLimits,
          error: snapshot.error ?? null,
        }),
      );
      return 0;
    }
    io.stdout(`Run: ${snapshot.id}`);
    io.stdout(`Status: ${snapshot.status}`);
    io.stdout(`Task: ${snapshot.taskId}`);
    io.stdout(`Agent: ${snapshot.agentId}`);
    io.stdout(
      `Executor: ${snapshot.execution === undefined ? "not recorded" : `${snapshot.execution.kind} (${snapshot.execution.adapterId} ${snapshot.execution.adapterVersion})`}`,
    );
    if (routing === undefined)
      io.stdout("Model: not recorded (scheduled before model routing)");
    else if (routing.status === "unrouted")
      io.stdout(
        "Model: unrouted (no model routing was configured at scheduling; the executor used its own default)",
      );
    else {
      const selection = routing.selection;
      io.stdout(
        `Model: ${selection.modelRef} (policy ${selection.policy}; profile ${selection.profile ?? "-"}; source ${selection.source}; provider ${selection.providerId})`,
      );
      if (
        selection.reasoningEffort !== null ||
        selection.maxOutputTokens !== null
      )
        io.stdout(
          `  Execution parameters: reasoning effort ${selection.reasoningEffort ?? "-"}; max output tokens ${selection.maxOutputTokens ?? "-"}`,
        );
    }
    const metering = workerOutput?.metering;
    if (workerOutput !== null && metering === undefined)
      io.stdout(
        `Usage: reported model ${workerOutput.model ?? "not reported"}; tokens ${workerOutput.usage === null ? "unknown" : `${workerOutput.usage.inputTokens} input / ${workerOutput.usage.outputTokens} output`}; estimated cost ${workerOutput.estimatedCostUsd === null ? "unknown" : `USD ${workerOutput.estimatedCostUsd}`}`,
      );
    if (metering !== undefined) {
      io.stdout(
        `Usage: actual ${metering.providerId}:${metering.model}; tokens ${metering.usage.inputTokens} input (${metering.usage.cachedInputTokens} cached) / ${metering.usage.outputTokens} output (${metering.usage.reasoningTokens} reasoning); max output tokens ${metering.appliedParameters.maxOutputTokens}`,
      );
      io.stdout(
        `Metered cost: actual ${metering.actualMicros} ${metering.currency} micros; estimate ${metering.estimatedMicros}; reserved ${metering.reservedMicros}; run budget ${metering.budgetLimitMicros} (gateway pricing ${metering.pricingVersionId})`,
      );
    }
    if (roleLimits !== null)
      io.stdout(
        `Budget: role max cost ${roleLimits.maxCostMicros} micros; ${roleLimits.maxIterations} iterations; ${roleLimits.timeoutSeconds}s timeout`,
      );
    const retrieval = await context.projectMemoryProvenance.findRetrieval(
      snapshot.id,
    );
    if (retrieval !== null) {
      io.stdout(
        `Project memory: ${retrieval.outcome}${retrieval.errorCode === null ? "" : ` (${retrieval.errorCode})`} via ${retrieval.provider}; ${retrieval.injectedCount}/${retrieval.resultCount} injected; advisory context, not authority`,
      );
      if (retrieval.contextQuerySha256 !== null)
        io.stdout(
          `  Query SHA-256: context ${retrieval.contextQuerySha256}; provider ${retrieval.providerQuerySha256 ?? "not reported"}`,
        );
      for (const reference of retrieval.references)
        io.stdout(
          `  ${reference.rank}. ${reference.injected ? "injected" : "not injected"}${reference.truncated ? " (truncated)" : ""} ${reference.scope}:${reference.referenceId}${reference.contentDigest === null ? "" : ` ${reference.contentDigest}`}`,
        );
    }
    if (snapshot.result !== undefined)
      io.stdout(`Result: ${canonicalStringify(snapshot.result)}`);
    if (snapshot.error !== undefined)
      io.stdout(`Error: ${canonicalStringify(snapshot.error)}`);
    return 0;
  }
  return null;
}

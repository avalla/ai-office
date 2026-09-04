import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import type { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";
import { PipelineActorUnauthorizedError } from "@ai-office/application/pipeline-errors.ts";

function operatorPrincipal(context: CommandContext) {
  if (context.principal === undefined)
    throw new PipelineActorUnauthorizedError("administration");
  return context.principal;
}

function service(context: CommandContext): ManagePipelineRuns {
  return new ManagePipelineRuns(
    context.officeManifests,
    context.pipelines,
    context.tasks,
    context.runtime,
    context.audit,
    context.ids,
    context.clock,
    context.transactions,
  );
}

function json(run: PipelineRun): string {
  const value = run.snapshot();
  return JSON.stringify({
    ...value,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    ...(value.completedAt === undefined
      ? {}
      : { completedAt: value.completedAt.toISOString() }),
    ...(value.cancelledAt === undefined
      ? {}
      : { cancelledAt: value.cancelledAt.toISOString() }),
    stages: value.stages.map((stage) => ({
      ...stage,
      ...(stage.assignedAt === undefined
        ? {}
        : { assignedAt: stage.assignedAt.toISOString() }),
      ...(stage.completedAt === undefined
        ? {}
        : { completedAt: stage.completedAt.toISOString() }),
      ...(stage.approvedAt === undefined
        ? {}
        : { approvedAt: stage.approvedAt.toISOString() }),
    })),
  });
}

function label(parsed: ReturnType<typeof parseArguments>): string | undefined {
  const actor = parsed.options.get("actor");
  const actorLabel = parsed.options.get("actor-label");
  if (actor !== undefined && actorLabel !== undefined)
    throw new CliUsageError("Use only one of --actor or --actor-label");
  return actorLabel ?? actor;
}

function labelOption(
  parsed: ReturnType<typeof parseArguments>,
): { actorLabel: string } | Record<string, never> {
  const value = label(parsed);
  return value === undefined ? {} : { actorLabel: value };
}

export async function handlePipelineCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const manager = service(context);
  if (command === "pipeline:start") {
    const parsed = parseArguments(
      args,
      new Set(["project", "task", "pipeline", "actor", "actor-label"]),
    );
    const run = await manager.start({
      projectId: requiredOption(parsed, "project"),
      taskId: requiredOption(parsed, "task"),
      pipelineId: requiredOption(parsed, "pipeline"),
      principal: operatorPrincipal(context),
      ...labelOption(parsed),
    });
    context.io.stdout(json(run));
    return 0;
  }
  if (command === "pipeline:status") {
    const parsed = parseArguments(args, new Set(["project", "run"]));
    const projectId = requiredOption(parsed, "project");
    const runId = parsed.options.get("run");
    if (runId !== undefined) {
      context.io.stdout(json(await manager.show(projectId, runId)));
      return 0;
    }
    const revision = await context.officeManifests.findLatest(projectId);
    const runs = await manager.list(projectId);
    context.io.stdout(
      JSON.stringify({
        configured:
          revision?.manifest.pipelines.map((pipeline) => ({
            id: pipeline.id,
            mode: pipeline.enforcement ?? "guidance",
          })) ?? [],
        active: runs
          .filter((run) => run.snapshot().status === "active")
          .map((run) => JSON.parse(json(run)) as unknown),
        historicalCount: runs.length,
      }),
    );
    return 0;
  }
  if (command === "pipeline:assign") {
    const parsed = parseArguments(
      args,
      new Set(["project", "run", "agent", "actor", "actor-label"]),
    );
    const run = await manager.assign({
      projectId: requiredOption(parsed, "project"),
      pipelineRunId: requiredOption(parsed, "run"),
      agentId: requiredOption(parsed, "agent"),
      principal: operatorPrincipal(context),
      ...labelOption(parsed),
    });
    context.io.stdout(json(run));
    return 0;
  }
  if (command === "pipeline:transition") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "run",
        "event",
        "actor",
        "actor-label",
        "agent-run",
        "rationale",
      ]),
    );
    const event = requiredOption(parsed, "event");
    const projectId = requiredOption(parsed, "project");
    const runId = parsed.options.get("run");
    let run: PipelineRun;
    if (event === "complete") {
      if (parsed.options.has("actor") || parsed.options.has("actor-label"))
        throw new CliUsageError(
          "Agent stage completion requires --agent-run and does not accept an actor label",
        );
      run = await manager.completeStageFromAgentRun({
        projectId,
        agentRunId: requiredOption(parsed, "agent-run"),
        ...(runId === undefined ? {} : { expectedPipelineRunId: runId }),
      });
    } else if (event === "approve")
      run = await manager.approveStage({
        projectId,
        pipelineRunId: requiredOption(parsed, "run"),
        principal: operatorPrincipal(context),
        ...labelOption(parsed),
        ...(parsed.options.get("rationale") === undefined
          ? {}
          : { rationale: parsed.options.get("rationale")! }),
      });
    else if (event === "reject")
      run = await manager.rejectStage({
        projectId,
        pipelineRunId: requiredOption(parsed, "run"),
        principal: operatorPrincipal(context),
        ...labelOption(parsed),
        rationale: requiredOption(parsed, "rationale"),
      });
    else if (event === "cancel")
      run = await manager.cancel({
        projectId,
        pipelineRunId: requiredOption(parsed, "run"),
        principal: operatorPrincipal(context),
        ...labelOption(parsed),
      });
    else
      throw new CliUsageError(
        "Pipeline event must be complete, approve, reject, or cancel",
      );
    context.io.stdout(json(run));
    return 0;
  }
  if (command === "pipeline:override") {
    const parsed = parseArguments(
      args,
      new Set(["project", "run", "actor", "actor-label", "reason"]),
    );
    const result = await manager.override({
      projectId: requiredOption(parsed, "project"),
      pipelineRunId: requiredOption(parsed, "run"),
      principal: operatorPrincipal(context),
      ...labelOption(parsed),
      reason: requiredOption(parsed, "reason"),
    });
    context.io.stdout(
      JSON.stringify({
        run: JSON.parse(json(result.run)) as unknown,
        override: {
          ...result.override,
          createdAt: result.override.createdAt.toISOString(),
        },
      }),
    );
    return 0;
  }
  return null;
}

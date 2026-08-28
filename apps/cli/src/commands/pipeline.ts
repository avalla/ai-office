import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import type { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

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

export async function handlePipelineCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const manager = service(context);
  if (command === "pipeline:start") {
    const parsed = parseArguments(
      args,
      new Set(["project", "task", "pipeline", "actor"]),
    );
    const run = await manager.start({
      projectId: requiredOption(parsed, "project"),
      taskId: requiredOption(parsed, "task"),
      pipelineId: requiredOption(parsed, "pipeline"),
      actor: { type: "user", id: requiredOption(parsed, "actor") },
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
      new Set(["project", "run", "agent", "actor"]),
    );
    const run = await manager.assign({
      projectId: requiredOption(parsed, "project"),
      pipelineRunId: requiredOption(parsed, "run"),
      agentId: requiredOption(parsed, "agent"),
      actor: { type: "user", id: requiredOption(parsed, "actor") },
    });
    context.io.stdout(json(run));
    return 0;
  }
  if (command === "pipeline:transition") {
    const parsed = parseArguments(
      args,
      new Set(["project", "run", "event", "actor", "rationale"]),
    );
    const event = requiredOption(parsed, "event");
    const common = {
      projectId: requiredOption(parsed, "project"),
      pipelineRunId: requiredOption(parsed, "run"),
    };
    const actor = requiredOption(parsed, "actor");
    let run: PipelineRun;
    if (event === "complete")
      run = await manager.completeStage({
        ...common,
        actor: { type: "agent", id: actor },
      });
    else if (event === "approve")
      run = await manager.approveStage({
        ...common,
        actor: { type: "user", id: actor },
        ...(parsed.options.get("rationale") === undefined
          ? {}
          : { rationale: parsed.options.get("rationale")! }),
      });
    else if (event === "reject")
      run = await manager.rejectStage({
        ...common,
        actor: { type: "user", id: actor },
        rationale: requiredOption(parsed, "rationale"),
      });
    else if (event === "cancel")
      run = await manager.cancel({
        ...common,
        actor: { type: "user", id: actor },
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
      new Set(["project", "run", "actor", "reason"]),
    );
    const result = await manager.override({
      projectId: requiredOption(parsed, "project"),
      pipelineRunId: requiredOption(parsed, "run"),
      actor: { type: "user", id: requiredOption(parsed, "actor") },
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

import {
  DistributionUpdateApprovalError,
  ManageDistributionUpdate,
  type DistributionUpdatePlan,
} from "@ai-office/application/runtime/manage-distribution-update.ts";
import type {
  DistributionUpdateAdapter,
  DistributionUpdateResult,
  DistributionUpdateStep,
} from "@ai-office/application/ports/distribution-update-adapter.port.ts";
import { DaemonUnavailableError } from "./daemon-client.ts";
import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "./commands/shared.ts";
import {
  LocalDistributionUpdateAdapter,
  LocalDistributionUpdateError,
} from "./local-distribution-update-adapter.ts";

export interface DistributionUpdateCliOptions {
  distributionRoot: string;
  daemonClient: { health(): Promise<unknown> };
  io: CommandIo;
  adapter?: DistributionUpdateAdapter;
}

function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}

function stepLabel(step: DistributionUpdateStep): string {
  switch (step) {
    case "fetch":
      return "fetch approved source";
    case "fast_forward":
      return "fast-forward program checkout";
    case "install_dependencies":
      return "install frozen dependencies";
    case "register_link":
      return "refresh ai-office executable link";
  }
}

const preservedLabels = {
  runtime_state: "authoritative runtime state",
  global_memory: "global reusable memory",
  project_bindings: "repository project bindings",
} as const;

function printPlan(plan: DistributionUpdatePlan, io: CommandIo): void {
  io.stdout("AI Office update");
  io.stdout("");
  io.stdout("Installation");
  io.stdout(`  root: ${plan.distributionRoot}`);
  io.stdout(`  branch: ${plan.branch}`);
  io.stdout(`  upstream: ${plan.upstream.remote}:${plan.upstream.sourceRef}`);
  io.stdout(`  current: ${shortRevision(plan.currentRevision)}`);
  io.stdout(`  target: ${shortRevision(plan.targetRevision)}`);
  io.stdout("");
  if (!plan.updateAvailable) {
    io.stdout("Status: already current");
    return;
  }
  io.stdout("Will perform");
  for (const step of plan.steps) io.stdout(`  ${stepLabel(step)}`);
  io.stdout("");
  io.stdout("Preserves");
  for (const preserved of plan.preserves)
    io.stdout(`  ${preservedLabels[preserved]}`);
  io.stdout("");
  io.stdout("Apply this exact plan:");
  io.stdout(`  ai-office update --approve ${plan.planHash}`);
}

function printResult(result: DistributionUpdateResult, io: CommandIo): void {
  const output =
    result.status === "failed" || result.status === "partial"
      ? io.stderr
      : io.stdout;
  output(result.message);
  output(`Installation: ${result.distributionRoot}`);
  output(
    `Revision: ${shortRevision(result.fromRevision)} -> ${shortRevision(result.toRevision)}`,
  );
  if (result.completedSteps.length > 0)
    output(`Completed: ${result.completedSteps.map(stepLabel).join(", ")}`);
  if (result.failedStep !== undefined)
    output(`Failed step: ${stepLabel(result.failedStep)}`);
  output(`Status: ${result.status}`);
}

export async function runDistributionUpdateCli(
  args: string[],
  options: DistributionUpdateCliOptions,
): Promise<number> {
  let json = args.includes("--json");
  try {
    const parsed = parseArguments(
      args,
      new Set(["approve"]),
      new Set(["json"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("update only accepts named options");
    json = parsed.flags.has("json");

    try {
      await options.daemonClient.health();
      const message =
        "AI Office update requires the daemon to be stopped so program and daemon versions cannot diverge";
      if (json)
        options.io.stdout(
          JSON.stringify({
            contractVersion: 1,
            status: "failed",
            error: { code: "daemon_running", message },
          }),
        );
      else options.io.stderr(message);
      return 1;
    } catch (error) {
      if (!(error instanceof DaemonUnavailableError)) throw error;
    }

    const service = new ManageDistributionUpdate(
      options.adapter ?? new LocalDistributionUpdateAdapter(),
    );
    const approvedPlanHash = parsed.options.get("approve");
    if (approvedPlanHash === undefined) {
      const plan = await service.plan(options.distributionRoot);
      if (json) options.io.stdout(JSON.stringify(plan));
      else printPlan(plan, options.io);
      return 0;
    }

    const result = await service.apply({
      distributionRoot: options.distributionRoot,
      approvedPlanHash,
    });
    if (json) options.io.stdout(JSON.stringify(result));
    else printResult(result, options.io);
    return result.status === "updated" || result.status === "already_current"
      ? 0
      : 1;
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof DistributionUpdateApprovalError ||
      error instanceof LocalDistributionUpdateError
    ) {
      if (json)
        options.io.stdout(
          JSON.stringify({
            contractVersion: 1,
            status: "failed",
            error: {
              code:
                error instanceof CliUsageError
                  ? "invalid_arguments"
                  : error instanceof DistributionUpdateApprovalError
                    ? "stale_plan"
                    : "precondition_failed",
              message: error.message,
            },
          }),
        );
      else options.io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}

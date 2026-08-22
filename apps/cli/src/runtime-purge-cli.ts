import {
  ManageRuntimePurge,
  RuntimePurgeApprovalError,
} from "@ai-office/application/runtime/manage-runtime-purge.ts";
import type { RuntimePurgeAdapter } from "@ai-office/application/ports/runtime-purge-adapter.port.ts";
import { DaemonClient, DaemonUnavailableError } from "./daemon-client.ts";
import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "./commands/shared.ts";
import {
  LocalRuntimePurgeAdapter,
  LocalRuntimePurgeError,
} from "./local-runtime-purge-adapter.ts";

export interface RuntimePurgeCliOptions {
  runtimeRoot: string;
  daemonClient: Pick<DaemonClient, "health">;
  io: CommandIo;
  adapter?: RuntimePurgeAdapter;
}

export async function runRuntimePurgeCli(
  args: string[],
  options: RuntimePurgeCliOptions,
): Promise<number> {
  try {
    try {
      await options.daemonClient.health();
      options.io.stderr(
        "Runtime purge requires the AI Office daemon to be stopped",
      );
      return 1;
    } catch (error) {
      if (!(error instanceof DaemonUnavailableError)) throw error;
    }

    const parsed = parseArguments(args, new Set(["approve"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError("runtime:purge only accepts named options");

    const service = new ManageRuntimePurge(
      options.adapter ?? new LocalRuntimePurgeAdapter(),
    );
    const approvedPlanHash = parsed.options.get("approve");
    if (approvedPlanHash === undefined) {
      options.io.stdout(
        JSON.stringify(await service.plan(options.runtimeRoot)),
      );
      return 0;
    }

    const result = await service.apply({
      runtimeRoot: options.runtimeRoot,
      approvedPlanHash,
    });
    options.io.stdout(JSON.stringify({ purged: true, ...result }));
    return 0;
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof RuntimePurgeApprovalError ||
      error instanceof LocalRuntimePurgeError
    ) {
      options.io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}

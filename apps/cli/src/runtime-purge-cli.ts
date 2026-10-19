import { createConnection } from "node:net";
import { join } from "node:path";
import {
  ManageRuntimePurge,
  RuntimePurgeApprovalError,
} from "@ai-office/application/runtime/manage-runtime-purge.ts";
import type { RuntimePurgeAdapter } from "@ai-office/application/ports/runtime-purge-adapter.port.ts";
import { RuntimeUnavailableError } from "./daemon-client.ts";
import type { RuntimeClient } from "@ai-office/application/runtime/runtime-client.port.ts";
import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "@ai-office/command-support/arguments.ts";
import {
  LocalRuntimePurgeAdapter,
  LocalRuntimePurgeError,
} from "./local-runtime-purge-adapter.ts";

export interface RuntimePurgeCliOptions {
  runtimeRoot: string;
  daemonClient: Pick<RuntimeClient, "health">;
  io: CommandIo;
  adapter?: RuntimePurgeAdapter;
}

/**
 * `absent`: no socket file or nothing listening (refused). `present`: a
 * connection was accepted, or the result was inconclusive.
 */
async function probeLocalSocket(path: string): Promise<"absent" | "present"> {
  return new Promise((resolve) => {
    const connection = createConnection(path);
    const settle = (value: "absent" | "present") => {
      clearTimeout(timer);
      connection.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => settle("present"), 500);
    connection.once("connect", () => settle("present"));
    connection.once("error", (error: NodeJS.ErrnoException) =>
      settle(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? "absent"
          : "present",
      ),
    );
  });
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
      if (!(error instanceof RuntimeUnavailableError)) throw error;
    }
    // A host whose main socket is gone can still be running and serving the
    // coordination listener; only an absent or refusing socket is safe.
    if (
      (await probeLocalSocket(
        join(options.runtimeRoot, "coordination.sock"),
      )) !== "absent"
    ) {
      options.io.stderr(
        "Runtime purge requires the AI Office daemon to be stopped; its coordination listener socket is still accepting connections or could not be checked",
      );
      return 1;
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

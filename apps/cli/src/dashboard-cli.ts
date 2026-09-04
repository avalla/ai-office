/**
 * `ai-office dashboard`.
 *
 * Lifecycle semantics match the rest of the CLI: the daemon is never started
 * implicitly. The command checks daemon health first and reports the same
 * actionable error as any other daemon-backed command when it is stopped.
 * It then runs a foreground loopback host — like `ai-office daemon`, it holds
 * the terminal and stops on Ctrl-C — so the TCP port never outlives the
 * command that opened it.
 */

import {
  startDashboardHost,
  DashboardHostError,
} from "../../dashboard/src/dashboard-host.ts";
import { IpcRuntimeClient, RuntimeUnavailableError } from "./daemon-client.ts";
import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "@ai-office/runtime-host/commands/shared.ts";

/** Default loopback port for the dashboard host. */
export const dashboardDefaultPort = 4278;

export interface DashboardCliOptions {
  socketPath: string;
  io: CommandIo;
  /** Aborting returns the command; used by tests and by SIGINT. */
  signal?: AbortSignal;
  openBrowser?: (url: string) => Promise<void>;
}

/**
 * Opens the default browser without ever failing the command.
 *
 * Portability is delegated to the platform opener; a missing or failing opener
 * is reported as a note, because the URL is printed either way.
 */
async function openWithPlatformBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`Browser opener exited with ${status}`);
}

export async function runDashboardCli(
  args: string[],
  options: DashboardCliOptions,
): Promise<number> {
  const parsed = parseArguments(
    args,
    new Set(["port", "host"]),
    new Set(["no-open"]),
  );
  if (parsed.positionals.length > 0)
    throw new CliUsageError("dashboard only accepts named options");

  const portValue = parsed.options.get("port");
  const port =
    portValue === undefined ? dashboardDefaultPort : Number(portValue);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new CliUsageError("Port must be an integer between 0 and 65535");

  try {
    await new IpcRuntimeClient(options.socketPath).health();
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) {
      options.io.stderr(error.message);
      return 1;
    }
    throw error;
  }

  let host: Awaited<ReturnType<typeof startDashboardHost>>;
  try {
    host = await startDashboardHost({
      socketPath: options.socketPath,
      port,
      ...(parsed.options.get("host") === undefined
        ? {}
        : { hostname: parsed.options.get("host")! }),
    });
  } catch (error) {
    if (error instanceof DashboardHostError) {
      options.io.stderr(error.message);
      return 1;
    }
    if (error instanceof Error && /EADDRINUSE/.test(error.message)) {
      options.io.stderr(
        `Port ${port} is already in use. Choose another with --port.`,
      );
      return 1;
    }
    throw error;
  }

  const url = `${host.url}?token=${host.token}`;
  options.io.stdout("AI Office dashboard");
  options.io.stdout(url);
  options.io.stdout(
    "Read-only. Local same-user surface; the link carries this session's token.",
  );

  if (!parsed.flags.has("no-open")) {
    try {
      await (options.openBrowser ?? openWithPlatformBrowser)(url);
    } catch {
      // Never fatal: the URL above is the contract, the browser is a courtesy.
      options.io.stdout("Could not open a browser automatically.");
    }
  }

  try {
    await new Promise<void>((resolve) => {
      if (options.signal === undefined) {
        const stop = () => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return;
      }
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    await host.stop();
  }
  return 0;
}

import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "@ai-office/command-support/arguments.ts";
import {
  buildVersionReport,
  displayVersion,
  productVersion,
  renderVersionReport,
  type DistributionIdentity,
} from "@ai-office/command-support/version.ts";
import {
  inspectSourceIdentity,
  inspectSourceRevision,
  type DistributionCommandRunner,
} from "./distribution-source-identity.ts";

export interface VersionCliOptions {
  /**
   * Authoritative distribution root derived from the executable, never from
   * the working directory. Without one the identity is simply unavailable.
   */
  distributionRoot?: string;
  io: CommandIo;
  runner?: DistributionCommandRunner;
}

const unavailable: DistributionIdentity = {
  revision: null,
  dirty: null,
  distribution: null,
};

/**
 * Local-only version reporting: no Runtime, IPC, SQLite, network or upstream
 * access. Identity inspection is fail-soft, so the product version is always
 * printed even when the revision cannot be determined.
 */
export async function runVersionCli(
  args: readonly string[],
  options: VersionCliOptions,
): Promise<number> {
  const { distributionRoot, io, runner } = options;
  if (args[0] !== "version") {
    let revision: string | null = null;
    if (distributionRoot !== undefined)
      try {
        revision = await inspectSourceRevision(distributionRoot, runner);
      } catch {
        revision = null;
      }
    io.stdout(displayVersion(productVersion, revision));
    return 0;
  }

  const json = args.includes("--json");
  try {
    const parsed = parseArguments(
      [...args.slice(1)],
      new Set(),
      new Set(["json"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("version only accepts --json");
    let identity = unavailable;
    if (distributionRoot !== undefined)
      try {
        identity = await inspectSourceIdentity(distributionRoot, runner);
      } catch {
        identity = unavailable;
      }
    const report = buildVersionReport(identity);
    if (json) io.stdout(JSON.stringify(report));
    else for (const line of renderVersionReport(report)) io.stdout(line);
    return 0;
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    if (json)
      io.stdout(
        JSON.stringify({
          contractVersion: 1,
          status: "failed",
          error: { code: "invalid_arguments", message: error.message },
        }),
      );
    else io.stderr(error.message);
    return 1;
  }
}

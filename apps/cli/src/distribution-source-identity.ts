import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  isGitRevision,
  type DistributionIdentity,
} from "@ai-office/command-support/version.ts";

/**
 * Local, read-only Git inspection of a source-linked distribution. Shared by
 * version reporting and the source updater so that HEAD resolution, revision
 * validation and tracked dirty state have one definition. It never touches the
 * network, branches, upstreams or the Runtime.
 */

export interface DistributionCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DistributionCommandRunner {
  run(
    command: readonly string[],
    cwd: string,
  ): Promise<DistributionCommandResult>;
}

/** Variables that redirect Git to a repository other than the one at `cwd`. */
const repositorySelectionVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

export class BunDistributionCommandRunner implements DistributionCommandRunner {
  /**
   * `isolateRepositorySelection` drops the variables above so an ambient
   * `GIT_DIR` (for example inside a Git hook) cannot make identity inspection
   * describe another repository. The updater keeps its historical environment.
   */
  constructor(
    private readonly options: { isolateRepositorySelection?: boolean } = {},
  ) {}

  async run(
    command: readonly string[],
    cwd: string,
  ): Promise<DistributionCommandResult> {
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      };
      if (this.options.isolateRepositorySelection === true)
        for (const name of repositorySelectionVariables) delete env[name];
      const child = Bun.spawn([...command], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } catch {
      return { exitCode: 127, stdout: "", stderr: "" };
    }
  }
}

export type GitReadFailure = "command_failed" | "invalid_output";
export type GitRead<T> =
  { ok: true; value: T } | { ok: false; reason: GitReadFailure };

async function runGit(
  runner: DistributionCommandRunner,
  root: string,
  args: readonly string[],
): Promise<DistributionCommandResult> {
  try {
    return await runner.run(["git", ...args], root);
  } catch {
    return { exitCode: 127, stdout: "", stderr: "" };
  }
}

/** `git rev-parse HEAD`, accepted only when it is a well-formed revision. */
export async function readHeadRevision(
  runner: DistributionCommandRunner,
  root: string,
): Promise<GitRead<string>> {
  const result = await runGit(runner, root, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) return { ok: false, reason: "command_failed" };
  const value = result.stdout.trim();
  return isGitRevision(value)
    ? { ok: true, value }
    : { ok: false, reason: "invalid_output" };
}

/** Canonical Git work-tree root that contains `root`. */
export async function readCheckoutRoot(
  runner: DistributionCommandRunner,
  root: string,
): Promise<GitRead<string>> {
  const result = await runGit(runner, root, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) return { ok: false, reason: "command_failed" };
  try {
    return { ok: true, value: realpathSync(result.stdout.trim()) };
  } catch {
    return { ok: false, reason: "invalid_output" };
  }
}

/**
 * Tracked dirty state: staged or unstaged changes to tracked files. Untracked
 * files never count. The updater's clean-worktree precondition uses this too.
 */
export async function readTrackedDirty(
  runner: DistributionCommandRunner,
  root: string,
): Promise<GitRead<boolean>> {
  const result = await runGit(runner, root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  return result.exitCode === 0
    ? { ok: true, value: result.stdout.trim() !== "" }
    : { ok: false, reason: "command_failed" };
}

function defaultRunner(): DistributionCommandRunner {
  return new BunDistributionCommandRunner({ isolateRepositorySelection: true });
}

/**
 * The checkout rooted exactly at `distributionRoot`, or null. A root nested
 * inside some other repository is not that repository's code, so it never
 * reports the enclosing HEAD.
 */
async function resolveCheckout(
  distributionRoot: string,
  runner: DistributionCommandRunner,
): Promise<{ root: string; revision: string } | null> {
  let root: string;
  try {
    root = realpathSync(resolve(distributionRoot));
  } catch {
    return null;
  }
  const checkout = await readCheckoutRoot(runner, root);
  if (!checkout.ok || checkout.value !== root) return null;
  const head = await readHeadRevision(runner, root);
  return head.ok ? { root, revision: head.value } : null;
}

/** Revision only: the cheap path used by `--version`. */
export async function inspectSourceRevision(
  distributionRoot: string,
  runner: DistributionCommandRunner = defaultRunner(),
): Promise<string | null> {
  return (await resolveCheckout(distributionRoot, runner))?.revision ?? null;
}

/** Revision plus tracked dirty state; dirty is inspected only with a revision. */
export async function inspectSourceIdentity(
  distributionRoot: string,
  runner: DistributionCommandRunner = defaultRunner(),
): Promise<DistributionIdentity> {
  const checkout = await resolveCheckout(distributionRoot, runner);
  if (checkout === null)
    return { revision: null, dirty: null, distribution: null };
  const dirty = await readTrackedDirty(runner, checkout.root);
  return {
    revision: checkout.revision,
    dirty: dirty.ok ? dirty.value : null,
    distribution: "source-linked",
  };
}

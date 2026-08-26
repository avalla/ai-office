import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  DistributionUpdateAdapter,
  DistributionUpdateDraft,
  DistributionUpdateResult,
  DistributionUpdateStep,
} from "@ai-office/application/ports/distribution-update-adapter.port.ts";

export class LocalDistributionUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDistributionUpdateError";
  }
}

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

class BunDistributionCommandRunner implements DistributionCommandRunner {
  async run(
    command: readonly string[],
    cwd: string,
  ): Promise<DistributionCommandResult> {
    try {
      const child = Bun.spawn([...command], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

const steps: readonly DistributionUpdateStep[] = [
  "fetch",
  "fast_forward",
  "install_dependencies",
  "register_link",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalDistributionRoot(input: string): string {
  try {
    const canonical = realpathSync(resolve(input));
    if (!lstatSync(canonical).isDirectory())
      throw new LocalDistributionUpdateError(
        `AI Office distribution root is not a directory: ${canonical}`,
      );
    return canonical;
  } catch (error) {
    if (error instanceof LocalDistributionUpdateError) throw error;
    throw new LocalDistributionUpdateError(
      `AI Office distribution root could not be resolved: ${resolve(input)}`,
    );
  }
}

function validatePackage(distributionRoot: string): void {
  const packagePath = join(distributionRoot, "package.json");
  let parsed: unknown;
  try {
    const status = lstatSync(packagePath);
    if (status.isSymbolicLink() || !status.isFile()) throw new Error();
    parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
  } catch {
    throw new LocalDistributionUpdateError(
      `AI Office update requires a regular package.json in ${distributionRoot}`,
    );
  }
  if (!isRecord(parsed) || parsed.name !== "ai-office")
    throw new LocalDistributionUpdateError(
      `The selected distribution is not the ai-office package: ${distributionRoot}`,
    );
  const bin = parsed.bin;
  if (
    !isRecord(bin) ||
    typeof bin["ai-office"] !== "string" ||
    bin["ai-office"] !== "./bin/ai-office.ts"
  )
    throw new LocalDistributionUpdateError(
      "AI Office update supports only the current source-linked package layout",
    );
}

function trimmed(result: DistributionCommandResult): string {
  return result.stdout.trim();
}

function revision(value: string, source: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(value))
    throw new LocalDistributionUpdateError(
      `AI Office update received an invalid revision from ${source}`,
    );
  return value;
}

function failure(
  draft: DistributionUpdateDraft,
  completedSteps: readonly DistributionUpdateStep[],
  failedStep: DistributionUpdateStep,
  toRevision: string,
  message: string,
): DistributionUpdateResult {
  return {
    contractVersion: 1,
    status:
      toRevision === draft.currentRevision &&
      !completedSteps.includes("fast_forward")
        ? "failed"
        : "partial",
    distributionRoot: draft.distributionRoot,
    fromRevision: draft.currentRevision,
    toRevision,
    completedSteps,
    failedStep,
    message,
  };
}

export class LocalDistributionUpdateAdapter implements DistributionUpdateAdapter {
  constructor(
    private readonly runner: DistributionCommandRunner = new BunDistributionCommandRunner(),
    private readonly bunExecutable: string = process.execPath,
  ) {}

  private async command(
    distributionRoot: string,
    command: readonly string[],
    failureMessage: string,
  ): Promise<DistributionCommandResult> {
    const result = await this.runner.run(command, distributionRoot);
    if (result.exitCode !== 0)
      throw new LocalDistributionUpdateError(failureMessage);
    return result;
  }

  private async head(distributionRoot: string): Promise<string> {
    const result = await this.command(
      distributionRoot,
      ["git", "rev-parse", "HEAD"],
      "AI Office update could not resolve the current Git revision",
    );
    return revision(trimmed(result), "the local checkout");
  }

  async plan(distributionRootInput: string): Promise<DistributionUpdateDraft> {
    const distributionRoot = canonicalDistributionRoot(distributionRootInput);
    validatePackage(distributionRoot);

    await this.command(
      distributionRoot,
      ["git", "rev-parse", "--is-inside-work-tree"],
      "AI Office update requires a source-linked Git checkout",
    );
    const topLevelResult = await this.command(
      distributionRoot,
      ["git", "rev-parse", "--show-toplevel"],
      "AI Office update could not resolve the Git checkout root",
    );
    let topLevel: string;
    try {
      topLevel = realpathSync(trimmed(topLevelResult));
    } catch {
      throw new LocalDistributionUpdateError(
        "AI Office update could not canonicalize the Git checkout root",
      );
    }
    if (topLevel !== distributionRoot)
      throw new LocalDistributionUpdateError(
        "AI Office update requires the distribution root to be the Git checkout root",
      );
    const trackedStatus = await this.command(
      distributionRoot,
      ["git", "status", "--porcelain=v1", "--untracked-files=no"],
      "AI Office update could not inspect the Git working tree",
    );
    if (trimmed(trackedStatus) !== "")
      throw new LocalDistributionUpdateError(
        "AI Office update requires a clean tracked Git working tree. Commit or restore tracked changes, then run ai-office update again.",
      );

    const branchResult = await this.command(
      distributionRoot,
      ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
      "AI Office update requires a checked-out branch; detached HEAD is not supported",
    );
    const branch = trimmed(branchResult);
    if (branch === "" || branch.includes("\n"))
      throw new LocalDistributionUpdateError(
        "AI Office update could not resolve the checked-out branch",
      );

    const remoteResult = await this.command(
      distributionRoot,
      ["git", "config", "--get", `branch.${branch}.remote`],
      "The current AI Office branch has no upstream remote",
    );
    const remote = trimmed(remoteResult);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || remote === ".")
      throw new LocalDistributionUpdateError(
        "AI Office update requires a conventional named Git remote",
      );

    const upstreamResult = await this.command(
      distributionRoot,
      ["git", "config", "--get", `branch.${branch}.merge`],
      "The current AI Office branch has no upstream branch",
    );
    const upstreamRef = trimmed(upstreamResult);
    if (!upstreamRef.startsWith("refs/heads/") || upstreamRef.includes("\n"))
      throw new LocalDistributionUpdateError(
        "AI Office update requires an upstream branch under refs/heads",
      );
    const trackingResult = await this.command(
      distributionRoot,
      ["git", "rev-parse", "--symbolic-full-name", "@{upstream}"],
      "AI Office update could not resolve the upstream tracking ref",
    );
    const trackingRef = trimmed(trackingResult);
    if (!trackingRef.startsWith("refs/remotes/") || trackingRef.includes("\n"))
      throw new LocalDistributionUpdateError(
        "AI Office update requires an upstream remote-tracking ref",
      );

    const currentRevision = await this.head(distributionRoot);
    const remoteResult_ = await this.command(
      distributionRoot,
      ["git", "ls-remote", "--exit-code", remote, upstreamRef],
      "AI Office update could not inspect the upstream revision. Check network access and Git authentication.",
    );
    const matching = remoteResult_.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(/\s+/, 2))
      .find((parts) => parts[1] === upstreamRef);
    const targetRevision = revision(
      matching?.[0] ?? "",
      "the configured upstream",
    );
    if (targetRevision !== currentRevision) {
      const targetExists = await this.runner.run(
        ["git", "cat-file", "-e", `${targetRevision}^{commit}`],
        distributionRoot,
      );
      if (targetExists.exitCode === 0) {
        const remoteIsAncestor = await this.runner.run(
          [
            "git",
            "merge-base",
            "--is-ancestor",
            targetRevision,
            currentRevision,
          ],
          distributionRoot,
        );
        if (remoteIsAncestor.exitCode === 0)
          throw new LocalDistributionUpdateError(
            "The AI Office distribution branch contains local commits that are not on its upstream. Reconcile or publish them before updating.",
          );
        const currentIsAncestor = await this.runner.run(
          [
            "git",
            "merge-base",
            "--is-ancestor",
            currentRevision,
            targetRevision,
          ],
          distributionRoot,
        );
        if (currentIsAncestor.exitCode !== 0)
          throw new LocalDistributionUpdateError(
            "The AI Office distribution branch has diverged from its upstream. Reconcile the checkout manually before updating.",
          );
      }
    }

    return {
      contractVersion: 1,
      distributionRoot,
      packageName: "ai-office",
      branch,
      remote,
      upstreamRef,
      trackingRef,
      currentRevision,
      targetRevision,
      steps,
    };
  }

  async apply(
    draft: DistributionUpdateDraft,
  ): Promise<DistributionUpdateResult> {
    const completedSteps: DistributionUpdateStep[] = [];
    const fetchResult = await this.runner.run(
      [
        "git",
        "fetch",
        "--no-tags",
        "--quiet",
        draft.remote,
        `${draft.upstreamRef}:${draft.trackingRef}`,
      ],
      draft.distributionRoot,
    );
    if (fetchResult.exitCode !== 0)
      return failure(
        draft,
        completedSteps,
        "fetch",
        await this.head(draft.distributionRoot),
        "The approved upstream could not be fetched. No program files were updated; check network access and run ai-office update again.",
      );
    completedSteps.push("fetch");

    const fetched = await this.headOfFetch(draft.distributionRoot);
    if (fetched !== draft.targetRevision)
      return failure(
        draft,
        completedSteps,
        "fetch",
        await this.head(draft.distributionRoot),
        "The upstream changed after approval. No program files were updated; run ai-office update again to review a new plan.",
      );

    const ancestor = await this.runner.run(
      [
        "git",
        "merge-base",
        "--is-ancestor",
        draft.currentRevision,
        draft.targetRevision,
      ],
      draft.distributionRoot,
    );
    if (ancestor.exitCode !== 0)
      return failure(
        draft,
        completedSteps,
        "fast_forward",
        await this.head(draft.distributionRoot),
        "The configured upstream is not a fast-forward from this installation. No program files were updated; reconcile the checkout manually.",
      );

    const mergeResult = await this.runner.run(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--ff-only",
        "--quiet",
        draft.targetRevision,
      ],
      draft.distributionRoot,
    );
    const afterMerge = await this.head(draft.distributionRoot);
    if (mergeResult.exitCode !== 0 || afterMerge !== draft.targetRevision)
      return failure(
        draft,
        completedSteps,
        "fast_forward",
        afterMerge,
        "AI Office could not fast-forward the source checkout. Inspect the distribution checkout and run ai-office update again.",
      );
    completedSteps.push("fast_forward");

    const installResult = await this.runner.run(
      [this.bunExecutable, "install", "--frozen-lockfile"],
      draft.distributionRoot,
    );
    if (installResult.exitCode !== 0)
      return failure(
        draft,
        completedSteps,
        "install_dependencies",
        afterMerge,
        "AI Office source was updated, but dependency installation failed. From the distribution root run bun install --frozen-lockfile, then bun link.",
      );
    completedSteps.push("install_dependencies");

    const linkResult = await this.runner.run(
      [this.bunExecutable, "link"],
      draft.distributionRoot,
    );
    if (linkResult.exitCode !== 0)
      return failure(
        draft,
        completedSteps,
        "register_link",
        afterMerge,
        "AI Office source and dependencies were updated, but the executable link was not registered. From the distribution root run bun link.",
      );
    completedSteps.push("register_link");

    return {
      contractVersion: 1,
      status: "updated",
      distributionRoot: draft.distributionRoot,
      fromRevision: draft.currentRevision,
      toRevision: afterMerge,
      completedSteps,
      message:
        "AI Office was updated. Runtime state, global memory, and project bindings were preserved.",
    };
  }

  private async headOfFetch(distributionRoot: string): Promise<string> {
    const result = await this.command(
      distributionRoot,
      ["git", "rev-parse", "FETCH_HEAD"],
      "AI Office update could not verify the fetched revision",
    );
    return revision(trimmed(result), "the fetched upstream");
  }
}

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  DistributionUpdateAdapter,
  DistributionUpdateDraft,
  DistributionUpdateResult,
  DistributionUpdateStep,
} from "@ai-office/application/ports/distribution-update-adapter.port.ts";
import { DistributionUpdatePreconditionError } from "@ai-office/application/ports/distribution-update-adapter.port.ts";

export class LocalDistributionUpdateError extends DistributionUpdatePreconditionError {
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
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
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
  toRevision: string | null,
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

  private async run(
    command: readonly string[],
    cwd: string,
  ): Promise<DistributionCommandResult> {
    try {
      return await this.runner.run(command, cwd);
    } catch {
      return { exitCode: 127, stdout: "", stderr: "" };
    }
  }

  private async observedHead(root: string): Promise<string | null> {
    try {
      return await this.head(root);
    } catch {
      return null;
    }
  }

  private async requireSelection(
    draft: Pick<
      DistributionUpdateDraft,
      | "distributionRoot"
      | "branch"
      | "remote"
      | "upstreamRef"
      | "trackingRef"
      | "remoteIdentity"
    >,
  ): Promise<void> {
    for (const [args, expected] of [
      [["symbolic-ref", "--quiet", "--short", "HEAD"], draft.branch],
      [["config", "--get", `branch.${draft.branch}.remote`], draft.remote],
      [["config", "--get", `branch.${draft.branch}.merge`], draft.upstreamRef],
      [["rev-parse", "--symbolic-full-name", "@{upstream}"], draft.trackingRef],
    ] as const) {
      const actual = await this.command(
        draft.distributionRoot,
        ["git", ...args],
        "AI Office update could not revalidate its upstream selection",
      );
      if (trimmed(actual) !== expected)
        throw new LocalDistributionUpdateError(
          "The AI Office branch or upstream changed during update. Run ai-office update again.",
        );
    }
    if (
      (await this.remoteIdentity(draft.distributionRoot, draft.remote)) !==
      draft.remoteIdentity
    )
      throw new LocalDistributionUpdateError(
        "The AI Office upstream remote changed during update. Run ai-office update again.",
      );
  }

  private async command(
    distributionRoot: string,
    command: readonly string[],
    failureMessage: string,
  ): Promise<DistributionCommandResult> {
    const result = await this.run(command, distributionRoot);
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

  private async requireCleanTrackedWorktree(
    distributionRoot: string,
  ): Promise<void> {
    const trackedStatus = await this.command(
      distributionRoot,
      ["git", "status", "--porcelain=v1", "--untracked-files=no"],
      "AI Office update could not inspect the Git working tree",
    );
    if (trimmed(trackedStatus) !== "")
      throw new LocalDistributionUpdateError(
        "AI Office update requires a clean tracked Git working tree. Commit or restore tracked changes, then run ai-office update again.",
      );
  }

  private async acquireTargetObject(input: {
    distributionRoot: string;
    remote: string;
    upstreamRef: string;
    targetRevision: string;
  }): Promise<void> {
    const existing = await this.run(
      ["git", "cat-file", "-e", `${input.targetRevision}^{commit}`],
      input.distributionRoot,
    );
    if (existing.exitCode === 0) return;

    const temporaryRef = `refs/ai-office/update-plan/${randomUUID()}`;
    let acquisitionFailed = false;
    let acquisitionError: unknown;
    try {
      await this.command(
        input.distributionRoot,
        [
          "git",
          "fetch",
          "--no-write-fetch-head",
          "--refmap=",
          "--no-auto-maintenance",
          "--no-tags",
          "--quiet",
          "--recurse-submodules=no",
          input.remote,
          `${input.upstreamRef}:${temporaryRef}`,
        ],
        "AI Office update could not acquire the advertised upstream commit for safe planning. Check network access and Git authentication.",
      );
      const fetchedResult = await this.command(
        input.distributionRoot,
        ["git", "rev-parse", temporaryRef],
        "AI Office update could not verify its temporary planning ref",
      );
      const fetchedRevision = revision(
        trimmed(fetchedResult),
        "the temporary planning ref",
      );
      if (fetchedRevision !== input.targetRevision)
        throw new LocalDistributionUpdateError(
          "The upstream changed while AI Office was planning the update. Run ai-office update again to inspect the new target.",
        );
    } catch (error) {
      acquisitionFailed = true;
      acquisitionError = error;
    }
    const cleanup = await this.run(
      ["git", "update-ref", "-d", temporaryRef],
      input.distributionRoot,
    );
    if (cleanup.exitCode !== 0)
      throw new LocalDistributionUpdateError(
        `AI Office update could not remove temporary planning ref ${temporaryRef}`,
      );
    if (acquisitionFailed) throw acquisitionError;
  }

  private async requireFastForward(input: {
    distributionRoot: string;
    currentRevision: string;
    targetRevision: string;
  }): Promise<void> {
    if (input.currentRevision === input.targetRevision) return;
    const currentIsAncestor = await this.run(
      [
        "git",
        "merge-base",
        "--is-ancestor",
        input.currentRevision,
        input.targetRevision,
      ],
      input.distributionRoot,
    );
    if (currentIsAncestor.exitCode === 0) return;
    if (currentIsAncestor.exitCode !== 1)
      throw new LocalDistributionUpdateError(
        "AI Office update could not prove that the upstream is a fast-forward",
      );

    const targetIsAncestor = await this.run(
      [
        "git",
        "merge-base",
        "--is-ancestor",
        input.targetRevision,
        input.currentRevision,
      ],
      input.distributionRoot,
    );
    if (targetIsAncestor.exitCode === 0)
      throw new LocalDistributionUpdateError(
        "The AI Office distribution branch contains local commits that are not on its upstream. Reconcile or publish them before updating.",
      );
    if (targetIsAncestor.exitCode === 1)
      throw new LocalDistributionUpdateError(
        "The AI Office distribution branch has diverged from its upstream. Reconcile the checkout manually before updating.",
      );
    throw new LocalDistributionUpdateError(
      "AI Office update could not compare the local and upstream revisions",
    );
  }

  private async remoteIdentity(
    distributionRoot: string,
    remote: string,
  ): Promise<string> {
    const result = await this.command(
      distributionRoot,
      ["git", "config", "--get-all", `remote.${remote}.url`],
      "AI Office update could not resolve the configured upstream remote identity",
    );
    const urls = result.stdout.split(/\r?\n/).filter((url) => url !== "");
    if (urls.length === 0)
      throw new LocalDistributionUpdateError(
        "The current AI Office upstream remote has no fetch URL",
      );
    const effective = await this.command(
      distributionRoot,
      ["git", "remote", "get-url", "--all", remote],
      "AI Office update could not resolve the effective upstream remote identity",
    );
    return `sha256:${createHash("sha256")
      .update(
        JSON.stringify([urls, effective.stdout.split(/\r?\n/).filter(Boolean)]),
        "utf8",
      )
      .digest("hex")}`;
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
    await this.requireCleanTrackedWorktree(distributionRoot);

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
    const remoteIdentity = await this.remoteIdentity(distributionRoot, remote);

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
    await this.acquireTargetObject({
      distributionRoot,
      remote,
      upstreamRef,
      targetRevision,
    });
    if ((await this.head(distributionRoot)) !== currentRevision)
      throw new LocalDistributionUpdateError(
        "The AI Office distribution revision changed during update planning. Run ai-office update again.",
      );
    await this.requireSelection({
      distributionRoot,
      branch,
      remote,
      upstreamRef,
      trackingRef,
      remoteIdentity,
    });
    await this.requireCleanTrackedWorktree(distributionRoot);
    await this.requireFastForward({
      distributionRoot,
      currentRevision,
      targetRevision,
    });

    return {
      contractVersion: 1,
      distributionRoot,
      packageName: "ai-office",
      branch,
      remote,
      remoteIdentity,
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
    const fetchResult = await this.run(
      [
        "git",
        "fetch",
        "--no-tags",
        "--quiet",
        "--refmap=",
        "--recurse-submodules=no",
        "--no-auto-maintenance",
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
        await this.observedHead(draft.distributionRoot),
        "The approved upstream could not be fetched. No program files were updated; check network access and run ai-office update again.",
      );
    let fetched: string;
    try {
      fetched = await this.headOfFetch(draft.distributionRoot);
    } catch {
      return failure(
        draft,
        completedSteps,
        "fetch",
        await this.observedHead(draft.distributionRoot),
        "AI Office could not verify the fetched revision. Inspect the checkout and run ai-office update again.",
      );
    }
    if (fetched !== draft.targetRevision)
      return failure(
        draft,
        completedSteps,
        "fetch",
        await this.observedHead(draft.distributionRoot),
        "The upstream changed after approval. No program files were updated; run ai-office update again to review a new plan.",
      );

    completedSteps.push("fetch");
    try {
      await this.requireSelection(draft);
      await this.requireCleanTrackedWorktree(draft.distributionRoot);
      if ((await this.head(draft.distributionRoot)) !== draft.currentRevision)
        throw new LocalDistributionUpdateError(
          "The checkout revision changed after approval",
        );
    } catch {
      return failure(
        draft,
        completedSteps,
        "fast_forward",
        await this.observedHead(draft.distributionRoot),
        "The checkout or upstream changed after approval. Run ai-office update again.",
      );
    }

    const ancestor = await this.run(
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
        await this.observedHead(draft.distributionRoot),
        "The configured upstream is not a fast-forward from this installation. No program files were updated; reconcile the checkout manually.",
      );

    const mergeResult = await this.run(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--ff-only",
        "--no-overwrite-ignore",
        "--quiet",
        draft.targetRevision,
      ],
      draft.distributionRoot,
    );
    const afterMerge = await this.observedHead(draft.distributionRoot);
    if (mergeResult.exitCode !== 0 || afterMerge !== draft.targetRevision)
      return failure(
        draft,
        completedSteps,
        "fast_forward",
        afterMerge,
        "AI Office could not fast-forward the source checkout. Inspect the distribution checkout and run ai-office update again.",
      );
    completedSteps.push("fast_forward");

    const installResult = await this.run(
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

    const linkResult = await this.run(
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

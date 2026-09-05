import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LocalDistributionUpdateAdapter,
  type DistributionCommandResult,
  type DistributionCommandRunner,
} from "../../apps/cli/src/local-distribution-update-adapter.ts";
import {
  DistributionUpdateApprovalError,
  ManageDistributionUpdate,
} from "@ai-office/application/runtime/manage-distribution-update.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-source-update-"));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function hasGitObject(cwd: string, revision: string): boolean {
  return (
    Bun.spawnSync(["git", "cat-file", "-e", `${revision}^{commit}`], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

function temporaryPlanningRefs(cwd: string): string[] {
  const output = git(
    cwd,
    "for-each-ref",
    "--format=%(refname)",
    "refs/ai-office/update-plan",
  );
  return output === "" ? [] : output.split("\n");
}

class GitWithFakeBunRunner implements DistributionCommandRunner {
  readonly bunCommands: string[][] = [];

  constructor(private readonly failInstall = false) {}

  async run(
    command: readonly string[],
    cwd: string,
  ): Promise<DistributionCommandResult> {
    if (command[0] === "/test/fake-bun") {
      this.bunCommands.push([...command]);
      return {
        exitCode: this.failInstall && command[1] === "install" ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }
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
  }
}

function sourceLinkedInstallation(): {
  source: string;
  distribution: string;
} {
  const root = temporaryRoot();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const distribution = join(root, "distribution");
  mkdirSync(source);
  git(root, "init", "--bare", remote);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "AI Office Test");
  git(source, "config", "user.email", "ai-office@example.invalid");
  mkdirSync(join(source, "bin"));
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "ai-office",
      private: true,
      bin: { "ai-office": "./bin/ai-office.ts" },
    }),
  );
  writeFileSync(join(source, "bin", "ai-office.ts"), "#!/usr/bin/env bun\n");
  writeFileSync(join(source, "version.txt"), "one\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--set-upstream", "origin", "main");
  git(root, "clone", "--branch", "main", remote, distribution);
  return { source, distribution };
}

function publishNextRevision(source: string, value = "two\n"): string {
  writeFileSync(join(source, "version.txt"), value);
  git(source, "add", "version.txt");
  git(source, "commit", "-m", `publish ${value.trim()}`);
  git(source, "push", "origin", "main");
  return git(source, "rev-parse", "HEAD");
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("source-linked distribution update adapter", () => {
  test("updates the distribution from its upstream without using project or runtime paths", async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const currentRevision = git(distribution, "rev-parse", "HEAD");
    const targetRevision = publishNextRevision(source);
    expect(hasGitObject(distribution, targetRevision)).toBe(false);
    writeFileSync(join(distribution, "untracked-local-note.txt"), "preserve\n");
    const runner = new GitWithFakeBunRunner();
    const service = new ManageDistributionUpdate(
      new LocalDistributionUpdateAdapter(runner, "/test/fake-bun"),
      { assertStopped: async () => {} },
    );

    const trackingBefore = git(
      distribution,
      "rev-parse",
      "refs/remotes/origin/main",
    );
    const indexBefore = readFileSync(join(distribution, ".git", "index"));
    const plan = await service.plan(distribution);
    expect(git(distribution, "rev-parse", "refs/remotes/origin/main")).toBe(
      trackingBefore,
    );
    expect(readFileSync(join(distribution, ".git", "index"))).toEqual(
      indexBefore,
    );
    expect(existsSync(join(distribution, ".git", "FETCH_HEAD"))).toBe(false);
    expect(plan).toMatchObject({
      distributionRoot: realpathSync(distribution),
      branch: "main",
      upstream: {
        remote: "origin",
        identity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        sourceRef: "refs/heads/main",
        trackingRef: "refs/remotes/origin/main",
      },
      targetRevision,
      updateAvailable: true,
      preserves: ["runtime_state", "global_memory", "project_bindings"],
    });
    expect(git(distribution, "rev-parse", "HEAD")).toBe(currentRevision);
    expect(readFileSync(join(distribution, "version.txt"), "utf8")).toBe(
      "one\n",
    );
    expect(hasGitObject(distribution, targetRevision)).toBe(true);
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
    const result = await service.apply({
      distributionRoot: distribution,
      approvedPlanHash: plan.planHash,
    });

    expect(result).toMatchObject({
      status: "updated",
      toRevision: targetRevision,
      completedSteps: [
        "fetch",
        "fast_forward",
        "install_dependencies",
        "register_link",
      ],
    });
    expect(readFileSync(join(distribution, "version.txt"), "utf8")).toBe(
      "two\n",
    );
    expect(
      readFileSync(join(distribution, "untracked-local-note.txt"), "utf8"),
    ).toBe("preserve\n");
    expect(git(distribution, "rev-parse", "refs/remotes/origin/main")).toBe(
      targetRevision,
    );
    expect(runner.bunCommands).toEqual([
      ["/test/fake-bun", "install", "--frozen-lockfile"],
      ["/test/fake-bun", "link"],
    ]);
  });

  test("fails closed on tracked changes before contacting the upstream", async () => {
    const { distribution } = sourceLinkedInstallation();
    writeFileSync(join(distribution, "version.txt"), "local edit\n");
    const adapter = new LocalDistributionUpdateAdapter(
      new GitWithFakeBunRunner(),
      "/test/fake-bun",
    );

    await expect(adapter.plan(distribution)).rejects.toThrow(
      "clean tracked Git working tree",
    );
  });

  test("rejects divergent local and remote commits before approving an absent target", async () => {
    const { source, distribution } = sourceLinkedInstallation();
    git(distribution, "config", "user.name", "AI Office Test");
    git(distribution, "config", "user.email", "ai-office@example.invalid");
    writeFileSync(join(distribution, "local.txt"), "local\n");
    git(distribution, "add", "local.txt");
    git(distribution, "commit", "-m", "local-only change");
    const localRevision = git(distribution, "rev-parse", "HEAD");
    const targetRevision = publishNextRevision(source);
    expect(hasGitObject(distribution, targetRevision)).toBe(false);
    const adapter = new LocalDistributionUpdateAdapter(
      new GitWithFakeBunRunner(),
      "/test/fake-bun",
    );

    await expect(adapter.plan(distribution)).rejects.toThrow(
      "has diverged from its upstream",
    );
    expect(git(distribution, "rev-parse", "HEAD")).toBe(localRevision);
    expect(readFileSync(join(distribution, "local.txt"), "utf8")).toBe(
      "local\n",
    );
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
  });

  test("rejects a logically local-ahead shallow branch when the target object is absent", async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const baseRevision = git(source, "rev-parse", "HEAD");
    publishNextRevision(source);
    const remote = git(source, "remote", "get-url", "origin");
    rmSync(distribution, { recursive: true });
    git(
      dirname(distribution),
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      `file://${remote}`,
      distribution,
    );
    git(distribution, "config", "user.name", "AI Office Test");
    git(distribution, "config", "user.email", "ai-office@example.invalid");
    writeFileSync(join(distribution, "local.txt"), "local\n");
    git(distribution, "add", "local.txt");
    git(distribution, "commit", "-m", "local commit after shallow tip");
    const localRevision = git(distribution, "rev-parse", "HEAD");
    git(source, "push", "--force", "origin", `${baseRevision}:refs/heads/main`);
    expect(hasGitObject(distribution, baseRevision)).toBe(false);
    const adapter = new LocalDistributionUpdateAdapter(
      new GitWithFakeBunRunner(),
      "/test/fake-bun",
    );

    await expect(adapter.plan(distribution)).rejects.toThrow(
      "has diverged from its upstream",
    );
    expect(git(distribution, "rev-parse", "HEAD")).toBe(localRevision);
    expect(readFileSync(join(distribution, "local.txt"), "utf8")).toBe(
      "local\n",
    );
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
  });

  test("rejects a locally-ahead branch during planning", async () => {
    const { distribution } = sourceLinkedInstallation();
    git(distribution, "config", "user.name", "AI Office Test");
    git(distribution, "config", "user.email", "ai-office@example.invalid");
    writeFileSync(join(distribution, "local.txt"), "local\n");
    git(distribution, "add", "local.txt");
    git(distribution, "commit", "-m", "local-only change");
    const localRevision = git(distribution, "rev-parse", "HEAD");
    const adapter = new LocalDistributionUpdateAdapter(
      new GitWithFakeBunRunner(),
      "/test/fake-bun",
    );

    await expect(adapter.plan(distribution)).rejects.toThrow(
      "contains local commits that are not on its upstream",
    );
    expect(git(distribution, "rev-parse", "HEAD")).toBe(localRevision);
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
  });

  test("rejects an unrelated absent upstream target before approval", async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const localRevision = git(distribution, "rev-parse", "HEAD");
    git(source, "switch", "--orphan", "replacement");
    writeFileSync(join(source, "version.txt"), "unrelated\n");
    git(source, "add", "version.txt");
    git(source, "commit", "-m", "unrelated replacement");
    git(source, "push", "--force", "origin", "HEAD:main");
    const targetRevision = git(source, "rev-parse", "HEAD");
    expect(hasGitObject(distribution, targetRevision)).toBe(false);
    const adapter = new LocalDistributionUpdateAdapter(
      new GitWithFakeBunRunner(),
      "/test/fake-bun",
    );

    await expect(adapter.plan(distribution)).rejects.toThrow(
      "has diverged from its upstream",
    );
    expect(git(distribution, "rev-parse", "HEAD")).toBe(localRevision);
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
  });

  test("rejects stale approval when the upstream advances after planning", async () => {
    const { source, distribution } = sourceLinkedInstallation();
    publishNextRevision(source);
    const runner = new GitWithFakeBunRunner();
    const service = new ManageDistributionUpdate(
      new LocalDistributionUpdateAdapter(runner, "/test/fake-bun"),
      { assertStopped: async () => {} },
    );
    const plan = await service.plan(distribution);
    const initialRevision = git(distribution, "rev-parse", "HEAD");
    publishNextRevision(source, "three\n");

    await expect(
      service.apply({
        distributionRoot: distribution,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(DistributionUpdateApprovalError);
    expect(git(distribution, "rev-parse", "HEAD")).toBe(initialRevision);
    expect(readFileSync(join(distribution, "version.txt"), "utf8")).toBe(
      "one\n",
    );
    expect(runner.bunCommands).toEqual([]);
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
  });

  test("rejects stale approval when the configured remote identity changes", async () => {
    const { distribution } = sourceLinkedInstallation();
    const runner = new GitWithFakeBunRunner();
    const service = new ManageDistributionUpdate(
      new LocalDistributionUpdateAdapter(runner, "/test/fake-bun"),
      { assertStopped: async () => {} },
    );
    const plan = await service.plan(distribution);
    const originalUrl = git(distribution, "remote", "get-url", "origin");
    git(distribution, "remote", "set-url", "origin", `file://${originalUrl}`);

    await expect(
      service.apply({
        distributionRoot: distribution,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(DistributionUpdateApprovalError);
    expect(runner.bunCommands).toEqual([]);
  });

  test("treats a clean already-current checkout as an idempotent no-op", async () => {
    const { distribution } = sourceLinkedInstallation();
    const runner = new GitWithFakeBunRunner();
    const service = new ManageDistributionUpdate(
      new LocalDistributionUpdateAdapter(runner, "/test/fake-bun"),
      { assertStopped: async () => {} },
    );
    const plan = await service.plan(distribution);

    expect(plan.updateAvailable).toBe(false);
    expect(
      await service.apply({
        distributionRoot: distribution,
        approvedPlanHash: plan.planHash,
      }),
    ).toMatchObject({ status: "already_current", completedSteps: [] });
    expect(runner.bunCommands).toEqual([]);
    expect(temporaryPlanningRefs(distribution)).toEqual([]);
  });

  test("reports partial state when source advances but dependency installation fails", async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const targetRevision = publishNextRevision(source);
    const runner = new GitWithFakeBunRunner(true);
    const service = new ManageDistributionUpdate(
      new LocalDistributionUpdateAdapter(runner, "/test/fake-bun"),
      { assertStopped: async () => {} },
    );
    const plan = await service.plan(distribution);

    const result = await service.apply({
      distributionRoot: distribution,
      approvedPlanHash: plan.planHash,
    });

    expect(result).toMatchObject({
      status: "partial",
      toRevision: targetRevision,
      completedSteps: ["fetch", "fast_forward"],
      failedStep: "install_dependencies",
    });
    expect(readFileSync(join(distribution, "version.txt"), "utf8")).toBe(
      "two\n",
    );
    expect(runner.bunCommands).toEqual([
      ["/test/fake-bun", "install", "--frozen-lockfile"],
    ]);
  });
});

class InterceptRunner extends GitWithFakeBunRunner {
  readonly commands: string[][] = [];
  intercept?: (
    command: readonly string[],
    cwd: string,
  ) => Promise<DistributionCommandResult | undefined>;
  override async run(
    command: readonly string[],
    cwd: string,
  ): Promise<DistributionCommandResult> {
    this.commands.push([...command]);
    return (await this.intercept?.(command, cwd)) ?? super.run(command, cwd);
  }
}
const commandFailure = {
  exitCode: 1,
  stdout: "",
  stderr: "SECRET must never escape",
};
function managed(runner = new InterceptRunner()) {
  return new ManageDistributionUpdate(
    new LocalDistributionUpdateAdapter(runner, "/test/fake-bun"),
    { assertStopped: async () => {} },
  );
}

for (const changed of [
  "HEAD",
  "tracked worktree",
  "upstream ref",
  "effective remote identity",
] as const) {
  test(`approval is stale after changing ${changed}`, async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const target = publishNextRevision(source);
    const runner = new InterceptRunner();
    const service = managed(runner);
    const plan = await service.plan(distribution);
    if (changed === "HEAD") git(distribution, "merge", "--ff-only", target);
    if (changed === "tracked worktree")
      writeFileSync(join(distribution, "version.txt"), "local edit\n");
    if (changed === "upstream ref") {
      git(source, "push", "origin", "HEAD:alternate");
      git(distribution, "fetch", "origin", "alternate");
      git(distribution, "config", "branch.main.merge", "refs/heads/alternate");
    }
    if (changed === "effective remote identity") {
      const original = git(distribution, "remote", "get-url", "origin");
      git(distribution, "config", `url.file://${original}.insteadOf`, original);
    }
    const head = git(distribution, "rev-parse", "HEAD");
    await expect(
      service.apply({
        distributionRoot: distribution,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(DistributionUpdateApprovalError);
    expect(git(distribution, "rev-parse", "HEAD")).toBe(head);
    expect(runner.bunCommands).toEqual([]);
  });
}

for (const state of ["detached", "no upstream"] as const) {
  test(`planning rejects ${state}`, async () => {
    const { distribution } = sourceLinkedInstallation();
    if (state === "detached") git(distribution, "checkout", "--detach");
    else git(distribution, "branch", "--unset-upstream");
    const runner = new InterceptRunner();
    await expect(managed(runner).plan(distribution)).rejects.toThrow(
      state === "detached" ? "detached HEAD" : "no upstream",
    );
    expect(
      runner.commands.some((command) => command.includes("ls-remote")),
    ).toBe(false);
  });
}

for (const fault of ["fetch", "verify", "cleanup"] as const) {
  test(`temporary planning ref cleanup is required on ${fault} failure`, async () => {
    const { source, distribution } = sourceLinkedInstallation();
    publishNextRevision(source);
    const runner = new InterceptRunner();
    runner.intercept = async (command, cwd) => {
      if (fault === "fetch" && command.includes("fetch")) {
        await new GitWithFakeBunRunner().run(command, cwd); // failure after ref creation
        return commandFailure;
      }
      if (
        fault === "verify" &&
        command[1] === "rev-parse" &&
        command[2]?.startsWith("refs/ai-office/")
      )
        return commandFailure;
      if (fault === "cleanup" && command[1] === "update-ref")
        return commandFailure;
      return undefined;
    };
    const before = git(distribution, "rev-parse", "HEAD");
    await expect(managed(runner).plan(distribution)).rejects.toThrow(
      fault === "cleanup" ? "could not remove temporary" : "could not",
    );
    expect(
      runner.commands.some(
        (command) => command[1] === "update-ref" && command[2] === "-d",
      ),
    ).toBe(true);
    expect(temporaryPlanningRefs(distribution)).toHaveLength(
      fault === "cleanup" ? 1 : 0,
    );
    expect(git(distribution, "rev-parse", "HEAD")).toBe(before);
    expect(git(distribution, "rev-parse", "refs/remotes/origin/main")).toBe(
      before,
    );
  });
}

test("upstream movement during target acquisition cleans temporary refs and denies a plan", async () => {
  const { source, distribution } = sourceLinkedInstallation();
  publishNextRevision(source);
  const runner = new InterceptRunner();
  runner.intercept = async (command) => {
    if (command.includes("fetch")) publishNextRevision(source, "three\n");
    return undefined;
  };
  await expect(managed(runner).plan(distribution)).rejects.toThrow(
    "upstream changed while",
  );
  expect(temporaryPlanningRefs(distribution)).toEqual([]);
});

for (const fault of [
  "fetch",
  "fast_forward",
  "install_dependencies",
  "register_link",
] as const) {
  test(`${fault} failure reports exact completed steps and never rolls back`, async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const target = publishNextRevision(source);
    const before = git(distribution, "rev-parse", "HEAD");
    const runner = new InterceptRunner();
    const service = managed(runner);
    const plan = await service.plan(distribution);
    runner.intercept = async (command) => {
      if (
        (fault === "fetch" && command.includes("fetch")) ||
        (fault === "fast_forward" && command.includes("merge")) ||
        (fault === "install_dependencies" && command[1] === "install") ||
        (fault === "register_link" && command[1] === "link")
      )
        return commandFailure;
      return undefined;
    };
    const completedSteps = [
      "fetch",
      "fast_forward",
      "install_dependencies",
      "register_link",
    ].slice(
      0,
      [
        "fetch",
        "fast_forward",
        "install_dependencies",
        "register_link",
      ].indexOf(fault),
    );
    const partial =
      fault === "install_dependencies" || fault === "register_link";
    const result = await service.apply({
      distributionRoot: distribution,
      approvedPlanHash: plan.planHash,
    });
    expect(result).toMatchObject({
      status: partial ? "partial" : "failed",
      failedStep: fault,
      completedSteps,
      toRevision: partial ? target : before,
    });
    expect(git(distribution, "rev-parse", "HEAD")).toBe(
      partial ? target : before,
    );
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(
      runner.commands.some((command) =>
        command.some((arg) =>
          ["stash", "reset", "switch", "checkout", "rebase"].includes(arg),
        ),
      ),
    ).toBe(false);
  });
}

test("loss of ancestry proof during apply refuses fast-forward", async () => {
  const { source, distribution } = sourceLinkedInstallation();
  publishNextRevision(source);
  const runner = new InterceptRunner();
  const service = managed(runner);
  const plan = await service.plan(distribution);
  let fetched = false;
  runner.intercept = async (command) => {
    if (command.includes("fetch")) fetched = true;
    if (fetched && command.includes("merge-base")) return commandFailure;
    return undefined;
  };
  const result = await service.apply({
    distributionRoot: distribution,
    approvedPlanHash: plan.planHash,
  });
  expect(result).toMatchObject({
    status: "failed",
    failedStep: "fast_forward",
    completedSteps: ["fetch"],
  });
  expect(runner.commands.some((command) => command.includes("merge"))).toBe(
    false,
  );
});

test("incoming tracked path conflict preserves untracked content without invalidating planning", async () => {
  const { source, distribution } = sourceLinkedInstallation();
  writeFileSync(join(source, "incoming.txt"), "remote");
  git(source, "add", "incoming.txt");
  git(source, "commit", "-m", "incoming path");
  git(source, "push", "origin", "main");
  const service = managed();
  const plan = await service.plan(distribution);
  writeFileSync(join(distribution, "incoming.txt"), "local untracked");
  expect((await service.plan(distribution)).planHash).toBe(plan.planHash);
  expect(
    await service.apply({
      distributionRoot: distribution,
      approvedPlanHash: plan.planHash,
    }),
  ).toMatchObject({ status: "failed", failedStep: "fast_forward" });
  expect(readFileSync(join(distribution, "incoming.txt"), "utf8")).toBe(
    "local untracked",
  );
});

test("remote URLs and credentials never appear in the plan or public errors", async () => {
  const { distribution } = sourceLinkedInstallation();
  const runner = new InterceptRunner();
  runner.intercept = async (command) => {
    if (
      (command[1] === "config" && command[3] === "remote.origin.url") ||
      (command[1] === "remote" && command[2] === "get-url")
    )
      return {
        exitCode: 0,
        stdout: "https://user:SECRET@example.invalid/repo.git\n",
        stderr: "",
      };
    return undefined;
  };
  const plan = await managed(runner).plan(distribution);
  expect(JSON.stringify(plan)).not.toMatch(/SECRET|example\.invalid|https:/);
  expect(plan.upstream.identity).toMatch(/^sha256:[a-f0-9]{64}$/);
});

for (const fault of [
  "merge reports failure after advancing",
  "HEAD unreadable after merge",
  "install runner throws",
] as const) {
  test(`${fault} remains partial without a fabricated rollback`, async () => {
    const { source, distribution } = sourceLinkedInstallation();
    const target = publishNextRevision(source);
    const runner = new InterceptRunner();
    const service = managed(runner);
    const plan = await service.plan(distribution);
    let merged = false;
    runner.intercept = async (command, cwd) => {
      if (command.includes("merge")) {
        const result = await new GitWithFakeBunRunner().run(command, cwd);
        merged = true;
        return fault === "merge reports failure after advancing"
          ? commandFailure
          : result;
      }
      if (
        fault === "HEAD unreadable after merge" &&
        merged &&
        command[1] === "rev-parse" &&
        command[2] === "HEAD"
      )
        return commandFailure;
      if (fault === "install runner throws" && command[1] === "install")
        throw new Error("SECRET raw subprocess failure");
      return undefined;
    };
    const result = await service.apply({
      distributionRoot: distribution,
      approvedPlanHash: plan.planHash,
    });
    expect(result).toMatchObject({
      status: "partial",
      toRevision: fault === "HEAD unreadable after merge" ? null : target,
    });
    expect(git(distribution, "rev-parse", "HEAD")).toBe(target);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

test("Git never overwrites ignored untracked data on an incoming path", async () => {
  const { source, distribution } = sourceLinkedInstallation();
  writeFileSync(
    join(distribution, ".git", "info", "exclude"),
    "private-state.txt\n",
  );
  writeFileSync(join(distribution, "private-state.txt"), "local state");
  writeFileSync(join(source, "private-state.txt"), "incoming tracked content");
  git(source, "add", "private-state.txt");
  git(source, "commit", "-m", "incoming ignored collision");
  git(source, "push", "origin", "main");
  const service = managed();
  const plan = await service.plan(distribution);
  expect(
    await service.apply({
      distributionRoot: distribution,
      approvedPlanHash: plan.planHash,
    }),
  ).toMatchObject({ status: "failed", failedStep: "fast_forward" });
  expect(readFileSync(join(distribution, "private-state.txt"), "utf8")).toBe(
    "local state",
  );
});

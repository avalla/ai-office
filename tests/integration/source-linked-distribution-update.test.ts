import { afterEach, describe, expect, test } from "vitest";
import {
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
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
    );

    const plan = await service.plan(distribution);
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

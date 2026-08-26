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
import { join } from "node:path";
import {
  LocalDistributionUpdateAdapter,
  type DistributionCommandResult,
  type DistributionCommandRunner,
} from "../../apps/cli/src/local-distribution-update-adapter.ts";
import { ManageDistributionUpdate } from "@ai-office/application/runtime/manage-distribution-update.ts";

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
    const targetRevision = publishNextRevision(source);
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
        sourceRef: "refs/heads/main",
        trackingRef: "refs/remotes/origin/main",
      },
      targetRevision,
      updateAvailable: true,
      preserves: ["runtime_state", "global_memory", "project_bindings"],
    });
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

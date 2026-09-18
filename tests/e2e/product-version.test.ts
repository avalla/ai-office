import { afterEach, describe, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { runtimeCommandHelp } from "@ai-office/command-support/help.ts";
import {
  displayVersion,
  isLocalVersionInvocation,
  productVersion,
} from "@ai-office/command-support/version.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ao-version-")));
  roots.push(root);
  return root;
}

const repositorySelectionVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

function cleanEnvironment(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const name of repositorySelectionVariables) delete env[name];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=AI Office Test",
      "-c",
      "user.email=ai-office@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: cleanEnvironment(), stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function repositoryWithCommit(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--initial-branch=main");
  writeFileSync(join(path, "notes.txt"), "one\n");
  git(path, "add", "notes.txt");
  git(path, "commit", "-m", "initial");
  return git(path, "rev-parse", "HEAD");
}

/** A runnable copy of the distribution; packages and dependencies are shared. */
function copyDistribution(path: string): void {
  mkdirSync(path, { recursive: true });
  for (const name of ["bin", "apps"])
    cpSync(resolve(name), join(path, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json"])
    cpSync(resolve(name), join(path, name));
  linkSharedModules(path);
}

function linkSharedModules(path: string): void {
  for (const name of ["packages", "node_modules"])
    symlinkSync(resolve(name), join(path, name), "dir");
}

/** A source-linked checkout whose tracked files are the copied distribution. */
function sourceCheckout(root: string, name = "distribution") {
  const path = join(root, name);
  copyDistribution(path);
  // Shared modules stay untracked, which also proves untracked never dirties.
  writeFileSync(join(path, ".gitignore"), "/packages\n/node_modules\n");
  writeFileSync(join(path, "notes.txt"), "one\n");
  git(path, "init", "--initial-branch=main");
  git(path, "add", ".gitignore", "bin", "apps", "notes.txt", "package.json");
  git(path, "add", "tsconfig.json");
  git(path, "commit", "-m", "distribution");
  return { path, head: git(path, "rev-parse", "HEAD") };
}

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
  /** Every subprocess the launcher started, recorded by the preload. */
  commands: string[][];
}

const entries = ["bin/ai-office.ts", "apps/cli/src/main.ts"] as const;

function harness(root: string) {
  const runtimeHome = join(root, "personal");
  const spawnLog = join(root, "spawn.log");
  const preload = join(root, "forbid-runtime.ts");
  writeFileSync(
    preload,
    `
    import { mock } from "bun:test";
    import { appendFileSync } from "node:fs";
    const forbidden = () => { console.error("FORBIDDEN_RUNTIME_ACCESS"); process.exit(97); };
    mock.module(${JSON.stringify(resolve("packages/runtime-paths/src/runtime-paths.ts"))}, () => ({
      RuntimePathError: class RuntimePathError extends Error {},
      resolveRuntimePaths: forbidden,
      legacyCheckoutDatabasePath: forbidden,
      withRuntimePathOverrides: forbidden,
      ensureRuntimeHome: forbidden,
    }));
    mock.module("bun:sqlite", () => ({ Database: class Database { constructor() { forbidden(); } } }));
    globalThis.fetch = forbidden;
    Bun.connect = forbidden;
    const spawn = Bun.spawn;
    Bun.spawn = (command, ...rest) => {
      appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(command) + "\\n");
      return spawn.call(Bun, command, ...rest);
    };
  `,
  );
  async function invoke(
    distribution: string,
    entry: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<Invocation> {
    rmSync(spawnLog, { force: true });
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(distribution, entry),
        ...args,
      ],
      {
        cwd: options.cwd ?? root,
        env: {
          ...cleanEnvironment(),
          AI_OFFICE_HOME: runtimeHome,
          AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "",
          ...options.env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const result = {
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
    const commands = existsSync(spawnLog)
      ? readFileSync(spawnLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as string[])
      : [];
    expect(existsSync(runtimeHome)).toBe(false);
    return { ...result, commands };
  }
  return { invoke };
}

const revisionCommand = ["git", "rev-parse", "--show-toplevel"];
const headCommand = ["git", "rev-parse", "HEAD"];
const statusCommand = [
  "git",
  "status",
  "--porcelain=v1",
  "--untracked-files=no",
];

function reportOf(invocation: Invocation) {
  expect(invocation.code).toBe(0);
  expect(invocation.stderr).toBe("");
  expect(invocation.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(invocation.stdout) as Record<string, unknown>;
}

test("productVersion is derived from the root package.json", () => {
  const manifest = JSON.parse(
    readFileSync(resolve("package.json"), "utf8"),
  ) as {
    version: string;
  };
  expect(productVersion).toBe(manifest.version);
  expect(productVersion).toMatch(/^\d+\.\d+\.\d+$/);
});

test("product version stays local in both launchers and the reusable client", async () => {
  const root = temporaryRoot();
  const { invoke } = harness(root);
  const repository = resolve(".");
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repository,
    env: cleanEnvironment(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const expected = displayVersion(
    productVersion,
    head.exitCode === 0 ? head.stdout.toString().trim() : null,
  );
  for (const flag of ["--version", "-V"]) {
    for (const entry of entries) {
      const child = await invoke(repository, entry, [flag], {
        env: { AI_OFFICE_HOME: join(root, "personal") },
      });
      expect(child).toMatchObject({
        code: 0,
        stdout: `${expected}\n`,
        stderr: "",
      });
    }
    const output: string[] = [];
    expect(
      await runRuntimeCli([flag], {
        io: {
          stdout: (line) => output.push(line),
          stderr: () => {
            throw new Error("Unexpected stderr");
          },
        },
        get runtimePaths(): never {
          throw new Error("Runtime paths accessed");
        },
        get runtimeClient(): never {
          throw new Error("Runtime client accessed");
        },
      }),
    ).toBe(0);
    // Without a distribution root there is no authoritative revision.
    expect(output).toEqual([productVersion]);
  }
});

test("projectRoot is never source-identity provenance; only distributionRoot is", async () => {
  const root = temporaryRoot();
  const { path: distribution, head: distributionHead } = sourceCheckout(root);
  const userProject = join(root, "user-project");
  const userProjectHead = repositoryWithCommit(userProject);
  expect(userProjectHead).not.toBe(distributionHead);

  const run = async (args: string[], distributionRoot?: string) => {
    const output: string[] = [];
    const code = await runRuntimeCli(args, {
      projectRoot: userProject,
      workingDirectory: userProject,
      ...(distributionRoot === undefined ? {} : { distributionRoot }),
      io: {
        stdout: (line) => output.push(line),
        stderr: () => {
          throw new Error("Unexpected stderr");
        },
      },
      get runtimePaths(): never {
        throw new Error("Runtime paths accessed");
      },
      get runtimeClient(): never {
        throw new Error("Runtime client accessed");
      },
    });
    return { code, output };
  };

  // No distribution root: the user project's SHA must not leak into the version.
  for (const flag of ["--version", "-V"])
    expect(await run([flag])).toEqual({ code: 0, output: [productVersion] });
  const unknown = await run(["version", "--json"]);
  expect(unknown.code).toBe(0);
  expect(JSON.parse(unknown.output.join("\n"))).toMatchObject({
    version: productVersion,
    displayVersion: productVersion,
    revision: null,
    dirty: null,
    distribution: null,
  });

  // An explicit distribution root reports only its own revision.
  expect(await run(["--version"], distribution)).toEqual({
    code: 0,
    output: [`${productVersion}+git.${distributionHead.slice(0, 12)}`],
  });
  const known = await run(["version", "--json"], distribution);
  expect(JSON.parse(known.output.join("\n"))).toMatchObject({
    revision: distributionHead,
    dirty: false,
    distribution: "source-linked",
  });
  expect(known.output.join("\n")).not.toContain(userProjectHead);
});

describe("source-linked revision reporting", () => {
  test("--version and -V append the 12-character revision from any working directory", async () => {
    const root = temporaryRoot();
    const { invoke } = harness(root);
    const { path, head } = sourceCheckout(root);
    expect(statSync(join(path, ".git")).isDirectory()).toBe(true);
    const expected = `${productVersion}+git.${head.slice(0, 12)}\n`;
    expect(expected).toMatch(/^\d+\.\d+\.\d+\+git\.[0-9a-f]{12}\n$/);

    for (const flag of ["--version", "-V"])
      for (const entry of entries) {
        const result = await invoke(path, entry, [flag]);
        expect(result).toMatchObject({ code: 0, stdout: expected, stderr: "" });
        // Cheap and local: no status walk, branch, upstream or network command.
        expect(result.commands).toEqual([revisionCommand, headCommand]);
      }
  });

  test("resolves the executable's checkout, not the working directory or ambient Git selection", async () => {
    const root = temporaryRoot();
    const { invoke } = harness(root);
    const { path, head } = sourceCheckout(root);
    const other = join(root, "other");
    const otherHead = repositoryWithCommit(other);
    const expected = `${productVersion}+git.${head.slice(0, 12)}\n`;
    expect(otherHead).not.toBe(head);

    expect(
      (await invoke(path, entries[0], ["--version"], { cwd: other })).stdout,
    ).toBe(expected);
    expect((await invoke(path, entries[0], ["-V"], { cwd: path })).stdout).toBe(
      expected,
    );
    // A Git hook or wrapper may export repository selection variables.
    expect(
      (
        await invoke(path, entries[0], ["--version"], {
          cwd: other,
          env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other },
        })
      ).stdout,
    ).toBe(expected);
    expect(
      reportOf(
        await invoke(path, entries[0], ["version", "--json"], {
          cwd: other,
          env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other },
        }),
      ),
    ).toMatchObject({ revision: head });
  });

  test("version prints the full revision, distribution and dirty state", async () => {
    const root = temporaryRoot();
    const { invoke } = harness(root);
    const { path, head } = sourceCheckout(root);
    for (const entry of entries) {
      const text = await invoke(path, entry, ["version"]);
      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toBe(
        [
          `AI Office ${productVersion}`,
          `Revision: ${head}`,
          "Distribution: source-linked",
          "Dirty: no",
          "",
        ].join("\n"),
      );
      expect(text.commands).toEqual([
        revisionCommand,
        headCommand,
        statusCommand,
      ]);

      const json = await invoke(path, entry, ["version", "--json"]);
      expect(reportOf(json)).toEqual({
        contractVersion: 1,
        version: productVersion,
        displayVersion: `${productVersion}+git.${head.slice(0, 12)}`,
        revision: head,
        dirty: false,
        distribution: "source-linked",
      });
      expect(json.commands).toEqual([
        revisionCommand,
        headCommand,
        statusCommand,
      ]);
    }
  });

  test("dirty state follows tracked changes only and never enters the compact version", async () => {
    const root = temporaryRoot();
    const { invoke } = harness(root);
    const { path, head } = sourceCheckout(root);
    const compact = `${productVersion}+git.${head.slice(0, 12)}\n`;
    const dirty = async () =>
      reportOf(await invoke(path, entries[0], ["version", "--json"])).dirty;

    expect(await dirty()).toBe(false);

    writeFileSync(join(path, "untracked.txt"), "untracked\n");
    expect(await dirty()).toBe(false);
    rmSync(join(path, "untracked.txt"));

    writeFileSync(join(path, "notes.txt"), "modified\n");
    expect(await dirty()).toBe(true);
    expect((await invoke(path, entries[0], ["--version"])).stdout).toBe(
      compact,
    );
    const text = await invoke(path, entries[0], ["version"]);
    expect(text.stdout).toContain("Dirty: yes\n");
    git(path, "checkout", "--", "notes.txt");
    expect(await dirty()).toBe(false);

    writeFileSync(join(path, "notes.txt"), "staged\n");
    git(path, "add", "notes.txt");
    expect(await dirty()).toBe(true);
    expect((await invoke(path, entries[0], ["-V"])).stdout).toBe(compact);
  });

  test("supports a linked worktree whose .git is a file", async () => {
    const root = temporaryRoot();
    const { invoke } = harness(root);
    const { path, head } = sourceCheckout(root);
    const worktree = join(root, "worktree");
    git(path, "worktree", "add", "-b", "linked", worktree);
    linkSharedModules(worktree);
    git(worktree, "commit", "--allow-empty", "-m", "worktree only");
    const worktreeHead = git(worktree, "rev-parse", "HEAD");
    expect(statSync(join(worktree, ".git")).isFile()).toBe(true);
    expect(worktreeHead).not.toBe(head);

    const result = await invoke(worktree, entries[0], ["--version"], {
      cwd: path,
    });
    expect(result.stdout).toBe(
      `${productVersion}+git.${worktreeHead.slice(0, 12)}\n`,
    );
    expect(
      reportOf(
        await invoke(worktree, entries[0], ["version", "--json"], {
          cwd: path,
        }),
      ),
    ).toMatchObject({
      revision: worktreeHead,
      dirty: false,
      distribution: "source-linked",
    });
  });
});

describe("fail-soft revision reporting", () => {
  const unavailable = {
    contractVersion: 1,
    version: productVersion,
    displayVersion: productVersion,
    revision: null,
    dirty: null,
    distribution: null,
  };

  async function expectProductVersionOnly(
    root: string,
    distribution: string,
    options: { cwd?: string; env?: Record<string, string> } = {},
  ) {
    const { invoke } = harness(root);
    for (const entry of entries) {
      for (const flag of ["--version", "-V"])
        expect(
          await invoke(distribution, entry, [flag], options),
        ).toMatchObject({
          code: 0,
          stdout: `${productVersion}\n`,
          stderr: "",
        });
      const text = await invoke(distribution, entry, ["version"], options);
      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toBe(
        [
          `AI Office ${productVersion}`,
          "Revision: unavailable",
          "Distribution: unknown",
          "Dirty: unavailable",
          "",
        ].join("\n"),
      );
      expect(
        reportOf(
          await invoke(distribution, entry, ["version", "--json"], options),
        ),
      ).toEqual(unavailable);
    }
  }

  test("Git executable unavailable", async () => {
    const root = temporaryRoot();
    const { path } = sourceCheckout(root);
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    await expectProductVersionOnly(root, path, { env: { PATH: emptyBin } });
  });

  test("no Git metadata", async () => {
    const root = temporaryRoot();
    const path = join(root, "distribution");
    copyDistribution(path);
    await expectProductVersionOnly(root, path);
  });

  test("unreadable or corrupt Git metadata", async () => {
    const root = temporaryRoot();
    const { path } = sourceCheckout(root);
    rmSync(join(path, ".git"), { recursive: true, force: true });
    writeFileSync(join(path, ".git"), "gitdir: /nonexistent/ai-office\n");
    await expectProductVersionOnly(root, path);
  });

  test("a distribution nested in another repository never reports the enclosing revision", async () => {
    const root = temporaryRoot();
    const outer = join(root, "outer");
    repositoryWithCommit(outer);
    const path = join(outer, "vendor", "ai-office");
    copyDistribution(path);
    await expectProductVersionOnly(root, path, { cwd: outer });
  });
});

describe("local version command contract", () => {
  test("rejects unsupported arguments locally", async () => {
    const root = temporaryRoot();
    const { invoke } = harness(root);
    const { path } = sourceCheckout(root);
    expect(await invoke(path, entries[0], ["version", "extra"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "version only accepts --json\n",
    });
    expect(
      await invoke(path, entries[0], ["version", "--bogus"]),
    ).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Unknown option --bogus\n",
    });
    const json = await invoke(path, entries[0], ["version", "--json", "extra"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      contractVersion: 1,
      status: "failed",
      error: {
        code: "invalid_arguments",
        message: "version only accepts --json",
      },
    });
  });

  test("stays local in the reusable client and is documented in help", async () => {
    const root = temporaryRoot();
    const { path, head } = sourceCheckout(root);
    for (const distributionRoot of [path, undefined]) {
      const output: string[] = [];
      expect(
        await runRuntimeCli(["version", "--json"], {
          ...(distributionRoot === undefined ? {} : { distributionRoot }),
          io: {
            stdout: (line) => output.push(line),
            stderr: () => {
              throw new Error("Unexpected stderr");
            },
          },
          get runtimePaths(): never {
            throw new Error("Runtime paths accessed");
          },
          get runtimeClient(): never {
            throw new Error("Runtime client accessed");
          },
        }),
      ).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({
        contractVersion: 1,
        revision: distributionRoot === undefined ? null : head,
      });
    }
    expect(runtimeCommandHelp).toContain("version [--json]");
    expect(runtimeCommandHelp).toContain("--version, -V");
  });

  test("keeps versioned role commands out of the local version handler", () => {
    for (const args of [
      [],
      ["memory:role:create", "--version", "1"],
      ["memory:deprecate", "--type", "role", "--version", "2"],
      ["--version", "project:create", "Example"],
      ["-V", "unexpected"],
    ])
      expect(isLocalVersionInvocation(args)).toBe(false);
    for (const args of [
      ["--version"],
      ["-V"],
      ["version"],
      ["version", "--json"],
    ])
      expect(isLocalVersionInvocation(args)).toBe(true);
  });
});

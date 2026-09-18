import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSourceIdentity,
  inspectSourceRevision,
  readTrackedDirty,
  type DistributionCommandResult,
  type DistributionCommandRunner,
} from "../../apps/cli/src/distribution-source-identity.ts";
import { runVersionCli } from "../../apps/cli/src/version-cli.ts";
import {
  buildVersionReport,
  displayVersion,
  isGitRevision,
  productVersion,
  renderVersionReport,
  shortRevision,
} from "@ai-office/command-support/version.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const sha1 = "6fe106c41945909937466047926861f187bf32b8";
const sha256 = "ab".repeat(32);

function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "ao-identity-")));
  roots.push(path);
  return path;
}

/** Scripted runner keyed by the git arguments; unknown commands fail. */
class ScriptedRunner implements DistributionCommandRunner {
  readonly calls: string[] = [];
  constructor(
    private readonly script: Record<string, DistributionCommandResult | Error>,
  ) {}
  async run(command: readonly string[]): Promise<DistributionCommandResult> {
    const key = command.slice(1).join(" ");
    this.calls.push(command.join(" "));
    const answer = this.script[key];
    if (answer instanceof Error) throw answer;
    return answer ?? { exitCode: 128, stdout: "", stderr: "fatal" };
  }
}

const ok = (stdout: string): DistributionCommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

describe("revision formatting", () => {
  test("validates Git object names in one place", () => {
    expect(isGitRevision(sha1)).toBe(true);
    expect(isGitRevision(sha256)).toBe(true);
    for (const bad of [
      "",
      "unknown",
      sha1.slice(1),
      sha1.toUpperCase(),
      `${sha1}\n`,
      "g".repeat(40),
      "a".repeat(65),
    ])
      expect(isGitRevision(bad)).toBe(false);
  });

  test("compact form is the first 12 characters as SemVer build metadata", () => {
    expect(shortRevision(sha1)).toBe("6fe106c41945");
    expect(displayVersion("0.1.0", sha1)).toBe("0.1.0+git.6fe106c41945");
    expect(displayVersion("0.1.0", sha256)).toBe(
      `0.1.0+git.${sha256.slice(0, 12)}`,
    );
    // Build metadata, never a prerelease.
    expect(displayVersion("0.1.0", sha1)).not.toContain("-");
  });

  test("invents no metadata without an authoritative revision", () => {
    for (const revision of [null, "", "unknown", "abc123"])
      expect(displayVersion("0.1.0", revision)).toBe("0.1.0");
  });

  test("extends existing build metadata instead of producing invalid SemVer", () => {
    expect(displayVersion("1.2.3+build.7", sha1)).toBe(
      "1.2.3+build.7.git.6fe106c41945",
    );
  });
});

describe("version report", () => {
  test("has a stable machine-readable shape", () => {
    expect(
      buildVersionReport(
        { revision: sha1, dirty: false, distribution: "source-linked" },
        "0.1.0",
      ),
    ).toEqual({
      contractVersion: 1,
      version: "0.1.0",
      displayVersion: "0.1.0+git.6fe106c41945",
      revision: sha1,
      dirty: false,
      distribution: "source-linked",
    });
  });

  test("reports null rather than inventing values", () => {
    const report = buildVersionReport({
      revision: null,
      dirty: null,
      distribution: null,
    });
    expect(report).toEqual({
      contractVersion: 1,
      version: productVersion,
      displayVersion: productVersion,
      revision: null,
      dirty: null,
      distribution: null,
    });
    expect(renderVersionReport(report)).toEqual([
      `AI Office ${productVersion}`,
      "Revision: unavailable",
      "Distribution: unknown",
      "Dirty: unavailable",
    ]);
    // A malformed revision is discarded together with its unverifiable facts.
    expect(
      buildVersionReport({
        revision: "nope",
        dirty: true,
        distribution: "source-linked",
      }),
    ).toMatchObject({ revision: null, dirty: null, distribution: null });
  });

  test("keeps a known revision with an unavailable dirty state", () => {
    const report = buildVersionReport({
      revision: sha1,
      dirty: null,
      distribution: "source-linked",
    });
    expect(report).toMatchObject({ revision: sha1, dirty: null });
    expect(renderVersionReport(report)).toContain("Dirty: unavailable");
  });
});

describe("local source inspection", () => {
  test("reads only the checkout root, HEAD and tracked status", async () => {
    const path = root();
    const runner = new ScriptedRunner({
      "rev-parse --show-toplevel": ok(`${path}\n`),
      "rev-parse HEAD": ok(`${sha1}\n`),
      "status --porcelain=v1 --untracked-files=no": ok(""),
    });
    expect(await inspectSourceIdentity(path, runner)).toEqual({
      revision: sha1,
      dirty: false,
      distribution: "source-linked",
    });
    expect(runner.calls).toEqual([
      "git rev-parse --show-toplevel",
      "git rev-parse HEAD",
      "git status --porcelain=v1 --untracked-files=no",
    ]);
  });

  test("the revision-only path never walks the working tree", async () => {
    const path = root();
    const runner = new ScriptedRunner({
      "rev-parse --show-toplevel": ok(`${path}\n`),
      "rev-parse HEAD": ok(`${sha1}\n`),
    });
    expect(await inspectSourceRevision(path, runner)).toBe(sha1);
    expect(runner.calls).toHaveLength(2);
  });

  test("any tracked status output means dirty", async () => {
    const path = root();
    for (const [stdout, dirty] of [
      [" M notes.txt\n", true],
      ["M  notes.txt\n", true],
      ["", false],
    ] as const)
      expect(
        await readTrackedDirty(
          new ScriptedRunner({
            "status --porcelain=v1 --untracked-files=no": ok(stdout),
          }),
          path,
        ),
      ).toEqual({ ok: true, value: dirty });
  });

  test("a status failure keeps the revision and reports dirty as unknown", async () => {
    const path = root();
    expect(
      await inspectSourceIdentity(
        path,
        new ScriptedRunner({
          "rev-parse --show-toplevel": ok(path),
          "rev-parse HEAD": ok(sha1),
        }),
      ),
    ).toEqual({ revision: sha1, dirty: null, distribution: "source-linked" });
  });

  test.each([
    ["Git is unavailable", new Error("spawn git ENOENT")],
    ["the checkout is not recognized", undefined],
  ])("returns no identity when %s", async (_name, failure) => {
    const path = root();
    const runner = new ScriptedRunner(
      failure === undefined
        ? {}
        : {
            "rev-parse --show-toplevel": failure,
            "rev-parse HEAD": failure,
          },
    );
    expect(await inspectSourceIdentity(path, runner)).toEqual({
      revision: null,
      dirty: null,
      distribution: null,
    });
  });

  test("rejects a checkout root that is not the distribution root", async () => {
    const path = root();
    const enclosing = root();
    const runner = new ScriptedRunner({
      "rev-parse --show-toplevel": ok(enclosing),
      "rev-parse HEAD": ok(sha1),
    });
    expect(await inspectSourceRevision(path, runner)).toBeNull();
    expect(runner.calls).not.toContain("git rev-parse HEAD");
  });

  test("rejects malformed HEAD output", async () => {
    const path = root();
    expect(
      await inspectSourceRevision(
        path,
        new ScriptedRunner({
          "rev-parse --show-toplevel": ok(path),
          "rev-parse HEAD": ok("HEAD\n"),
        }),
      ),
    ).toBeNull();
  });

  test("returns no identity for a missing distribution root", async () => {
    const runner = new ScriptedRunner({});
    expect(
      await inspectSourceRevision(join(root(), "missing"), runner),
    ).toBeNull();
    expect(runner.calls).toEqual([]);
  });
});

describe("version CLI failure semantics", () => {
  function capture() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      io: {
        stdout: (message: string) => stdout.push(message),
        stderr: (message: string) => stderr.push(message),
      },
    };
  }

  test("prints the product version with exit 0 even when inspection throws", async () => {
    const path = root();
    const output = capture();
    const runner: DistributionCommandRunner = {
      run: () => {
        throw new Error("boom");
      },
    };
    for (const args of [["--version"], ["-V"]])
      expect(
        await runVersionCli(args, {
          distributionRoot: path,
          io: output.io,
          runner,
        }),
      ).toBe(0);
    expect(output.stdout).toEqual([productVersion, productVersion]);
    expect(output.stderr).toEqual([]);
  });

  test("uses the injected identity for the compact version", async () => {
    const path = root();
    const output = capture();
    const runner = new ScriptedRunner({
      "rev-parse --show-toplevel": ok(path),
      "rev-parse HEAD": ok(sha1),
    });
    expect(
      await runVersionCli(["--version"], {
        distributionRoot: path,
        io: output.io,
        runner,
      }),
    ).toBe(0);
    expect(output.stdout).toEqual([`${productVersion}+git.6fe106c41945`]);
  });
});

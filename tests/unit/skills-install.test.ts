import { afterEach, describe, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSkills,
  runInstallCli,
  type InstallReport,
} from "../../scripts/skills/install.ts";
import {
  SkillPackageError,
  contentHash,
  installManifestName,
  listFiles,
  repositoryRoot,
} from "../../scripts/skills/shared.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "skills-install-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** An isolated copy of the canonical skills plus an empty installation root. */
function workspace(): { sourceRoot: string; targetRoot: string } {
  const root = temporaryDirectory();
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  cpSync(join(repositoryRoot, "skills"), join(sourceRoot, "skills"), {
    recursive: true,
  });
  mkdirSync(targetRoot);
  return { sourceRoot, targetRoot };
}

const claudeCopy = (targetRoot: string): string =>
  join(targetRoot, ".claude", "skills", "task-delivery");
const agentsCopy = (targetRoot: string): string =>
  join(targetRoot, ".agents", "skills", "task-delivery");

function changedPaths(report: InstallReport): string[] {
  return report.targets.flatMap((target) =>
    target.changes.map(
      (change) => `${target.target.id}:${change.kind}:${change.path}`,
    ),
  );
}

function conflicts(report: InstallReport): string[] {
  return report.targets.flatMap((target) => target.conflicts);
}

function captureOutput(): {
  lines: string[];
  log(line: string): void;
  error(line: string): void;
} {
  const lines: string[] = [];
  return {
    lines,
    log: (line) => void lines.push(line),
    error: (line) => void lines.push(line),
  };
}

describe("skill installer", () => {
  test("installs identical copies for every executor into a clean repository", () => {
    const { sourceRoot, targetRoot } = workspace();
    const canonical = join(sourceRoot, "skills", "task-delivery");

    const report = installSkills({ sourceRoot, targetRoot });

    expect(report).toMatchObject({ ok: true, applied: true });
    const canonicalFiles = listFiles(canonical);
    for (const copy of [claudeCopy(targetRoot), agentsCopy(targetRoot)]) {
      expect(listFiles(copy)).toEqual(
        [...canonicalFiles, installManifestName].sort(),
      );
      for (const file of canonicalFiles)
        expect(readFileSync(join(copy, file))).toEqual(
          readFileSync(join(canonical, file)),
        );
    }
    // No stray temporary files are left behind.
    expect(
      listFiles(targetRoot).filter((file) => file.includes(".tmp-")),
    ).toEqual([]);
  });

  test("is idempotent: a second run changes nothing", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    const before = listFiles(targetRoot).map((file) => [
      file,
      readFileSync(join(targetRoot, file), "utf8"),
    ]);

    const second = installSkills({ sourceRoot, targetRoot });

    expect(second).toMatchObject({ ok: true, applied: false });
    expect(changedPaths(second)).toEqual([]);
    expect(
      listFiles(targetRoot).map((file) => [
        file,
        readFileSync(join(targetRoot, file), "utf8"),
      ]),
    ).toEqual(before);
  });

  test("check passes after install and never writes", () => {
    const { sourceRoot, targetRoot } = workspace();

    const beforeInstall = installSkills({
      sourceRoot,
      targetRoot,
      check: true,
    });
    expect(beforeInstall).toMatchObject({ ok: false, applied: false });
    expect(existsSync(join(targetRoot, ".claude"))).toBe(false);
    expect(existsSync(join(targetRoot, ".agents"))).toBe(false);

    installSkills({ sourceRoot, targetRoot });
    expect(
      installSkills({ sourceRoot, targetRoot, check: true }),
    ).toMatchObject({ ok: true, applied: false });
  });

  test("check detects a copy that lags behind the canonical source", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    const canonicalFile = join(
      sourceRoot,
      "skills",
      "task-delivery",
      "references",
      "qa-checklist.md",
    );
    writeFileSync(
      canonicalFile,
      `${readFileSync(canonicalFile, "utf8")}\nNew canonical line.\n`,
    );

    const check = installSkills({ sourceRoot, targetRoot, check: true });
    expect(check.ok).toBe(false);
    expect(changedPaths(check)).toEqual(
      expect.arrayContaining([
        "claude:update:references/qa-checklist.md",
        "agents:update:references/qa-checklist.md",
      ]),
    );

    // The copies are untouched managed files, so install updates them.
    expect(installSkills({ sourceRoot, targetRoot })).toMatchObject({
      ok: true,
      applied: true,
    });
    expect(
      readFileSync(
        join(claudeCopy(targetRoot), "references", "qa-checklist.md"),
        "utf8",
      ),
    ).toContain("New canonical line.");
    expect(installSkills({ sourceRoot, targetRoot, check: true }).ok).toBe(
      true,
    );
  });

  test("removes managed files that left the canonical source", () => {
    const { sourceRoot, targetRoot } = workspace();
    const canonical = join(sourceRoot, "skills", "task-delivery");
    const skillPath = join(canonical, "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    writeFileSync(join(canonical, "references", "extra.md"), "# Extra\n");
    writeFileSync(
      skillPath,
      original.replace(
        "## Reporting",
        "See [extra](references/extra.md).\n\n## Reporting",
      ),
    );
    installSkills({ sourceRoot, targetRoot });
    expect(
      existsSync(join(agentsCopy(targetRoot), "references", "extra.md")),
    ).toBe(true);

    rmSync(join(canonical, "references", "extra.md"));
    writeFileSync(skillPath, original);
    expect(installSkills({ sourceRoot, targetRoot }).ok).toBe(true);

    expect(
      existsSync(join(agentsCopy(targetRoot), "references", "extra.md")),
    ).toBe(false);
    expect(installSkills({ sourceRoot, targetRoot, check: true }).ok).toBe(
      true,
    );
  });

  test("refuses to overwrite a locally modified copy unless forced", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    const edited = join(claudeCopy(targetRoot), "SKILL.md");
    writeFileSync(edited, "locally edited\n");

    const check = installSkills({ sourceRoot, targetRoot, check: true });
    expect(check.ok).toBe(false);
    expect(conflicts(check)).toEqual([
      expect.stringContaining("SKILL.md was modified after installation"),
    ]);

    const refused = installSkills({ sourceRoot, targetRoot });
    expect(refused).toMatchObject({ ok: false, applied: false });
    expect(readFileSync(edited, "utf8")).toBe("locally edited\n");

    const forced = installSkills({ sourceRoot, targetRoot, force: true });
    expect(forced).toMatchObject({ ok: true, applied: true });
    expect(readFileSync(edited, "utf8")).toBe(
      readFileSync(
        join(sourceRoot, "skills", "task-delivery", "SKILL.md"),
        "utf8",
      ),
    );
  });

  test("a conflict in one target leaves every target untouched", () => {
    const { sourceRoot, targetRoot } = workspace();
    mkdirSync(agentsCopy(targetRoot), { recursive: true });
    writeFileSync(join(agentsCopy(targetRoot), "SKILL.md"), "user skill\n");

    const report = installSkills({ sourceRoot, targetRoot });

    expect(report).toMatchObject({ ok: false, applied: false });
    expect(conflicts(report)).toEqual([
      expect.stringContaining(
        "differs from the canonical skill, and was not installed by this installer",
      ),
    ]);
    expect(existsSync(claudeCopy(targetRoot))).toBe(false);
    expect(readFileSync(join(agentsCopy(targetRoot), "SKILL.md"), "utf8")).toBe(
      "user skill\n",
    );
  });

  test("force adopts an unmanaged directory but never deletes foreign files", () => {
    const { sourceRoot, targetRoot } = workspace();
    mkdirSync(agentsCopy(targetRoot), { recursive: true });
    writeFileSync(join(agentsCopy(targetRoot), "SKILL.md"), "user skill\n");
    writeFileSync(join(agentsCopy(targetRoot), "notes.md"), "my notes\n");

    const blocked = installSkills({ sourceRoot, targetRoot, force: true });
    expect(blocked).toMatchObject({ ok: false, applied: false });
    expect(conflicts(blocked)).toEqual([
      expect.stringContaining("notes.md is not managed by the installer"),
    ]);
    expect(readFileSync(join(agentsCopy(targetRoot), "notes.md"), "utf8")).toBe(
      "my notes\n",
    );

    rmSync(join(agentsCopy(targetRoot), "notes.md"));
    expect(
      installSkills({ sourceRoot, targetRoot, force: true }),
    ).toMatchObject({ ok: true, applied: true });
    expect(installSkills({ sourceRoot, targetRoot, check: true }).ok).toBe(
      true,
    );
  });

  test("reports an unmanaged file added to an installed copy", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    writeFileSync(join(claudeCopy(targetRoot), "local.md"), "local\n");

    const check = installSkills({ sourceRoot, targetRoot, check: true });

    expect(check.ok).toBe(false);
    expect(conflicts(check)).toEqual([
      expect.stringContaining("local.md is not managed by the installer"),
    ]);
  });

  test("accepts existing parent directories and unrelated sibling skills", () => {
    const { sourceRoot, targetRoot } = workspace();
    const sibling = join(targetRoot, ".claude", "skills", "other", "SKILL.md");
    mkdirSync(join(targetRoot, ".claude", "skills", "other"), {
      recursive: true,
    });
    writeFileSync(sibling, "unrelated\n");
    mkdirSync(agentsCopy(targetRoot), { recursive: true });

    expect(installSkills({ sourceRoot, targetRoot })).toMatchObject({
      ok: true,
      applied: true,
    });
    expect(readFileSync(sibling, "utf8")).toBe("unrelated\n");
  });

  test("restores a deleted managed file without treating it as a conflict", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    rmSync(join(claudeCopy(targetRoot), "assets", "pr-template.md"));

    expect(installSkills({ sourceRoot, targetRoot, check: true }).ok).toBe(
      false,
    );
    const repaired = installSkills({ sourceRoot, targetRoot });
    expect(repaired).toMatchObject({ ok: true, applied: true });
    expect(changedPaths(repaired)).toEqual([
      "claude:create:assets/pr-template.md",
    ]);
  });

  test("treats CRLF and LF checkouts of the same content as in sync", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    for (const copy of [claudeCopy(targetRoot), agentsCopy(targetRoot)])
      for (const file of listFiles(copy))
        writeFileSync(
          join(copy, file),
          readFileSync(join(copy, file), "utf8").replace(/\n/gu, "\r\n"),
        );

    expect(installSkills({ sourceRoot, targetRoot, check: true }).ok).toBe(
      true,
    );
  });

  test("refuses to write through a symbolic link", () => {
    const { sourceRoot, targetRoot } = workspace();
    const outside = temporaryDirectory();
    symlinkSync(outside, join(targetRoot, ".claude"));

    const report = installSkills({ sourceRoot, targetRoot });

    expect(report).toMatchObject({ ok: false, applied: false });
    expect(conflicts(report)).toEqual([
      expect.stringContaining(".claude is a symbolic link"),
    ]);
    expect(listFiles(outside)).toEqual([]);
    expect(existsSync(join(targetRoot, ".agents"))).toBe(false);
  });

  test("adopts an identical copy that lost its manifest without force", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    rmSync(join(claudeCopy(targetRoot), installManifestName));

    const report = installSkills({ sourceRoot, targetRoot });

    expect(report).toMatchObject({ ok: true, applied: true });
    expect(changedPaths(report)).toEqual([
      `claude:create:${installManifestName}`,
    ]);
  });

  test.each([
    ["corrupt", "{ not json"],
    [
      "for another skill",
      JSON.stringify({ schemaVersion: 1, skill: "other", files: {} }),
    ],
  ])(
    "a %s manifest does not make a modified directory managed",
    (_label, manifest) => {
      const { sourceRoot, targetRoot } = workspace();
      installSkills({ sourceRoot, targetRoot });
      writeFileSync(
        join(claudeCopy(targetRoot), installManifestName),
        manifest,
      );
      writeFileSync(join(claudeCopy(targetRoot), "SKILL.md"), "edited\n");

      const report = installSkills({ sourceRoot, targetRoot });

      expect(report).toMatchObject({ ok: false, applied: false });
      expect(conflicts(report)).toEqual([
        expect.stringContaining("was not installed by this installer"),
      ]);
      expect(
        readFileSync(join(claudeCopy(targetRoot), "SKILL.md"), "utf8"),
      ).toBe("edited\n");
    },
  );

  test("manifest entries pointing outside the copy are inert", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    const victim = join(targetRoot, "victim.txt");
    writeFileSync(victim, "keep me\n");
    const manifestPath = join(claudeCopy(targetRoot), installManifestName);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
    };
    manifest.files["../../../victim.txt"] = contentHash(
      Buffer.from("keep me\n"),
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(installSkills({ sourceRoot, targetRoot, force: true }).ok).toBe(
      true,
    );
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  test("reports a directory where a file must be written, before writing anything", () => {
    const { sourceRoot, targetRoot } = workspace();
    mkdirSync(join(claudeCopy(targetRoot), "references", "lifecycle.md"), {
      recursive: true,
    });
    mkdirSync(join(agentsCopy(targetRoot), installManifestName), {
      recursive: true,
    });

    const report = installSkills({ sourceRoot, targetRoot, force: true });

    expect(report).toMatchObject({ ok: false, applied: false });
    expect(conflicts(report)).toEqual([
      "references/lifecycle.md exists and is not a regular file; remove or move it",
      `${installManifestName} exists and is not a regular file; remove or move it`,
    ]);
    expect(listFiles(targetRoot)).toEqual([]);
  });

  test("reports a file where a directory is expected instead of crashing", () => {
    const { sourceRoot, targetRoot } = workspace();
    mkdirSync(claudeCopy(targetRoot), { recursive: true });
    writeFileSync(join(claudeCopy(targetRoot), "references"), "x\n");

    for (const force of [false, true]) {
      const report = installSkills({ sourceRoot, targetRoot, force });
      expect(report).toMatchObject({ ok: false, applied: false });
      expect(conflicts(report)).toEqual([
        "references exists and is not a regular directory; remove or move it",
      ]);
    }
    expect(existsSync(agentsCopy(targetRoot))).toBe(false);
  });

  test("tolerates plain files beside the installed skills", () => {
    const { sourceRoot, targetRoot } = workspace();
    for (const directory of [".claude", ".agents"]) {
      mkdirSync(join(targetRoot, directory, "skills"), { recursive: true });
      writeFileSync(join(targetRoot, directory, "skills", ".DS_Store"), "x");
      writeFileSync(join(targetRoot, directory, "skills", "README.md"), "x");
    }

    expect(installSkills({ sourceRoot, targetRoot })).toMatchObject({
      ok: true,
      applied: true,
    });
    // Same repository as the source, where orphan detection is active.
    installSkills({ sourceRoot });
    writeFileSync(join(sourceRoot, ".claude", "skills", ".gitkeep"), "");
    expect(installSkills({ sourceRoot, check: true })).toMatchObject({
      ok: true,
      orphans: [],
    });
  });

  test("refuses a symbolic link inside an installed copy", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    const outside = join(temporaryDirectory(), "outside.md");
    writeFileSync(outside, "outside\n");
    const linked = join(claudeCopy(targetRoot), "references", "lifecycle.md");
    rmSync(linked);
    symlinkSync(outside, linked);

    const report = installSkills({ sourceRoot, targetRoot, force: true });

    expect(report).toMatchObject({ ok: false, applied: false });
    expect(conflicts(report)).toEqual([
      expect.stringContaining("symbolic link"),
    ]);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("force removes a modified managed file that left the canonical source", () => {
    const { sourceRoot, targetRoot } = workspace();
    const canonical = join(sourceRoot, "skills", "task-delivery");
    const skillPath = join(canonical, "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    writeFileSync(join(canonical, "references", "extra.md"), "# Extra\n");
    writeFileSync(
      skillPath,
      original.replace(
        "## Reporting",
        "See [extra](references/extra.md).\n\n## Reporting",
      ),
    );
    installSkills({ sourceRoot, targetRoot });
    rmSync(join(canonical, "references", "extra.md"));
    writeFileSync(skillPath, original);
    const edited = join(claudeCopy(targetRoot), "references", "extra.md");
    writeFileSync(edited, "# Extra, edited\n");

    const refused = installSkills({ sourceRoot, targetRoot });
    expect(refused).toMatchObject({ ok: false, applied: false });
    expect(existsSync(edited)).toBe(true);

    expect(
      installSkills({ sourceRoot, targetRoot, force: true }),
    ).toMatchObject({ ok: true, applied: true });
    expect(existsSync(edited)).toBe(false);
  });

  test("file names that shadow object properties are ordinary unmanaged files", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    writeFileSync(join(claudeCopy(targetRoot), "constructor"), "x\n");

    for (const force of [false, true]) {
      const report = installSkills({ sourceRoot, targetRoot, force });
      expect(report).toMatchObject({ ok: false, applied: false });
      expect(conflicts(report)).toEqual([
        expect.stringContaining("constructor is not managed by the installer"),
      ]);
    }
  });

  test("ignores operating-system files in installed copies", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot, targetRoot });
    writeFileSync(join(claudeCopy(targetRoot), ".DS_Store"), "junk");

    expect(installSkills({ sourceRoot, targetRoot, check: true }).ok).toBe(
      true,
    );
  });

  test("reports orphaned copies in the source repository and never deletes them", () => {
    const { sourceRoot, targetRoot } = workspace();
    installSkills({ sourceRoot });
    const installed = join(sourceRoot, ".agents", "skills");
    const orphan = join(installed, "old-skill");
    cpSync(join(installed, "task-delivery"), orphan, { recursive: true });
    // A user skill without a manifest is not an orphan.
    mkdirSync(join(installed, "mine"));
    writeFileSync(join(installed, "mine", "SKILL.md"), "mine\n");

    const check = installSkills({ sourceRoot, check: true });
    expect(check.ok).toBe(false);
    expect(check.orphans).toEqual([".agents/skills/old-skill"]);
    expect(installSkills({ sourceRoot }).orphans).toEqual([
      ".agents/skills/old-skill",
    ]);
    expect(existsSync(join(orphan, "SKILL.md"))).toBe(true);

    // In another repository the same copy may come from another source.
    installSkills({ sourceRoot, targetRoot });
    cpSync(orphan, join(targetRoot, ".agents", "skills", "old-skill"), {
      recursive: true,
    });
    expect(
      installSkills({ sourceRoot, targetRoot, check: true }),
    ).toMatchObject({ ok: true, orphans: [] });
  });

  test("content identity ignores line endings but not other bytes", () => {
    expect(contentHash(Buffer.from("a\r\nb\r\n"))).toBe(
      contentHash(Buffer.from("a\nb\n")),
    );
    expect(contentHash(Buffer.from([0xff]))).not.toBe(
      contentHash(Buffer.from([0xfe])),
    );
    // In a binary asset 0D 0A is data, not a line ending.
    expect(contentHash(Buffer.from([0xff, 0x0d, 0x0a]))).not.toBe(
      contentHash(Buffer.from([0xff, 0x0a])),
    );
    expect(contentHash(Buffer.from([0x00, 0x0d, 0x0a]))).not.toBe(
      contentHash(Buffer.from([0x00, 0x0a])),
    );
    expect(contentHash(Buffer.from("è"))).not.toBe(
      contentHash(Buffer.from("é")),
    );
  });

  test("installs only the requested scope", () => {
    const { sourceRoot, targetRoot } = workspace();

    installSkills({ sourceRoot, targetRoot, scopes: ["agents"] });

    expect(existsSync(agentsCopy(targetRoot))).toBe(true);
    expect(existsSync(join(targetRoot, ".claude"))).toBe(false);
  });

  test("fails on an unknown scope, a missing root, and an invalid source", () => {
    const { sourceRoot, targetRoot } = workspace();

    expect(() =>
      installSkills({ sourceRoot, targetRoot, scopes: ["nope"] }),
    ).toThrow(SkillPackageError);
    expect(() => installSkills({ sourceRoot, targetRoot, scopes: [] })).toThrow(
      /No installation scope was selected/u,
    );
    expect(() =>
      installSkills({ sourceRoot, targetRoot: join(targetRoot, "missing") }),
    ).toThrow(/Installation root is not a directory/u);
    expect(() => installSkills({ sourceRoot: targetRoot, targetRoot })).toThrow(
      /Canonical skills directory is missing/u,
    );

    writeFileSync(
      join(sourceRoot, "skills", "task-delivery", "SKILL.md"),
      "# No frontmatter\n",
    );
    expect(() => installSkills({ sourceRoot, targetRoot })).toThrow(
      /Canonical skill task-delivery is invalid/u,
    );
    expect(existsSync(join(targetRoot, ".claude"))).toBe(false);
  });
});

describe("skill installer CLI", () => {
  test("returns 0 on install and on a clean check, 1 on drift", () => {
    const targetRoot = temporaryDirectory();
    const output = captureOutput();

    expect(runInstallCli(["--root", targetRoot, "--check"], output)).toBe(1);
    expect(output.lines.join("\n")).toContain("OUT OF SYNC");
    expect(runInstallCli(["--root", targetRoot], output)).toBe(0);
    expect(runInstallCli(["--root", targetRoot, "--check"], output)).toBe(0);

    writeFileSync(join(claudeCopy(targetRoot), "SKILL.md"), "edited\n");
    expect(runInstallCli(["--root", targetRoot, "--check"], output)).toBe(1);
    expect(runInstallCli(["--root", targetRoot], output)).toBe(1);
    expect(output.lines.at(-1)).toContain("Nothing was written");
  });

  test("returns 2 on usage errors and 1 on an unusable root", () => {
    const output = captureOutput();

    expect(runInstallCli(["--bogus"], output)).toBe(2);
    expect(runInstallCli(["--root"], output)).toBe(2);
    expect(runInstallCli(["--scope", ","], output)).toBe(2);
    expect(runInstallCli(["--check", "--force"], output)).toBe(2);
    expect(
      runInstallCli(["--root", join(temporaryDirectory(), "missing")], output),
    ).toBe(1);
    expect(runInstallCli(["--help"], output)).toBe(0);
  });

  test("the bun entry point exits non-zero on drift", () => {
    const targetRoot = temporaryDirectory();
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "scripts/skills/install.ts",
        "--root",
        targetRoot,
        "--check",
      ],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("OUT OF SYNC");
  });
});

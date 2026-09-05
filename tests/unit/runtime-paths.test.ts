import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRuntimeHome,
  legacyCheckoutDatabasePath,
  resolveRuntimePaths,
  RuntimePathError,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // The path may have been removed by the test.
    }
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runtime path resolution", () => {
  test("uses one stable user runtime independent of distribution and repository roots", () => {
    const userHome = temporaryDirectory("ai-office-user-home-");
    const distributionA = temporaryDirectory("ai-office-dist-a-");
    const distributionB = temporaryDirectory("ai-office-dist-b-");
    const repositoryA = temporaryDirectory("ai-office-repo-a-");
    const repositoryB = temporaryDirectory("ai-office-repo-b-");

    const first = resolveRuntimePaths({
      mode: "user",
      userHome,
      environment: {},
    });
    const second = resolveRuntimePaths({
      mode: "user",
      userHome,
      environment: {},
      developmentRoot: repositoryA,
    });
    const third = resolveRuntimePaths({
      mode: "user",
      userHome,
      environment: {},
      developmentRoot: repositoryB,
    });

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first.runtimeHome).toBe(join(realpathSync(userHome), ".ai-office"));
    expect(first.projectDatabasePath).toBe(
      join(first.runtimeHome, "project.sqlite"),
    );
    expect(first.socketPath).toBe(join(first.runtimeHome, "daemon.sock"));
    expect(first.globalDatabasePath).toBe(
      join(first.runtimeHome, "global.sqlite"),
    );
    expect(legacyCheckoutDatabasePath(distributionA, first)).toBeNull();
    expect(legacyCheckoutDatabasePath(distributionB, first)).toBeNull();
  });

  test("honors and canonicalizes the explicit AI_OFFICE_HOME override", () => {
    const workspace = temporaryDirectory("ai-office-home-override-");
    const selected = join(workspace, "data");
    mkdirSync(selected);
    const paths = resolveRuntimePaths({
      mode: "user",
      userHome: join(workspace, "unused-home"),
      environment: { AI_OFFICE_HOME: join(workspace, "nested", "..", "data") },
    });

    expect(paths.runtimeHome).toBe(realpathSync(selected));
    expect(paths.socketPath).toBe(join(realpathSync(selected), "daemon.sock"));
  });

  test("keeps the checkout-local runtime only in explicit development mode", () => {
    const workspace = temporaryDirectory("ai-office-development-home-");
    const developmentRoot = join(workspace, "distribution");
    mkdirSync(developmentRoot);
    const paths = resolveRuntimePaths({
      mode: "development",
      developmentRoot,
      userHome: join(workspace, "user"),
      environment: { AI_OFFICE_HOME: join(workspace, "ignored") },
    });

    expect(paths.runtimeHome).toBe(
      join(realpathSync(developmentRoot), ".ai-office"),
    );
    expect(paths.globalDatabasePath).toBe(
      join(paths.runtimeHome, "global.sqlite"),
    );
  });

  test("rejects a file, a symlink, and an unwritable runtime home", () => {
    const workspace = temporaryDirectory("ai-office-invalid-home-");
    const file = join(workspace, "file");
    const directory = join(workspace, "directory");
    const link = join(workspace, "link");
    const unwritable = join(workspace, "unwritable");
    writeFileSync(file, "not a directory");
    mkdirSync(directory);
    symlinkSync(directory, link);
    mkdirSync(unwritable);

    expect(() =>
      resolveRuntimePaths({ mode: "user", runtimeHome: file }),
    ).toThrow(RuntimePathError);
    expect(() =>
      resolveRuntimePaths({ mode: "user", runtimeHome: link }),
    ).toThrow(RuntimePathError);
    expect(() =>
      resolveRuntimePaths({
        mode: "user",
        environment: { AI_OFFICE_HOME: "" },
      }),
    ).toThrow("runtime home must be an absolute path");
    expect(() =>
      resolveRuntimePaths({
        mode: "user",
        environment: { AI_OFFICE_HOME: "relative-runtime" },
      }),
    ).toThrow("runtime home must be an absolute path");

    const paths = resolveRuntimePaths({
      mode: "user",
      runtimeHome: unwritable,
    });
    chmodSync(unwritable, 0o500);
    expect(() => ensureRuntimeHome(paths)).toThrow(
      "runtime home is not readable and writable",
    );
    chmodSync(unwritable, 0o700);
  });

  test("detects but never moves a legacy checkout database", () => {
    const workspace = temporaryDirectory("ai-office-legacy-runtime-");
    const distribution = join(workspace, "distribution");
    const legacyHome = join(distribution, ".ai-office");
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "project.sqlite"), "legacy");
    const paths = resolveRuntimePaths({
      mode: "user",
      runtimeHome: join(workspace, "stable-runtime"),
    });

    expect(legacyCheckoutDatabasePath(distribution, paths)).toBe(
      join(realpathSync(distribution), ".ai-office", "project.sqlite"),
    );
  });
});

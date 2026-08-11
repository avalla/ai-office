import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertFilesystemPlatform,
  filesystemConnectorDefinition,
} from "@ai-office/filesystem-connector/filesystem-connector.ts";
import {
  FilesystemBinaryFileError,
  FilesystemDestinationExistsError,
  FilesystemDiffTooLargeError,
  FilesystemEntryNotFoundError,
  FilesystemFileTooLargeError,
  FilesystemHardLinkDeniedError,
  FilesystemNotDirectoryError,
  FilesystemNotRegularFileError,
  FilesystemOutputTooLargeError,
  FilesystemOperationAbortedError,
  FilesystemSourceChangedError,
  FilesystemSymlinkDeniedError,
  InvalidFilesystemConstraintsError,
  InvalidRelativePathError,
  SensitiveFilesystemPathError,
  SourcePreconditionFailedError,
  UnsupportedFilesystemPlatformError,
} from "@ai-office/filesystem-connector/errors.ts";
import {
  FilesystemConstraintHandler,
  filesystemHardLimits,
  parseEffectiveFilesystemConstraints,
} from "@ai-office/filesystem-connector/filesystem-constraints.ts";
import { normalizeRelativePath } from "@ai-office/filesystem-connector/filesystem-path.ts";
import { FilesystemSandbox } from "@ai-office/filesystem-connector/filesystem-sandbox.ts";
import { createUnifiedDiff } from "@ai-office/filesystem-connector/unified-diff.ts";
import { planAtomicMutation } from "@ai-office/filesystem-connector/atomic-mutation-plan.ts";
import { normalizeFilesystemArguments } from "@ai-office/filesystem-connector/filesystem-arguments.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ai-office-filesystem-unit-"));
  const canonical = realpathSync(value);
  roots.push(canonical);
  return canonical;
}

function effective(
  operation: string,
  grant: Readonly<Record<string, unknown>> = {},
  configuration: Readonly<Record<string, unknown>> = {},
  argumentsOverride?: Readonly<Record<string, unknown>>,
) {
  const result = new FilesystemConstraintHandler().combineAndValidate(
    operation,
    argumentsOverride ??
      (operation === "filesystem.move"
        ? { sourcePath: "src/a.txt", destinationPath: "src/b.txt" }
        : operation === "filesystem.search"
          ? { path: "src", query: "needle", caseSensitive: true }
          : operation === "filesystem.list"
            ? { path: "src", recursive: false }
            : { path: "src/a.txt" }),
    [grant],
    configuration,
  );
  expect(result.ok).toBe(true);
  return parseEffectiveFilesystemConstraints(result.effectiveConstraints);
}

describe("filesystem paths and constraints", () => {
  test("root-scoped list and search normalization is idempotent", () => {
    const list = normalizeFilesystemArguments("filesystem.list", {});
    const search = normalizeFilesystemArguments("filesystem.search", {
      query: "needle",
    });

    expect(normalizeFilesystemArguments("filesystem.list", list)).toEqual(list);
    expect(normalizeFilesystemArguments("filesystem.search", search)).toEqual(
      search,
    );
  });

  test.each([
    "/etc/passwd",
    "C:/Windows/system.ini",
    "\\\\server\\share",
    "src\\file.ts",
    "../secret",
    "src/../secret",
    "src/./file",
    "src//file",
    "src/",
    "src/%2e%2e/file",
    "src/a:b",
    "src/CON.txt",
    "src/trailing. ",
    "src\0file",
  ])("rejects non-portable relative path %s", (value) => {
    expect(() =>
      normalizeRelativePath(value, filesystemHardLimits, { allowRoot: false }),
    ).toThrow(InvalidRelativePathError);
  });

  test("enforces path length and segment limits", () => {
    expect(() =>
      normalizeRelativePath(
        "a/b/c",
        { maxPathBytes: 100, maxPathSegments: 2 },
        {
          allowRoot: false,
        },
      ),
    ).toThrow(InvalidRelativePathError);
    expect(() =>
      normalizeRelativePath(
        "long",
        { maxPathBytes: 3, maxPathSegments: 2 },
        {
          allowRoot: false,
        },
      ),
    ).toThrow(InvalidRelativePathError);
  });

  test("applies resource, grant, and combined effective path limits", () => {
    const handler = new FilesystemConstraintHandler();
    const resourceOnly = handler.combineAndValidate(
      "filesystem.read",
      { path: "src/file.ts" },
      [{}],
      { maxPathBytes: 5 },
    );
    expect(resourceOnly).toMatchObject({
      ok: false,
      effectiveConstraints: { maxPathBytes: 5 },
      reasons: ["filesystem path exceeds effective path limits"],
    });

    const grantOnly = handler.combineAndValidate(
      "filesystem.read",
      { path: "src/file.ts" },
      [{ maxPathSegments: 1 }],
      {},
    );
    expect(grantOnly).toMatchObject({
      ok: false,
      effectiveConstraints: { maxPathSegments: 1 },
      reasons: ["filesystem path exceeds effective path limits"],
    });

    const combined = handler.combineAndValidate(
      "filesystem.read",
      { path: "src/file.ts" },
      [{ maxPathBytes: 8 }],
      { maxPathBytes: 20 },
    );
    expect(combined).toMatchObject({
      ok: false,
      effectiveConstraints: { maxPathBytes: 8 },
      reasons: ["filesystem path exceeds effective path limits"],
    });
  });

  test("validates both move paths against effective limits", () => {
    const handler = new FilesystemConstraintHandler();
    for (const arguments_ of [
      { sourcePath: "source.txt", destinationPath: "a" },
      { sourcePath: "a", destinationPath: "destination.txt" },
    ])
      expect(
        handler.combineAndValidate(
          "filesystem.move",
          arguments_,
          [{ allowMutation: true, maxPathBytes: 5 }],
          {},
        ),
      ).toMatchObject({
        ok: false,
        reasons: ["filesystem path exceeds effective path limits"],
      });
  });

  test("keeps the list and search root valid with zero effective path limits", () => {
    const handler = new FilesystemConstraintHandler();
    for (const [operation, arguments_] of [
      ["filesystem.list", { path: "", recursive: false }],
      ["filesystem.search", { path: "", query: "needle", caseSensitive: true }],
    ] as const)
      expect(
        handler.combineAndValidate(operation, arguments_, [{}], {
          maxPathBytes: 0,
          maxPathSegments: 0,
        }),
      ).toMatchObject({
        ok: true,
        effectiveConstraints: { maxPathBytes: 0, maxPathSegments: 0 },
      });
  });

  test("rechecks effective path limits inside the sandbox and precondition verifier", () => {
    const workspace = root();
    const bytesSandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read", { maxPathBytes: 3 }, {}, { path: "a" }),
    );
    expect(() =>
      bytesSandbox.invoke("filesystem.read", { path: "missing.txt" }),
    ).toThrow(InvalidRelativePathError);
    expect(() =>
      bytesSandbox.verifyPreconditions([
        { kind: "absent", path: "missing.txt" },
      ]),
    ).toThrow(InvalidRelativePathError);

    const segmentsSandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read", { maxPathSegments: 1 }, {}, { path: "a" }),
    );
    expect(() =>
      segmentsSandbox.invoke("filesystem.read", { path: "a/b" }),
    ).toThrow(InvalidRelativePathError);
  });

  test("combines three grants restrictively with segment-aware prefixes", () => {
    const handler = new FilesystemConstraintHandler();
    const result = handler.combineAndValidate(
      "filesystem.read",
      { path: "src/app/index.ts" },
      [
        {
          allowedPathPrefixes: ["src"],
          deniedPathPrefixes: ["src/private"],
          allowedExtensions: [".ts", ".md"],
          maxFileBytes: 1000,
        },
        {
          allowedPathPrefixes: ["src/app"],
          deniedPathPrefixes: ["src/generated"],
          allowedExtensions: [".ts"],
          maxFileBytes: 900,
        },
        {
          allowedPathPrefixes: ["src/app"],
          deniedPathPrefixes: ["src/vendor"],
          maxFileBytes: 800,
        },
      ],
      { maxFileBytes: 700 },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.effectiveConstraints).toMatchObject({
      allowedPathPrefixes: ["src/app"],
      deniedPathPrefixes: ["src/generated", "src/private", "src/vendor"],
      allowedExtensions: [".ts"],
      maxFileBytes: 700,
      allowMutation: false,
    });
    expect(
      handler.combineAndValidate(
        "filesystem.read",
        { path: "src/application/index.ts" },
        [{ allowedPathPrefixes: ["src/app"] }],
        {},
      ).ok,
    ).toBe(false);
  });

  test("denies empty intersections, unknown fields, and invalid maxima", () => {
    const handler = new FilesystemConstraintHandler();
    expect(
      handler.combineAndValidate(
        "filesystem.read",
        { path: "a/file.ts" },
        [{ allowedPathPrefixes: ["a"] }, { allowedPathPrefixes: ["b"] }],
        {},
      ).ok,
    ).toBe(false);
    for (const constraints of [
      { unknown: true },
      { maxFileBytes: -1 },
      { maxFileBytes: 1.2 },
      { allowMutation: "yes" },
    ])
      expect(
        handler.combineAndValidate(
          "filesystem.read",
          { path: "a.txt" },
          [constraints],
          {},
        ),
      ).toMatchObject({ ok: false, effectiveConstraints: {} });
    expect(() =>
      filesystemConnectorDefinition.normalizeConstraints({ unknown: true }),
    ).toThrow(InvalidFilesystemConstraintsError);
  });

  test("fails closed on unsupported platforms", () => {
    expect(() => assertFilesystemPlatform("win32")).toThrow(
      UnsupportedFilesystemPlatformError,
    );
    expect(() => assertFilesystemPlatform("aix")).toThrow(
      UnsupportedFilesystemPlatformError,
    );
  });
});

describe("filesystem sandbox reads", () => {
  test("registers only a canonical non-symlink directory root", async () => {
    const workspace = root();
    const prepared = await filesystemConnectorDefinition.prepareResource({
      type: "filesystem_scope",
      externalRef: workspace,
      configuration: {},
    });
    expect(prepared.externalRef).toBe(workspace);
    const alias = `${workspace}-alias`;
    roots.push(alias);
    symlinkSync(workspace, alias);
    await expect(
      filesystemConnectorDefinition.prepareResource({
        type: "filesystem_scope",
        externalRef: alias,
        configuration: {},
      }),
    ).rejects.toBeInstanceOf(FilesystemSymlinkDeniedError);
    writeFileSync(join(workspace, "not-a-root.txt"), "file");
    await expect(
      filesystemConnectorDefinition.prepareResource({
        type: "filesystem_scope",
        externalRef: join(workspace, "not-a-root.txt"),
        configuration: {},
      }),
    ).rejects.toBeInstanceOf(FilesystemNotDirectoryError);
    await expect(
      filesystemConnectorDefinition.prepareResource({
        type: "filesystem_scope",
        externalRef: join(workspace, "missing"),
        configuration: {},
      }),
    ).rejects.toBeInstanceOf(FilesystemEntryNotFoundError);
  });

  test.each([
    ".git",
    ".git/objects",
    ".AI-OFFICE",
    ".SsH",
    ".AwS",
    ".config/gcloud",
    ".CONFIG/GCLOUD/cache",
  ])("rejects a built-in sensitive canonical root at %s", async (relative) => {
    const workspace = root();
    const sensitiveRoot = join(workspace, ...relative.split("/"));
    mkdirSync(sensitiveRoot, { recursive: true });

    const error = await filesystemConnectorDefinition
      .prepareResource({
        type: "filesystem_scope",
        externalRef: sensitiveRoot,
        configuration: {},
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(SensitiveFilesystemPathError);
    if (!(error instanceof Error))
      throw new Error("Expected registration error");
    expect(error.message).toBe("Filesystem path is unavailable");
    expect(error.message).not.toContain(sensitiveRoot);
    expect(error.message).not.toContain("/");
  });

  test("continues to register a non-sensitive canonical root", async () => {
    const workspace = root();
    const ordinaryRoot = join(workspace, "project", "source");
    mkdirSync(ordinaryRoot, { recursive: true });

    await expect(
      filesystemConnectorDefinition.prepareResource({
        type: "filesystem_scope",
        externalRef: ordinaryRoot,
        configuration: { deniedPathPrefixes: ["project"] },
      }),
    ).resolves.toMatchObject({
      externalRef: realpathSync(ordinaryRoot),
      configuration: { deniedPathPrefixes: ["project"] },
    });
  });

  test("reads UTF-8 with byte hash and fails explicitly on output limits", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "hello.txt"), "héllo\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
    );
    expect(
      sandbox.invoke("filesystem.read", { path: "src/hello.txt" }),
    ).toEqual({
      kind: "read",
      output: {
        path: "src/hello.txt",
        content: "héllo\n",
        byteLength: 7,
        sha256: createHash("sha256").update("héllo\n").digest("hex"),
        finalNewline: true,
      },
      audit: {
        relativePath: "src/hello.txt",
        byteLength: 7,
        contentSha256: createHash("sha256").update("héllo\n").digest("hex"),
      },
    });
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.read", { maxOutputBytes: 5 }),
      ).invoke("filesystem.read", { path: "src/hello.txt" }),
    ).toThrow(FilesystemOutputTooLargeError);
  });

  test("enforces file, search result, visited-file, and depth limits", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src", "nested"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.txt"), "needle needle\n");
    writeFileSync(join(workspace, "src", "b.txt"), "needle\n");
    writeFileSync(join(workspace, "src", "nested", "c.txt"), "needle\n");
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.read", { maxFileBytes: 2 }),
      ).invoke("filesystem.read", { path: "src/a.txt" }),
    ).toThrow(FilesystemFileTooLargeError);
    const limited = new FilesystemSandbox(
      workspace,
      effective("filesystem.search", {
        maxResults: 1,
        maxVisitedFiles: 1,
        maxDepth: 1,
      }),
    ).invoke("filesystem.search", {
      path: "src",
      query: "needle",
      caseSensitive: true,
    });
    expect(limited.kind).toBe("read");
    if (limited.kind === "read")
      expect(limited.output).toMatchObject({
        truncated: true,
        visitedFiles: 1,
      });
  });

  test("denies invalid UTF-8, NUL content, symlinks, and hard links", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "binary.txt"), Buffer.from([0, 1]));
    writeFileSync(
      join(workspace, "src", "invalid.txt"),
      Buffer.from([0xc3, 0x28]),
    );
    writeFileSync(join(workspace, "src", "real.txt"), "value");
    symlinkSync("real.txt", join(workspace, "src", "final.txt"));
    symlinkSync("missing.txt", join(workspace, "src", "broken.txt"));
    linkSync(
      join(workspace, "src", "real.txt"),
      join(workspace, "src", "hard.txt"),
    );
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
    );
    for (const path of ["src/binary.txt", "src/invalid.txt"])
      expect(() => sandbox.invoke("filesystem.read", { path })).toThrow(
        FilesystemBinaryFileError,
      );
    for (const path of ["src/final.txt", "src/broken.txt"])
      expect(() => sandbox.invoke("filesystem.read", { path })).toThrow(
        FilesystemSymlinkDeniedError,
      );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/hard.txt" }),
    ).toThrow(FilesystemHardLinkDeniedError);
    expect(() =>
      new FilesystemSandbox(workspace, effective("filesystem.search")).invoke(
        "filesystem.search",
        {
          path: "src/hard.txt",
          query: "value",
          caseSensitive: true,
        },
      ),
    ).toThrow(FilesystemHardLinkDeniedError);
  });

  test("denies intermediate symlinks and sensitive paths without disclosure", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(workspace, "src", "linked"));
    writeFileSync(join(workspace, ".ENV.Production"), "TOKEN=secret");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/linked/secret.txt" }),
    ).toThrow(FilesystemSymlinkDeniedError);
    expect(() =>
      sandbox.invoke("filesystem.read", { path: ".ENV.Production" }),
    ).toThrow(SensitiveFilesystemPathError);
  });

  test("denies descendants of every built-in sensitive name", () => {
    const workspace = root();
    const sensitiveDirectories = [
      ".env.production",
      "credentials",
      "private.key",
      ".EnV.Staging",
      "CREDENTIALS.JSON",
      "Secrets",
      "certificate.PEM",
    ] as const;
    for (const directory of sensitiveDirectories) {
      mkdirSync(join(workspace, directory), { recursive: true });
      writeFileSync(join(workspace, directory, "secret.txt"), "needle\n");
    }

    const readSandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
    );
    for (const directory of sensitiveDirectories)
      expect(() =>
        readSandbox.invoke("filesystem.read", {
          path: `${directory}/secret.txt`,
        }),
      ).toThrow(SensitiveFilesystemPathError);

    const listSandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.list",
        {},
        {},
        { path: ".env.production", recursive: true },
      ),
    );
    expect(() =>
      listSandbox.invoke("filesystem.list", {
        path: ".env.production",
        recursive: true,
      }),
    ).toThrow(SensitiveFilesystemPathError);

    const searchSandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.search",
        {},
        {},
        {
          path: ".env.production",
          query: "needle",
          caseSensitive: true,
        },
      ),
    );
    let error: unknown;
    try {
      searchSandbox.invoke("filesystem.search", {
        path: ".env.production",
        query: "needle",
        caseSensitive: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SensitiveFilesystemPathError);
    if (!(error instanceof Error)) throw new Error("Expected sandbox error");
    expect(error.message).toBe("Filesystem path is unavailable");
    expect(error.message).not.toContain(workspace);
    expect(error.message).not.toContain(".env.production");
    expect(error.message).not.toContain("/");
  });

  test("denies .git-credentials as a case-insensitive subtree without overmatching", () => {
    const workspace = root();
    mkdirSync(join(workspace, "case"));
    mkdirSync(join(workspace, "nested", ".git-credentials"), {
      recursive: true,
    });
    writeFileSync(join(workspace, ".git-credentials"), "needle secret\n");
    writeFileSync(
      join(workspace, "case", ".GIT-CREDENTIALS"),
      "needle secret\n",
    );
    writeFileSync(
      join(workspace, "nested", ".git-credentials", "secret.txt"),
      "needle secret\n",
    );
    writeFileSync(join(workspace, ".git-credential"), "needle public\n");

    const readSandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
    );
    for (const path of [
      ".git-credentials",
      "case/.GIT-CREDENTIALS",
      "nested/.git-credentials/secret.txt",
    ])
      expect(() => readSandbox.invoke("filesystem.read", { path })).toThrow(
        SensitiveFilesystemPathError,
      );

    let error: unknown;
    try {
      readSandbox.invoke("filesystem.read", { path: ".git-credentials" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SensitiveFilesystemPathError);
    if (!(error instanceof Error)) throw new Error("Expected sandbox error");
    expect(error.message).toBe("Filesystem path is unavailable");
    expect(error.message).not.toContain(workspace);
    expect(error.message).not.toContain(".git-credentials");
    expect(error.message).not.toContain("/");

    const ordinary = readSandbox.invoke("filesystem.read", {
      path: ".git-credential",
    });
    expect(ordinary).toMatchObject({
      kind: "read",
      output: { path: ".git-credential", content: "needle public\n" },
    });

    const listed = new FilesystemSandbox(
      workspace,
      effective("filesystem.list"),
    ).invoke("filesystem.list", { path: "", recursive: true });
    expect(JSON.stringify(listed)).not.toContain(".git-credentials");
    expect(JSON.stringify(listed)).toContain(".git-credential");

    const searched = new FilesystemSandbox(
      workspace,
      effective("filesystem.search"),
    ).invoke("filesystem.search", {
      path: "",
      query: "needle",
      caseSensitive: true,
    });
    expect(JSON.stringify(searched)).not.toContain(".git-credentials");
    expect(searched).toMatchObject({
      kind: "read",
      output: { matches: [{ path: ".git-credential" }] },
    });
  });

  test("lists and searches deterministically while hiding denied entries", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src", "nested"), { recursive: true });
    mkdirSync(join(workspace, ".git"));
    writeFileSync(join(workspace, ".git", "config"), "hidden");
    writeFileSync(join(workspace, "src", "z.txt"), "literal .* needle\n");
    writeFileSync(join(workspace, "src", "a.txt"), "needle token=secret\n");
    writeFileSync(join(workspace, "src", "nested", "b.txt"), "needle\n");
    const list = new FilesystemSandbox(
      workspace,
      effective("filesystem.list"),
    ).invoke("filesystem.list", { path: "", recursive: true });
    expect(list.kind).toBe("read");
    if (list.kind === "read") {
      const entries = list.output.entries as readonly { path: string }[];
      expect(entries.map((entry) => entry.path)).toEqual([
        "src",
        "src/a.txt",
        "src/nested",
        "src/z.txt",
        "src/nested/b.txt",
      ]);
      expect(JSON.stringify(list.output)).not.toContain(".git");
      expect(JSON.stringify(list.output)).not.toContain(workspace);
    }
    const search = new FilesystemSandbox(
      workspace,
      effective("filesystem.search"),
    ).invoke("filesystem.search", {
      path: "src",
      query: ".*",
      caseSensitive: true,
    });
    expect(search.kind).toBe("read");
    if (search.kind === "read") {
      expect(search.output.matches).toEqual([
        {
          path: "src/z.txt",
          line: 1,
          column: 9,
          excerpt: "literal .* needle",
        },
      ]);
    }
    const redacted = new FilesystemSandbox(
      workspace,
      effective("filesystem.search"),
    ).invoke("filesystem.search", {
      path: "src",
      query: "needle",
      caseSensitive: true,
    });
    if (redacted.kind === "read")
      expect(JSON.stringify(redacted.output)).not.toContain("token=secret");
  });
});

describe("filesystem mutation simulation", () => {
  test("simulates create, write, move, and delete without changing files", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "old.txt"), "old\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.write", { allowMutation: true }),
    );
    const create = sandbox.invoke("filesystem.create", {
      path: "src/new.txt",
      content: "new\n",
    });
    const write = sandbox.invoke("filesystem.write", {
      path: "src/old.txt",
      content: "changed\n",
    });
    const move = sandbox.invoke("filesystem.move", {
      sourcePath: "src/old.txt",
      destinationPath: "src/moved.txt",
    });
    const remove = sandbox.invoke("filesystem.delete", { path: "src/old.txt" });
    for (const result of [create, write, move, remove])
      expect(result.kind).toBe("simulation");
    expect(readFileSync(join(workspace, "src", "old.txt"), "utf8")).toBe(
      "old\n",
    );
    expect(() => readFileSync(join(workspace, "src", "new.txt"))).toThrow();
    if (create.kind === "simulation") {
      expect(create.preconditions).toEqual([
        { kind: "absent", path: "src/new.txt" },
      ]);
      expect(create.diff).toContain("--- /dev/null\n+++ b/src/new.txt\n");
    }
    if (move.kind === "simulation")
      expect(move.preconditions).toEqual([
        {
          kind: "file",
          path: "src/old.txt",
          sha256: createHash("sha256").update("old\n").digest("hex"),
          size: 4,
        },
        { kind: "absent", path: "src/moved.txt" },
      ]);
  });

  test("rejects existing destinations, hard-linked sources, and oversized diffs", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "a");
    writeFileSync(join(workspace, "src", "b.txt"), "b");
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.create", { allowMutation: true }),
      ).invoke("filesystem.create", { path: "src/a.txt", content: "x" }),
    ).toThrow(FilesystemDestinationExistsError);
    linkSync(
      join(workspace, "src", "a.txt"),
      join(workspace, "src", "hard.txt"),
    );
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.delete", { allowMutation: true }),
      ).invoke("filesystem.delete", { path: "src/hard.txt" }),
    ).toThrow(FilesystemHardLinkDeniedError);
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.write", {
          allowMutation: true,
          maxDiffBytes: 20,
        }),
      ).invoke("filesystem.write", {
        path: "src/b.txt",
        content: "long replacement",
      }),
    ).toThrow(FilesystemDiffTooLargeError);
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.create", { allowMutation: true }),
      ).invoke("filesystem.create", {
        path: "missing/new.txt",
        content: "new",
      }),
    ).toThrow(FilesystemEntryNotFoundError);
  });

  test("revalidates canonical source and absent preconditions", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "one\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.write", { allowMutation: true }),
    );
    const result = sandbox.invoke("filesystem.write", {
      path: "src/a.txt",
      content: "two\n",
    });
    expect(result.kind).toBe("simulation");
    if (result.kind !== "simulation") return;
    sandbox.verifyPreconditions(result.preconditions);
    writeFileSync(join(workspace, "src", "a.txt"), "changed\n");
    expect(() => sandbox.verifyPreconditions(result.preconditions)).toThrow(
      SourcePreconditionFailedError,
    );
  });

  test("creates deterministic diffs for CRLF and missing final newline", () => {
    const first = createUnifiedDiff({
      oldPath: "src/a.txt",
      newPath: "src/a.txt",
      oldContent: "old\r\nline",
      newContent: "new\r\nline\r\n",
      maxBytes: 1024,
    });
    const second = createUnifiedDiff({
      oldPath: "src/a.txt",
      newPath: "src/a.txt",
      oldContent: "old\r\nline",
      newContent: "new\r\nline\r\n",
      maxBytes: 1024,
    });
    expect(first).toBe(second);
    expect(first).toContain("\\ No newline at end of file");
    expect(first).not.toContain("\r");
  });

  test("hashes original CRLF bytes while normalizing only diff presentation", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    const original = Buffer.from("old\r\nline\r\n", "utf8");
    writeFileSync(join(workspace, "src", "a.txt"), original);
    const result = new FilesystemSandbox(
      workspace,
      effective("filesystem.write", { allowMutation: true }),
    ).invoke("filesystem.write", {
      path: "src/a.txt",
      content: "new\nline\n",
    });
    expect(result.kind).toBe("simulation");
    if (result.kind !== "simulation") return;
    expect(result.preconditions).toEqual([
      {
        kind: "file",
        path: "src/a.txt",
        sha256: createHash("sha256").update(original).digest("hex"),
        size: original.byteLength,
      },
    ]);
    expect(result.diff).not.toContain("\r");
  });

  test("designs future atomic writes without touching the filesystem", () => {
    const workspace = root();
    const destination = join(workspace, "planned.txt");
    const plan = planAtomicMutation({
      operation: "create",
      destinationPath: "planned.txt",
      content: "planned",
      preconditions: [{ kind: "absent", path: "planned.txt" }],
    });
    expect(plan).toMatchObject({
      strategy: "exclusive-sibling-temp-then-rename",
      destinationPath: "planned.txt",
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => readFileSync(destination)).toThrow();
  });
});

describe("filesystem allowed-path classification", () => {
  test("denies direct search of a file that is only an allowed ancestor", () => {
    const workspace = root();
    writeFileSync(join(workspace, "scope"), "needle\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.search",
        {
          allowedPathPrefixes: ["scope/allowed/deep"],
        },
        {},
        { path: "scope", query: "needle", caseSensitive: true },
      ),
    );
    expect(() =>
      sandbox.invoke("filesystem.search", {
        path: "scope",
        query: "needle",
        caseSensitive: true,
      }),
    ).toThrow(SensitiveFilesystemPathError);
  });

  test("does not read an ancestor file discovered recursively", () => {
    const workspace = root();
    mkdirSync(join(workspace, "scope"));
    writeFileSync(join(workspace, "scope", "allowed"), "needle\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.search",
        {
          allowedPathPrefixes: ["scope/allowed/deep"],
        },
        {},
        { path: "scope", query: "needle", caseSensitive: true },
      ),
    );
    const result = sandbox.invoke("filesystem.search", {
      path: "scope",
      query: "needle",
      caseSensitive: true,
    });
    expect(result).toMatchObject({
      kind: "read",
      output: { matches: [] },
    });
  });

  test("denies listing a file that is only an allowed ancestor", () => {
    const workspace = root();
    writeFileSync(join(workspace, "scope"), "not a directory\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.list",
        {
          allowedPathPrefixes: ["scope/allowed"],
        },
        {},
        { path: "scope", recursive: false },
      ),
    );
    expect(() =>
      sandbox.invoke("filesystem.list", { path: "scope", recursive: false }),
    ).toThrow(SensitiveFilesystemPathError);
  });

  test("rejects an allowed ancestor directory replaced by a file", () => {
    const workspace = root();
    mkdirSync(join(workspace, "scope", "allowed", "deep"), {
      recursive: true,
    });
    const sandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.list",
        {
          allowedPathPrefixes: ["scope/allowed/deep"],
        },
        {},
        { path: "scope", recursive: true },
      ),
      {
        beforeDirectoryRead: (path, absolute) => {
          if (path !== "scope/allowed") return;
          rmSync(absolute, { recursive: true });
          writeFileSync(absolute, "replacement\n");
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.list", { path: "scope", recursive: true }),
    ).toThrow(FilesystemNotDirectoryError);
  });

  test("traverses legitimate ancestor directories to an allowed file", () => {
    const workspace = root();
    mkdirSync(join(workspace, "scope", "allowed", "deep"), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, "scope", "allowed", "deep", "file.txt"),
      "needle\n",
    );
    const sandbox = new FilesystemSandbox(
      workspace,
      effective(
        "filesystem.search",
        {
          allowedPathPrefixes: ["scope/allowed/deep"],
        },
        {},
        { path: "scope", query: "needle", caseSensitive: true },
      ),
    );
    const result = sandbox.invoke("filesystem.search", {
      path: "scope",
      query: "needle",
      caseSensitive: true,
    });
    expect(result).toMatchObject({
      kind: "read",
      output: { matches: [{ path: "scope/allowed/deep/file.txt" }] },
    });
  });
});

describe("filesystem traversal work and cancellation budgets", () => {
  test.each([
    {
      kind: "denied",
      names: Array.from({ length: 12 }, (_, i) => `.env.${i}`),
    },
    {
      kind: "excluded",
      names: Array.from({ length: 12 }, (_, i) => `file-${i}.log`),
    },
  ])("counts $kind entries before filtering", ({ kind, names }) => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    for (const name of names)
      writeFileSync(join(workspace, "src", name), "ignored\n");
    let inspectedEntries = 0;
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.list", {
        maxVisitedEntries: 3,
        ...(kind === "excluded" ? { allowedExtensions: [".ts"] } : {}),
      }),
      {
        onDirectoryEntry: () => {
          inspectedEntries += 1;
        },
      },
    );
    const result = sandbox.invoke("filesystem.list", {
      path: "src",
      recursive: false,
    });
    expect(result).toMatchObject({
      kind: "read",
      output: { entries: [], truncated: true },
    });
    expect(inspectedEntries).toBe(3);
  });

  test("limits directories even when the tree contains few files", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    for (let index = 0; index < 8; index += 1)
      mkdirSync(join(workspace, "src", `dir-${index}`));
    let visitedDirectories = 0;
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.list", {
        maxVisitedDirectories: 2,
        maxVisitedEntries: 100,
      }),
      {
        beforeDirectoryRead: () => {
          visitedDirectories += 1;
        },
      },
    );
    const result = sandbox.invoke("filesystem.list", {
      path: "src",
      recursive: true,
    });
    expect(result).toMatchObject({ kind: "read", output: { truncated: true } });
    expect(visitedDirectories).toBeLessThanOrEqual(2);
  });

  test("aborts before invocation and during traversal", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "needle\n");
    const before = new AbortController();
    before.abort();
    expect(() =>
      new FilesystemSandbox(
        workspace,
        effective("filesystem.list"),
        {},
        before.signal,
      ).invoke("filesystem.list", { path: "src", recursive: false }),
    ).toThrow(FilesystemOperationAbortedError);

    const during = new AbortController();
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.list"),
      { afterDirectoryRead: () => during.abort() },
      during.signal,
    );
    expect(() =>
      sandbox.invoke("filesystem.list", { path: "src", recursive: false }),
    ).toThrow(FilesystemOperationAbortedError);
  });

  test("aborts between two files during search", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "needle\n");
    writeFileSync(join(workspace, "src", "b.txt"), "needle\n");
    const controller = new AbortController();
    let closedFiles = 0;
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.search"),
      {
        afterFileClose: () => {
          closedFiles += 1;
          if (closedFiles === 1) controller.abort();
        },
      },
      controller.signal,
    );
    expect(() =>
      sandbox.invoke("filesystem.search", {
        path: "src",
        query: "needle",
        caseSensitive: true,
      }),
    ).toThrow(FilesystemOperationAbortedError);
    expect(closedFiles).toBe(1);
  });

  test.each([0, 8])(
    "rejects an empty list envelope larger than maxOutputBytes=%i",
    (maxOutputBytes) => {
      const workspace = root();
      mkdirSync(join(workspace, "empty"));
      const sandbox = new FilesystemSandbox(
        workspace,
        effective("filesystem.list", { maxOutputBytes }),
      );
      expect(() =>
        sandbox.invoke("filesystem.list", {
          path: "empty",
          recursive: false,
        }),
      ).toThrow(FilesystemOutputTooLargeError);
    },
  );

  test.each([0, 8])(
    "rejects an empty search envelope larger than maxOutputBytes=%i",
    (maxOutputBytes) => {
      const workspace = root();
      mkdirSync(join(workspace, "empty"));
      const sandbox = new FilesystemSandbox(
        workspace,
        effective("filesystem.search", { maxOutputBytes }),
      );
      expect(() =>
        sandbox.invoke("filesystem.search", {
          path: "empty",
          query: "needle",
          caseSensitive: true,
        }),
      ).toThrow(FilesystemOutputTooLargeError);
    },
  );

  test("returns an explicit empty or truncated result within the final budget", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "no match\n");
    const empty = new FilesystemSandbox(
      workspace,
      effective("filesystem.search"),
    ).invoke("filesystem.search", {
      path: "src",
      query: "needle",
      caseSensitive: true,
    });
    expect(empty).toMatchObject({ kind: "read", output: { matches: [] } });
    const truncated = new FilesystemSandbox(
      workspace,
      effective("filesystem.search", { maxResults: 0 }),
    ).invoke("filesystem.search", {
      path: "src",
      query: "no",
      caseSensitive: true,
    });
    expect(truncated).toMatchObject({
      kind: "read",
      output: { matches: [], truncated: true },
    });
  });
});

describe("filesystem adversarial path swaps", () => {
  test("redacts a file removed after precheck but before open", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: (_path, absolute) => unlinkSync(absolute),
      },
    );

    let caught: unknown;
    try {
      sandbox.invoke("filesystem.read", { path: "src/file.txt" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FilesystemEntryNotFoundError);
    expect((caught as Error).message).not.toContain(workspace);
  });

  test("rejects final symlink substitution between precheck and open", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    writeFileSync(join(outside, "secret.txt"), "outside-secret\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: (_path, absolute) => {
          renameSync(absolute, `${absolute}.original`);
          symlinkSync(join(outside, "secret.txt"), absolute);
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/file.txt" }),
    ).toThrow(FilesystemSymlinkDeniedError);
  });

  test("rejects regular-file inode substitution before reading bytes", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    writeFileSync(join(outside, "replacement.txt"), "outside-secret\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: (_path, absolute) => {
          renameSync(absolute, `${absolute}.original`);
          renameSync(join(outside, "replacement.txt"), absolute);
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/file.txt" }),
    ).toThrow(FilesystemSourceChangedError);
  });

  test("rejects intermediate directory replacement with a symlink", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    writeFileSync(join(outside, "file.txt"), "outside-secret\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: () => {
          renameSync(join(workspace, "src"), join(workspace, "src-original"));
          symlinkSync(outside, join(workspace, "src"));
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/file.txt" }),
    ).toThrow(FilesystemSourceChangedError);
  });

  test("rechecks effective containment after a directory moves outside root", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    const moved = join(outside, "moved");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: () => {
          renameSync(join(workspace, "src"), moved);
          symlinkSync(moved, join(workspace, "src"));
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/file.txt" }),
    ).toThrow(FilesystemSymlinkDeniedError);
  });

  test("rechecks a search directory after symlink retarget", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "needle\n");
    writeFileSync(join(outside, "secret.txt"), "needle outside-secret\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.search"),
      {
        afterDirectoryRead: (path) => {
          if (path !== "src") return;
          renameSync(join(workspace, "src"), join(workspace, "src-original"));
          symlinkSync(outside, join(workspace, "src"));
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.search", {
        path: "src",
        query: "needle",
        caseSensitive: true,
      }),
    ).toThrow(FilesystemSymlinkDeniedError);
  });

  test("rechecks a list directory after an intermediate rename", () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    writeFileSync(join(outside, "secret.txt"), "outside-secret\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.list"),
      {
        beforeDirectoryRead: (path) => {
          if (path !== "src") return;
          renameSync(join(workspace, "src"), join(workspace, "src-original"));
          symlinkSync(outside, join(workspace, "src"));
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.list", { path: "src", recursive: false }),
    ).toThrow(FilesystemSymlinkDeniedError);
  });

  test("checks hard-link count on the opened descriptor", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: (_path, absolute) => {
          linkSync(absolute, `${absolute}.hard-link`);
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/file.txt" }),
    ).toThrow(FilesystemHardLinkDeniedError);
  });

  test("opens a FIFO non-blocking and closes the rejected descriptor", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    let closed = false;
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: (_path, absolute) => {
          unlinkSync(absolute);
          execFileSync("mkfifo", [absolute]);
        },
        afterFileClose: () => {
          closed = true;
        },
      },
    );
    const startedAt = performance.now();
    let caught: unknown;
    try {
      sandbox.invoke("filesystem.read", { path: "src/file.txt" });
    } catch (error) {
      caught = error;
    }
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(caught).toBeInstanceOf(FilesystemNotRegularFileError);
    expect((caught as Error).message).not.toContain(workspace);
    expect(closed).toBe(true);
  });

  test("rejects and closes a directory substituted for a regular file", () => {
    const workspace = root();
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "file.txt"), "inside\n");
    let closed = false;
    const sandbox = new FilesystemSandbox(
      workspace,
      effective("filesystem.read"),
      {
        beforeFileOpen: (_path, absolute) => {
          unlinkSync(absolute);
          mkdirSync(absolute);
        },
        afterFileClose: () => {
          closed = true;
        },
      },
    );
    expect(() =>
      sandbox.invoke("filesystem.read", { path: "src/file.txt" }),
    ).toThrow(FilesystemNotRegularFileError);
    expect(closed).toBe(true);
  });
});

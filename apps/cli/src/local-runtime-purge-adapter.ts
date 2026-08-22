import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  lstatSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import type {
  RuntimePurgeAdapter,
  RuntimePurgeArtifact,
  RuntimePurgeArtifactKind,
  RuntimePurgeDraft,
  RuntimePurgeResult,
} from "@ai-office/application/ports/runtime-purge-adapter.port.ts";

const runtimeArtifacts = new Map<string, RuntimePurgeArtifactKind>([
  ["project.sqlite", "file"],
  ["project.sqlite-wal", "file"],
  ["project.sqlite-shm", "file"],
  ["project.sqlite-journal", "file"],
  ["index.sqlite", "file"],
  ["index.sqlite-wal", "file"],
  ["index.sqlite-shm", "file"],
  ["index.sqlite-journal", "file"],
  ["daemon.sock", "socket"],
  ["drafts", "directory"],
  ["generated", "directory"],
]);

const removalOrder = [
  "daemon.sock",
  "drafts",
  "generated",
  "index.sqlite-shm",
  "index.sqlite-wal",
  "index.sqlite-journal",
  "index.sqlite",
  "project.sqlite-shm",
  "project.sqlite-wal",
  "project.sqlite-journal",
  "project.sqlite",
] as const;

function removalRank(relativePath: string): number {
  const name = relativePath.slice(".ai-office/".length).split("/", 1)[0]!;
  const rank = removalOrder.findIndex((candidate) => candidate === name);
  return rank === -1 ? removalOrder.length : rank;
}

function pathDepth(relativePath: string): number {
  return relativePath.split("/").length;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class LocalRuntimePurgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRuntimePurgeError";
  }
}

export interface LocalRuntimePurgeHooks {
  beforeRemove?(relativePath: string): void;
}

interface FingerprintedPath {
  kind: RuntimePurgeArtifactKind;
  sizeBytes: number;
  fingerprint: string;
}

function identity(status: Stats): string {
  return `${status.dev}\0${status.ino}\0${status.mode}\0${status.mtimeMs}`;
}

function directoryIdentity(status: Stats): string {
  return `${status.dev}\0${status.ino}\0${status.mode}`;
}

function fingerprintRegularFile(path: string): FingerprintedPath {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new LocalRuntimePurgeError(
      `Runtime purge could not open a regular file safely: ${path}`,
    );
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile())
      throw new LocalRuntimePurgeError(
        `Runtime purge found a changed regular file: ${path}`,
      );
    const hash = createHash("sha256").update(
      `file\0${identity(before)}\0`,
      "utf8",
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    if (identity(after) !== identity(before) || after.size !== before.size)
      throw new LocalRuntimePurgeError(
        `Runtime purge found a file changing during inspection: ${path}`,
      );
    return {
      kind: "file",
      sizeBytes: before.size,
      fingerprint: hash.digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function fingerprintPath(path: string): FingerprintedPath {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) {
    const target = readlinkSync(path);
    return {
      kind: "symbolic_link",
      sizeBytes: status.size,
      fingerprint: createHash("sha256")
        .update(`symbolic_link\0${identity(status)}\0${target}`, "utf8")
        .digest("hex"),
    };
  }
  if (status.isFile()) return fingerprintRegularFile(path);
  if (status.isSocket())
    return {
      kind: "socket",
      sizeBytes: status.size,
      fingerprint: createHash("sha256")
        .update(`socket\0${identity(status)}`, "utf8")
        .digest("hex"),
    };
  if (status.isDirectory()) {
    return {
      kind: "directory",
      sizeBytes: 0,
      fingerprint: createHash("sha256")
        .update(`directory\0${directoryIdentity(status)}`, "utf8")
        .digest("hex"),
    };
  }
  throw new LocalRuntimePurgeError(
    `Runtime purge found an unsupported filesystem entry: ${path}`,
  );
}

function fingerprintTree(
  path: string,
  relativePath: string,
): RuntimePurgeArtifact[] {
  const entry = fingerprintPath(path);
  if (entry.kind !== "directory") return [{ relativePath, ...entry }];

  const names = readdirSync(path).sort();
  const artifacts = names.flatMap((name) =>
    fingerprintTree(join(path, name), `${relativePath}/${name}`),
  );
  const latest = fingerprintPath(path);
  const latestNames = readdirSync(path).sort();
  if (
    !sameArtifact(latest, { relativePath, ...entry }) ||
    latestNames.length !== names.length ||
    latestNames.some((name, index) => name !== names[index])
  )
    throw new LocalRuntimePurgeError(
      `Runtime purge found a directory changing during inspection: ${relativePath}`,
    );
  artifacts.push({ relativePath, ...entry });
  return artifacts;
}

function sameArtifact(
  current: FingerprintedPath,
  expected: RuntimePurgeArtifact,
): boolean {
  return (
    current.kind === expected.kind &&
    current.sizeBytes === expected.sizeBytes &&
    current.fingerprint === expected.fingerprint
  );
}

export class LocalRuntimePurgeAdapter implements RuntimePurgeAdapter {
  constructor(private readonly hooks: LocalRuntimePurgeHooks = {}) {}

  async plan(runtimeRootInput: string): Promise<RuntimePurgeDraft> {
    let runtimeRoot: string;
    try {
      runtimeRoot = realpathSync(resolve(runtimeRootInput));
    } catch {
      throw new LocalRuntimePurgeError(
        `Runtime root does not exist: ${runtimeRootInput}`,
      );
    }
    try {
      if (!statSync(runtimeRoot).isDirectory())
        throw new LocalRuntimePurgeError(
          `Runtime root is not a directory: ${runtimeRootInput}`,
        );
    } catch (error) {
      if (error instanceof LocalRuntimePurgeError) throw error;
      throw new LocalRuntimePurgeError(
        `Runtime purge could not inspect the runtime root safely: ${runtimeRoot}`,
      );
    }

    const stateDirectory = join(runtimeRoot, ".ai-office");
    let names: string[];
    let stateDirectoryFingerprint: string | null = null;
    try {
      const state = lstatSync(stateDirectory);
      if (state.isSymbolicLink() || !state.isDirectory())
        throw new LocalRuntimePurgeError(
          `Runtime state path must be a real directory: ${stateDirectory}`,
        );
      stateDirectoryFingerprint = createHash("sha256")
        .update(`directory\0${directoryIdentity(state)}`, "utf8")
        .digest("hex");
      names = readdirSync(stateDirectory).sort();
    } catch (error) {
      if (error instanceof LocalRuntimePurgeError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        names = [];
      else
        throw new LocalRuntimePurgeError(
          `Runtime purge could not inspect the state directory safely: ${stateDirectory}`,
        );
    }

    const artifacts: RuntimePurgeArtifact[] = [];
    const preservedPaths: string[] = [];
    for (const name of names) {
      const relativePath = `.ai-office/${name}`;
      const expectedKind = runtimeArtifacts.get(name);
      if (expectedKind === undefined) {
        preservedPaths.push(relativePath);
        continue;
      }
      try {
        const targetPath = join(stateDirectory, name);
        const fingerprinted = fingerprintPath(targetPath);
        if (fingerprinted.kind !== expectedKind) {
          preservedPaths.push(relativePath);
          continue;
        }
        if (fingerprinted.kind === "directory")
          artifacts.push(...fingerprintTree(targetPath, relativePath));
        else artifacts.push({ relativePath, ...fingerprinted });
      } catch (error) {
        if (error instanceof LocalRuntimePurgeError) throw error;
        throw new LocalRuntimePurgeError(
          `Runtime purge could not inspect an artifact safely: ${relativePath}`,
        );
      }
    }
    artifacts.sort(
      (left, right) =>
        removalRank(left.relativePath) - removalRank(right.relativePath) ||
        pathDepth(right.relativePath) - pathDepth(left.relativePath) ||
        comparePaths(left.relativePath, right.relativePath),
    );

    return {
      contractVersion: 1,
      runtimeRoot,
      stateDirectory,
      stateDirectoryFingerprint,
      artifacts,
      preservedPaths,
    };
  }

  async apply(draft: RuntimePurgeDraft): Promise<RuntimePurgeResult> {
    const removedPaths: string[] = [];
    for (const artifact of draft.artifacts) {
      const targetPath = join(draft.runtimeRoot, artifact.relativePath);
      this.hooks.beforeRemove?.(artifact.relativePath);
      let current: FingerprintedPath;
      try {
        current = fingerprintPath(targetPath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          throw new LocalRuntimePurgeError(
            `Runtime artifact changed after planning: ${artifact.relativePath}`,
          );
        if (error instanceof LocalRuntimePurgeError) throw error;
        throw new LocalRuntimePurgeError(
          `Runtime purge could not revalidate an artifact safely: ${artifact.relativePath}`,
        );
      }
      if (!sameArtifact(current, artifact))
        throw new LocalRuntimePurgeError(
          `Runtime artifact changed after planning: ${artifact.relativePath}`,
        );
      try {
        if (artifact.kind === "directory") rmdirSync(targetPath);
        else unlinkSync(targetPath);
      } catch {
        throw new LocalRuntimePurgeError(
          `Runtime purge stopped after removing ${removedPaths.length} artifact(s); ${artifact.relativePath} changed or could not be removed safely, so inspect the remaining state and generate a new plan`,
        );
      }
      removedPaths.push(artifact.relativePath);
    }

    let stateDirectoryRemoved = false;
    try {
      if (
        draft.stateDirectoryFingerprint !== null &&
        readdirSync(draft.stateDirectory).length === 0
      ) {
        const current = fingerprintPath(draft.stateDirectory);
        if (
          current.kind !== "directory" ||
          current.fingerprint !== draft.stateDirectoryFingerprint
        )
          throw new LocalRuntimePurgeError(
            "Runtime artifacts were removed, but the state directory changed before cleanup",
          );
        rmdirSync(draft.stateDirectory);
        stateDirectoryRemoved = true;
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTEMPTY")
      ))
        throw new LocalRuntimePurgeError(
          "Runtime artifacts were removed, but the state directory could not be cleaned up safely",
        );
    }

    return {
      runtimeRoot: draft.runtimeRoot,
      removedPaths,
      preservedPaths: draft.preservedPaths,
      stateDirectoryRemoved,
    };
  }
}

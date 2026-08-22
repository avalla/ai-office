import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
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
  const name = relativePath.slice(".ai-office/".length);
  const rank = removalOrder.findIndex((candidate) => candidate === name);
  return rank === -1 ? removalOrder.length : rank;
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
  if (status.isFile()) {
    const contents = readFileSync(path);
    return {
      kind: "file",
      sizeBytes: status.size,
      fingerprint: createHash("sha256")
        .update(`file\0${identity(status)}\0`, "utf8")
        .update(contents)
        .digest("hex"),
    };
  }
  if (status.isSocket())
    return {
      kind: "socket",
      sizeBytes: status.size,
      fingerprint: createHash("sha256")
        .update(`socket\0${identity(status)}`, "utf8")
        .digest("hex"),
    };
  if (status.isDirectory()) {
    const hash = createHash("sha256").update(
      `directory\0${identity(status)}\0`,
      "utf8",
    );
    let sizeBytes = 0;
    for (const name of readdirSync(path).sort()) {
      const child = fingerprintPath(join(path, name));
      sizeBytes += child.sizeBytes;
      hash.update(name, "utf8").update("\0", "utf8");
      hash.update(child.kind, "utf8").update("\0", "utf8");
      hash.update(child.fingerprint, "utf8").update("\0", "utf8");
    }
    return { kind: "directory", sizeBytes, fingerprint: hash.digest("hex") };
  }
  throw new LocalRuntimePurgeError(
    `Runtime purge found an unsupported filesystem entry: ${path}`,
  );
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
        .update(`directory\0${identity(state)}`, "utf8")
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
      let fingerprinted: FingerprintedPath;
      try {
        fingerprinted = fingerprintPath(join(stateDirectory, name));
      } catch (error) {
        if (error instanceof LocalRuntimePurgeError) throw error;
        throw new LocalRuntimePurgeError(
          `Runtime purge could not inspect an artifact safely: ${relativePath}`,
        );
      }
      if (fingerprinted.kind !== expectedKind) {
        preservedPaths.push(relativePath);
        continue;
      }
      artifacts.push({ relativePath, ...fingerprinted });
    }
    artifacts.sort(
      (left, right) =>
        removalRank(left.relativePath) - removalRank(right.relativePath),
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
        rmSync(targetPath, {
          recursive: artifact.kind === "directory",
          force: false,
        });
      } catch {
        throw new LocalRuntimePurgeError(
          `Runtime purge stopped after removing ${removedPaths.length} artifact(s); inspect the remaining state and generate a new plan`,
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

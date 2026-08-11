import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type {
  ConnectorFilePrecondition,
  ConnectorInvocationResult,
  ConnectorMutationExecutionResult,
  ConnectorReadResult,
  ConnectorSimulationResult,
} from "@ai-office/connector-sdk/connector.ts";
import {
  ConnectorMutationExecutionError,
  UnsupportedConnectorOperationError,
} from "@ai-office/connector-sdk/errors.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type { EffectiveFilesystemConstraints } from "./filesystem-constraints.ts";
import {
  FilesystemBinaryFileError,
  FilesystemDestinationExistsError,
  FilesystemEntryNotFoundError,
  FilesystemFileTooLargeError,
  FilesystemHardLinkDeniedError,
  FilesystemNotDirectoryError,
  FilesystemNotRegularFileError,
  FilesystemOperationAbortedError,
  FilesystemOutputTooLargeError,
  FilesystemSourceChangedError,
  FilesystemSymlinkDeniedError,
  InvalidRelativePathError,
  SensitiveFilesystemPathError,
  SourcePreconditionFailedError,
  UnsupportedFilesystemPlatformError,
} from "./errors.ts";
import {
  classifyAllowedPath,
  normalizeRelativePath,
  resolveContainedPath,
} from "./filesystem-path.ts";
import { isSensitiveFilesystemPath } from "./sensitive-paths.ts";
import {
  absentPrecondition,
  filePreconditionFromMetadata,
  sha256Bytes,
} from "./source-preconditions.ts";
import { combineUnifiedDiffs, createUnifiedDiff } from "./unified-diff.ts";

interface TextFile {
  bytes: Uint8Array;
  content: string;
  sha256: string;
}

export interface FilesystemSandboxHooks {
  beforeDirectoryRead?(path: string, absolutePath: string): void;
  afterDirectoryRead?(path: string, absolutePath: string): void;
  beforeFileOpen?(path: string, absolutePath: string): void;
  afterFileClose?(path: string): void;
  onDirectoryEntry?(directoryPath: string, name: string, visited: number): void;
  hashBytes?(bytes: Uint8Array): string;
  beforeMutationCommit?(operation: string): void;
  afterMutationCommit?(operation: string): void;
  beforeParentFsync?(operation: string): void;
}

interface TraversalBudget {
  visitedEntries: number;
  visitedFiles: number;
  visitedDirectories: number;
}

interface BoundedDirectoryEntries {
  names: readonly string[];
  truncated: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalStringify(value)).byteLength;
}

function extension(path: string): string {
  const basename = path.split("/").at(-1) ?? "";
  const index = basename.lastIndexOf(".");
  return index <= 0 ? "" : basename.slice(index).toLowerCase();
}

function safeSnippet(line: string, column: number): string {
  const normalized = line
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(
      /\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    );
  const start = Math.max(0, column - 60);
  return normalized.slice(start, start + 160);
}

export class FilesystemSandbox {
  constructor(
    private readonly root: string,
    private readonly constraints: EffectiveFilesystemConstraints,
    private readonly hooks: FilesystemSandboxHooks = {},
    private readonly signal?: AbortSignal,
  ) {
    this.assertRoot();
  }

  invoke(
    operation: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorInvocationResult {
    if (operation === "filesystem.list") return this.list(arguments_);
    if (operation === "filesystem.read") return this.read(arguments_);
    if (operation === "filesystem.search") return this.search(arguments_);
    if (operation === "filesystem.create")
      return this.simulateCreate(arguments_);
    if (operation === "filesystem.write") return this.simulateWrite(arguments_);
    if (operation === "filesystem.move") return this.simulateMove(arguments_);
    if (operation === "filesystem.delete")
      return this.simulateDelete(arguments_);
    throw new UnsupportedConnectorOperationError("filesystem", operation);
  }

  verifyPreconditions(
    preconditions: readonly ConnectorFilePrecondition[],
  ): void {
    for (const precondition of preconditions) {
      this.assertEffectivePath(precondition.path, false);
      this.throwIfAborted();
      this.assertInsideAllowed(precondition.path);
      if (precondition.kind === "absent") {
        if (!this.isAbsent(precondition.path))
          throw new SourcePreconditionFailedError();
        continue;
      }
      const file = this.readTextFile(precondition.path);
      if (
        file.sha256 !== precondition.sha256 ||
        file.bytes.byteLength !== precondition.size
      )
        throw new SourcePreconditionFailedError();
    }
  }

  executeMutation(
    operation: string,
    arguments_: Readonly<Record<string, unknown>>,
    preconditions: readonly ConnectorFilePrecondition[],
  ): ConnectorMutationExecutionResult {
    try {
      this.throwIfAborted();
      this.assertMutationPermitted();
      this.assertExecutionPreconditions(operation, arguments_, preconditions);
      this.verifyPreconditions(preconditions);
      if (operation === "filesystem.create")
        return this.executeCreate(arguments_, preconditions);
      if (operation === "filesystem.write")
        return this.executeWrite(arguments_, preconditions);
      if (operation === "filesystem.move")
        return this.executeMove(arguments_, preconditions);
      if (operation === "filesystem.delete")
        return this.executeDelete(arguments_, preconditions);
      throw new UnsupportedConnectorOperationError("filesystem", operation);
    } catch (error) {
      throw this.mutationError(error, false);
    }
  }

  private assertRoot(): void {
    let stats: Stats;
    try {
      stats = lstatSync(this.root);
    } catch {
      throw new FilesystemEntryNotFoundError();
    }
    if (stats.isSymbolicLink()) throw new FilesystemSymlinkDeniedError();
    if (!stats.isDirectory()) throw new FilesystemNotDirectoryError();
    if (realpathSync(this.root) !== this.root)
      throw new FilesystemSymlinkDeniedError();
  }

  private assertVisible(path: string): void {
    if (isSensitiveFilesystemPath(path, this.constraints.deniedPathPrefixes))
      throw new SensitiveFilesystemPathError();
  }

  private classifyPath(
    path: string,
  ): "inside_allowed" | "ancestor_of_allowed" | "denied" {
    if (isSensitiveFilesystemPath(path, this.constraints.deniedPathPrefixes))
      return "denied";
    return classifyAllowedPath(path, this.constraints.allowedPathPrefixes);
  }

  private extensionPermitted(path: string): boolean {
    const allowed = this.constraints.allowedExtensions;
    return allowed === undefined || allowed.includes(extension(path));
  }

  private assertInsideAllowed(path: string): void {
    if (this.classifyPath(path) !== "inside_allowed")
      throw new SensitiveFilesystemPathError();
  }

  private assertAccessibleByType(path: string, stats: Stats): void {
    const classification = this.classifyPath(path);
    if (
      classification === "denied" ||
      (stats.isFile() && classification !== "inside_allowed")
    )
      throw new SensitiveFilesystemPathError();
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) throw new FilesystemOperationAbortedError();
  }

  private traversalBudget(): TraversalBudget {
    return { visitedEntries: 0, visitedFiles: 0, visitedDirectories: 0 };
  }

  private assertMutationPermitted(): void {
    if (!this.constraints.allowMutation)
      throw new SensitiveFilesystemPathError();
  }

  private assertEffectivePath(path: unknown, allowRoot: boolean): string {
    if (typeof path !== "string") throw new InvalidRelativePathError();
    const normalized = normalizeRelativePath(path, this.constraints, {
      allowRoot,
    });
    if (normalized !== path) throw new InvalidRelativePathError();
    return normalized;
  }

  private isPortableDiscoveredPath(path: string): boolean {
    try {
      return (
        normalizeRelativePath(path, this.constraints, { allowRoot: false }) ===
        path
      );
    } catch {
      return false;
    }
  }

  private inspect(path: string): { absolute: string; stats: Stats } {
    this.assertRoot();
    this.assertVisible(path);
    const segments = path === "" ? [] : path.split("/");
    let current = this.root;
    let stats = lstatSync(this.root);
    for (let index = 0; index < segments.length; index += 1) {
      current = resolveContainedPath(current, segments[index]!);
      try {
        stats = lstatSync(current);
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          throw new FilesystemEntryNotFoundError();
        throw new FilesystemSourceChangedError();
      }
      if (stats.isSymbolicLink()) throw new FilesystemSymlinkDeniedError();
      if (index < segments.length - 1 && !stats.isDirectory())
        throw new FilesystemNotDirectoryError();
    }
    const absolute = resolveContainedPath(this.root, path);
    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        throw new FilesystemEntryNotFoundError();
      throw new FilesystemSourceChangedError();
    }
    const relation = resolveContainedPath(this.root, path);
    if (canonical !== relation) throw new FilesystemSymlinkDeniedError();
    return { absolute, stats };
  }

  private inspectDiscovered(
    path: string,
  ): { absolute: string; stats: Stats } | null {
    try {
      return this.inspect(path);
    } catch (error) {
      if (
        error instanceof FilesystemEntryNotFoundError ||
        error instanceof FilesystemSymlinkDeniedError ||
        error instanceof SensitiveFilesystemPathError
      )
        return null;
      throw error;
    }
  }

  private revalidateDirectory(path: string, expected: Stats): void {
    const current = this.inspect(path);
    if (
      !current.stats.isDirectory() ||
      current.stats.dev !== expected.dev ||
      current.stats.ino !== expected.ino
    )
      throw new FilesystemSourceChangedError();
  }

  private readBoundedDirectory(
    path: string,
    budget: TraversalBudget,
  ): BoundedDirectoryEntries {
    this.throwIfAborted();
    if (
      budget.visitedDirectories >= this.constraints.maxVisitedDirectories ||
      budget.visitedEntries >= this.constraints.maxVisitedEntries
    )
      return { names: Object.freeze([]), truncated: true };
    const inspectedDirectory = this.inspect(path);
    if (!inspectedDirectory.stats.isDirectory())
      throw new FilesystemNotDirectoryError();
    this.assertAccessibleByType(path, inspectedDirectory.stats);
    this.hooks.beforeDirectoryRead?.(path, inspectedDirectory.absolute);
    this.throwIfAborted();
    const currentDirectory = this.inspect(path);
    if (!currentDirectory.stats.isDirectory())
      throw new FilesystemNotDirectoryError();
    this.assertAccessibleByType(path, currentDirectory.stats);
    budget.visitedDirectories += 1;
    let directory: ReturnType<typeof opendirSync>;
    try {
      directory = opendirSync(currentDirectory.absolute);
    } catch {
      throw new FilesystemSourceChangedError();
    }
    const names: string[] = [];
    let truncated = false;
    try {
      while (true) {
        this.throwIfAborted();
        if (budget.visitedEntries >= this.constraints.maxVisitedEntries) {
          truncated = true;
          break;
        }
        let entry: Dirent | null;
        try {
          entry = directory.readSync();
        } catch {
          throw new FilesystemSourceChangedError();
        }
        if (entry === null) break;
        budget.visitedEntries += 1;
        this.hooks.onDirectoryEntry?.(path, entry.name, budget.visitedEntries);
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    this.hooks.afterDirectoryRead?.(path, currentDirectory.absolute);
    this.throwIfAborted();
    this.revalidateDirectory(path, currentDirectory.stats);
    names.sort();
    return {
      names: Object.freeze(truncated ? [] : names),
      truncated,
    };
  }

  private validateParent(path: string): void {
    const parent = dirname(path).replaceAll("\\", "/");
    const normalizedParent = parent === "." ? "" : parent;
    const inspected = this.inspect(normalizedParent);
    if (!inspected.stats.isDirectory()) throw new FilesystemNotDirectoryError();
  }

  private parentPath(path: string): string {
    const parent = dirname(path).replaceAll("\\", "/");
    return parent === "." ? "" : parent;
  }

  private assertExecutionPreconditions(
    operation: string,
    arguments_: Readonly<Record<string, unknown>>,
    preconditions: readonly ConnectorFilePrecondition[],
  ): void {
    const path =
      typeof arguments_.path === "string"
        ? this.assertEffectivePath(arguments_.path, false)
        : undefined;
    const sourcePath =
      typeof arguments_.sourcePath === "string"
        ? this.assertEffectivePath(arguments_.sourcePath, false)
        : undefined;
    const destinationPath =
      typeof arguments_.destinationPath === "string"
        ? this.assertEffectivePath(arguments_.destinationPath, false)
        : undefined;
    const matches = (
      value: ConnectorFilePrecondition | undefined,
      kind: "absent" | "file",
      expectedPath: string | undefined,
    ) => value?.kind === kind && value.path === expectedPath;
    const valid =
      (operation === "filesystem.create" &&
        preconditions.length === 1 &&
        matches(preconditions[0], "absent", path)) ||
      ((operation === "filesystem.write" ||
        operation === "filesystem.delete") &&
        preconditions.length === 1 &&
        matches(preconditions[0], "file", path)) ||
      (operation === "filesystem.move" &&
        preconditions.length === 2 &&
        matches(preconditions[0], "file", sourcePath) &&
        matches(preconditions[1], "absent", destinationPath));
    if (!valid) throw new SourcePreconditionFailedError();
  }

  private executeCreate(
    arguments_: Readonly<Record<string, unknown>>,
    preconditions: readonly ConnectorFilePrecondition[],
  ): ConnectorMutationExecutionResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    const content = arguments_.content as string;
    this.assertInsideAllowed(path);
    this.assertInlineContent(content);
    const bytes = Buffer.from(content, "utf8");
    const contentHash = sha256Bytes(bytes);
    return this.withStagedFile(path, bytes, (temp, target, markCommitted) => {
      this.verifyPreconditions(preconditions);
      this.hooks.beforeMutationCommit?.("filesystem.create");
      linkSync(temp, target);
      markCommitted();
      this.hooks.afterMutationCommit?.("filesystem.create");
      unlinkSync(temp);
      this.fsyncParent(path, "filesystem.create");
      return {
        resultHash: contentHash,
        audit: { relativePath: path, byteLength: bytes.byteLength },
      };
    });
  }

  private executeWrite(
    arguments_: Readonly<Record<string, unknown>>,
    preconditions: readonly ConnectorFilePrecondition[],
  ): ConnectorMutationExecutionResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    const content = arguments_.content as string;
    this.assertInsideAllowed(path);
    this.assertInlineContent(content);
    const bytes = Buffer.from(content, "utf8");
    const contentHash = sha256Bytes(bytes);
    return this.withStagedFile(path, bytes, (temp, target, markCommitted) => {
      this.verifyPreconditions(preconditions);
      this.hooks.beforeMutationCommit?.("filesystem.write");
      renameSync(temp, target);
      markCommitted();
      this.hooks.afterMutationCommit?.("filesystem.write");
      this.fsyncParent(path, "filesystem.write");
      return {
        resultHash: contentHash,
        audit: { relativePath: path, byteLength: bytes.byteLength },
      };
    });
  }

  private executeMove(
    arguments_: Readonly<Record<string, unknown>>,
    preconditions: readonly ConnectorFilePrecondition[],
  ): ConnectorMutationExecutionResult {
    const sourcePath = this.assertEffectivePath(arguments_.sourcePath, false);
    const destinationPath = this.assertEffectivePath(
      arguments_.destinationPath,
      false,
    );
    this.assertInsideAllowed(sourcePath);
    this.assertInsideAllowed(destinationPath);
    let committed = false;
    try {
      this.verifyPreconditions(preconditions);
      const source = this.inspect(sourcePath);
      const destinationParent = this.inspect(this.parentPath(destinationPath));
      if (!source.stats.isFile()) throw new FilesystemNotRegularFileError();
      if (source.stats.nlink > 1) throw new FilesystemHardLinkDeniedError();
      if (!destinationParent.stats.isDirectory())
        throw new FilesystemNotDirectoryError();
      this.hooks.beforeMutationCommit?.("filesystem.move");
      renameSync(source.absolute, resolveContainedPath(this.root, destinationPath));
      committed = true;
      this.hooks.afterMutationCommit?.("filesystem.move");
      this.fsyncParent(sourcePath, "filesystem.move");
      if (this.parentPath(sourcePath) !== this.parentPath(destinationPath))
        this.fsyncParent(destinationPath, "filesystem.move");
      const sourcePrecondition = preconditions[0]!;
      return {
        ...(sourcePrecondition.sha256 === undefined
          ? {}
          : { resultHash: sourcePrecondition.sha256 }),
        audit: {
          relativePath: sourcePath,
          destinationPath,
          ...(sourcePrecondition.size === undefined
            ? {}
            : { byteLength: sourcePrecondition.size }),
        },
      };
    } catch (error) {
      throw this.mutationError(error, committed);
    }
  }

  private executeDelete(
    arguments_: Readonly<Record<string, unknown>>,
    preconditions: readonly ConnectorFilePrecondition[],
  ): ConnectorMutationExecutionResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    this.assertInsideAllowed(path);
    let committed = false;
    try {
      this.verifyPreconditions(preconditions);
      const source = this.inspect(path);
      if (!source.stats.isFile()) throw new FilesystemNotRegularFileError();
      if (source.stats.nlink > 1) throw new FilesystemHardLinkDeniedError();
      this.hooks.beforeMutationCommit?.("filesystem.delete");
      unlinkSync(source.absolute);
      committed = true;
      this.hooks.afterMutationCommit?.("filesystem.delete");
      this.fsyncParent(path, "filesystem.delete");
      const sourcePrecondition = preconditions[0]!;
      return {
        ...(sourcePrecondition.sha256 === undefined
          ? {}
          : { resultHash: sourcePrecondition.sha256 }),
        audit: {
          relativePath: path,
          ...(sourcePrecondition.size === undefined
            ? {}
            : { byteLength: sourcePrecondition.size }),
        },
      };
    } catch (error) {
      throw this.mutationError(error, committed);
    }
  }

  private withStagedFile<T>(
    path: string,
    bytes: Uint8Array,
    commit: (
      tempAbsolute: string,
      targetAbsolute: string,
      markCommitted: () => void,
    ) => T,
  ): T {
    this.validateParent(path);
    const parent = this.inspect(this.parentPath(path));
    if (!parent.stats.isDirectory()) throw new FilesystemNotDirectoryError();
    const target = resolveContainedPath(this.root, path);
    let descriptor: number | undefined;
    let temp: string | undefined;
    let committed = false;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        temp = resolveContainedPath(
          parent.absolute,
          `.ai-office-txn-${randomUUID()}`,
        );
        try {
          descriptor = openSync(
            temp,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          break;
        } catch (error) {
          if (errorCode(error) !== "EEXIST" || attempt === 2) throw error;
        }
      }
      if (descriptor === undefined || temp === undefined)
        throw new FilesystemSourceChangedError();
      let offset = 0;
      while (offset < bytes.byteLength) {
        this.throwIfAborted();
        offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      const result = commit(temp, target, () => {
        committed = true;
      });
      return result;
    } catch (error) {
      throw this.mutationError(error, committed);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temp !== undefined) {
        try {
          unlinkSync(temp);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            // Reserved staging entries are never exposed; cleanup is best effort.
          }
        }
      }
    }
  }

  private fsyncParent(path: string, operation: string): void {
    this.hooks.beforeParentFsync?.(operation);
    const parent = this.inspect(this.parentPath(path));
    const directoryFlag = constants.O_DIRECTORY;
    if (typeof directoryFlag !== "number")
      throw new FilesystemSourceChangedError();
    const descriptor = openSync(
      parent.absolute,
      constants.O_RDONLY | directoryFlag | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private mutationError(
    error: unknown,
    committed: boolean,
  ): ConnectorMutationExecutionError {
    if (error instanceof ConnectorMutationExecutionError) return error;
    const code =
      errorCode(error) ??
      (error instanceof Error && error.name.length > 0
        ? error.name
        : "FilesystemMutationFailed");
    return new ConnectorMutationExecutionError(
      code,
      committed ? "mutation_may_have_occurred" : "definite_no_mutation",
    );
  }

  private isAbsent(path: string): boolean {
    this.assertVisible(path);
    this.validateParent(path);
    const absolute = resolveContainedPath(this.root, path);
    try {
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) throw new FilesystemSymlinkDeniedError();
      return false;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
  }

  private requireAbsent(path: string): void {
    if (!this.isAbsent(path)) throw new FilesystemDestinationExistsError();
  }

  private readTextFile(path: string): TextFile {
    this.throwIfAborted();
    if (!this.extensionPermitted(path))
      throw new SensitiveFilesystemPathError();
    const inspected = this.inspect(path);
    if (!inspected.stats.isFile()) throw new FilesystemNotRegularFileError();
    if (inspected.stats.nlink > 1) throw new FilesystemHardLinkDeniedError();
    if (inspected.stats.size > this.constraints.maxFileBytes)
      throw new FilesystemFileTooLargeError();

    this.hooks.beforeFileOpen?.(path, inspected.absolute);
    this.throwIfAborted();

    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number")
      throw new UnsupportedFilesystemPlatformError();
    let descriptor: number;
    try {
      descriptor = openSync(
        inspected.absolute,
        constants.O_RDONLY | noFollow | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (errorCode(error) === "ELOOP")
        throw new FilesystemSymlinkDeniedError();
      if (
        errorCode(error) === "ENOENT" ||
        errorCode(error) === "ENOTDIR" ||
        errorCode(error) === "EACCES" ||
        errorCode(error) === "EPERM"
      )
        throw new FilesystemEntryNotFoundError();
      throw new FilesystemSourceChangedError();
    }
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile()) throw new FilesystemNotRegularFileError();
      if (before.nlink > 1) throw new FilesystemHardLinkDeniedError();
      if (
        before.dev !== inspected.stats.dev ||
        before.ino !== inspected.stats.ino
      )
        throw new FilesystemSourceChangedError();
      this.assertOpenedPathStillContained(path, before);
      if (before.size > this.constraints.maxFileBytes)
        throw new FilesystemFileTooLargeError();

      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        this.throwIfAborted();
        const buffer = Buffer.allocUnsafe(
          Math.min(64 * 1024, this.constraints.maxFileBytes + 1 - total),
        );
        if (buffer.byteLength === 0) throw new FilesystemFileTooLargeError();
        const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
        if (read === 0) break;
        total += read;
        if (total > this.constraints.maxFileBytes)
          throw new FilesystemFileTooLargeError();
        chunks.push(buffer.subarray(0, read));
      }
      const after = fstatSync(descriptor);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.nlink !== before.nlink
      )
        throw new FilesystemSourceChangedError();
      this.assertOpenedPathStillContained(path, after);
      const bytes = Buffer.concat(chunks, total);
      if (bytes.includes(0)) throw new FilesystemBinaryFileError();
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new FilesystemBinaryFileError();
      }
      const sha256 = (this.hooks.hashBytes ?? sha256Bytes)(bytes);
      if (!/^[0-9a-f]{64}$/u.test(sha256))
        throw new FilesystemSourceChangedError();
      return { bytes, content, sha256 };
    } finally {
      closeSync(descriptor);
      this.hooks.afterFileClose?.(path);
    }
  }

  private assertOpenedPathStillContained(path: string, opened: Stats): void {
    const current = this.inspect(path);
    if (
      !current.stats.isFile() ||
      current.stats.dev !== opened.dev ||
      current.stats.ino !== opened.ino ||
      opened.nlink > 1 ||
      current.stats.nlink > 1
    )
      throw new FilesystemSourceChangedError();
  }

  private list(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorReadResult {
    const start = this.assertEffectivePath(arguments_.path, true);
    this.throwIfAborted();
    const recursive = arguments_.recursive as boolean;
    const inspected = this.inspect(start);
    this.assertAccessibleByType(start, inspected.stats);
    if (!inspected.stats.isDirectory()) throw new FilesystemNotDirectoryError();
    const entries: Array<Readonly<Record<string, unknown>>> = [];
    const pending: Array<{ path: string; depth: number }> = [
      { path: start, depth: 0 },
    ];
    const budget = this.traversalBudget();
    let truncated = false;
    while (pending.length > 0) {
      this.throwIfAborted();
      const current = pending.shift()!;
      const directory = this.readBoundedDirectory(current.path, budget);
      if (directory.truncated) truncated = true;
      for (const name of directory.names) {
        this.throwIfAborted();
        const path = current.path === "" ? name : `${current.path}/${name}`;
        if (!this.isPortableDiscoveredPath(path)) continue;
        const depth = current.depth + 1;
        const discovered = this.inspectDiscovered(path);
        if (discovered === null) continue;
        const stats = discovered.stats;
        const classification = this.classifyPath(path);
        if (
          classification === "denied" ||
          (stats.isFile() && classification !== "inside_allowed")
        )
          continue;
        if (stats.isFile() && stats.nlink > 1) continue;
        if (!stats.isFile() && !stats.isDirectory()) continue;
        if (stats.isFile()) {
          if (budget.visitedFiles >= this.constraints.maxVisitedFiles) {
            truncated = true;
            break;
          }
          budget.visitedFiles += 1;
          if (!this.extensionPermitted(path)) continue;
        }
        if (depth > this.constraints.maxDepth) {
          truncated = true;
          continue;
        }
        const entry = Object.freeze({
          path,
          kind: stats.isDirectory() ? "directory" : "file",
          ...(stats.isFile() ? { byteLength: stats.size } : {}),
        });
        if (entries.length >= this.constraints.maxResults) {
          truncated = true;
          break;
        }
        const candidate = {
          path: start,
          entries: [...entries, entry],
          truncated,
        };
        if (byteLength(candidate) > this.constraints.maxOutputBytes) {
          truncated = true;
          break;
        }
        entries.push(entry);
        if (recursive && stats.isDirectory()) pending.push({ path, depth });
      }
      if (truncated) break;
      if (!recursive) break;
    }
    const output = Object.freeze({
      path: start,
      entries: Object.freeze(entries),
      truncated,
    });
    if (byteLength(output) > this.constraints.maxOutputBytes)
      throw new FilesystemOutputTooLargeError();
    return {
      kind: "read",
      output,
      audit: { relativePath: start, resultCount: entries.length, truncated },
    };
  }

  private read(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorReadResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    this.assertInsideAllowed(path);
    const file = this.readTextFile(path);
    const output = Object.freeze({
      path,
      content: file.content,
      byteLength: file.bytes.byteLength,
      sha256: file.sha256,
      finalNewline: file.content.endsWith("\n"),
    });
    if (byteLength(output) > this.constraints.maxOutputBytes)
      throw new FilesystemOutputTooLargeError();
    return {
      kind: "read",
      output,
      audit: {
        relativePath: path,
        byteLength: file.bytes.byteLength,
        contentSha256: file.sha256,
      },
    };
  }

  private search(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorReadResult {
    const start = this.assertEffectivePath(arguments_.path, true);
    this.throwIfAborted();
    const query = arguments_.query as string;
    const caseSensitive = arguments_.caseSensitive as boolean;
    const inspected = this.inspect(start);
    this.assertAccessibleByType(start, inspected.stats);
    const files: string[] = [];
    const pending: Array<{ path: string; depth: number }> = [];
    const budget = this.traversalBudget();
    let truncated = false;
    if (inspected.stats.isFile()) {
      if (this.constraints.maxVisitedFiles === 0) truncated = true;
      else {
        budget.visitedFiles += 1;
        files.push(start);
      }
    } else if (inspected.stats.isDirectory())
      pending.push({ path: start, depth: 0 });
    else throw new FilesystemNotRegularFileError();
    while (pending.length > 0 && !truncated) {
      this.throwIfAborted();
      const current = pending.shift()!;
      const directory = this.readBoundedDirectory(current.path, budget);
      if (directory.truncated) truncated = true;
      for (const name of directory.names) {
        this.throwIfAborted();
        const path = current.path === "" ? name : `${current.path}/${name}`;
        if (!this.isPortableDiscoveredPath(path)) continue;
        const depth = current.depth + 1;
        const discovered = this.inspectDiscovered(path);
        if (discovered === null) continue;
        const stats = discovered.stats;
        const classification = this.classifyPath(path);
        if (stats.isDirectory()) {
          if (classification === "denied") continue;
          if (depth < this.constraints.maxDepth) pending.push({ path, depth });
          else truncated = true;
        } else if (stats.isFile()) {
          if (classification !== "inside_allowed") continue;
          if (stats.nlink > 1) throw new FilesystemHardLinkDeniedError();
          if (budget.visitedFiles >= this.constraints.maxVisitedFiles) {
            truncated = true;
            break;
          }
          budget.visitedFiles += 1;
          if (!this.extensionPermitted(path)) continue;
          files.push(path);
        }
      }
    }
    files.sort();
    const matches: Array<Readonly<Record<string, unknown>>> = [];
    const needle = caseSensitive ? query : query.toLowerCase();
    for (const path of files) {
      this.throwIfAborted();
      this.assertInsideAllowed(path);
      const file = this.readTextFile(path);
      const lines = file.content.replaceAll("\r\n", "\n").split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const haystack = caseSensitive ? line : line.toLowerCase();
        let from = 0;
        while (from <= haystack.length) {
          const column = haystack.indexOf(needle, from);
          if (column < 0) break;
          if (matches.length >= this.constraints.maxResults) {
            truncated = true;
            break;
          }
          const match = Object.freeze({
            path,
            line: lineIndex + 1,
            column: column + 1,
            excerpt: safeSnippet(line, column),
          });
          const candidate = {
            path: start,
            matches: [...matches, match],
            truncated,
            visitedFiles: files.length,
          };
          if (byteLength(candidate) > this.constraints.maxOutputBytes) {
            truncated = true;
            break;
          }
          matches.push(match);
          from = column + Math.max(1, needle.length);
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    const output = Object.freeze({
      path: start,
      matches: Object.freeze(matches),
      truncated,
      visitedFiles: files.length,
    });
    if (byteLength(output) > this.constraints.maxOutputBytes)
      throw new FilesystemOutputTooLargeError();
    return {
      kind: "read",
      output,
      audit: {
        relativePath: start,
        resultCount: matches.length,
        truncated,
      },
    };
  }

  private simulateCreate(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorSimulationResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    const content = arguments_.content as string;
    this.assertMutationPermitted();
    this.assertInsideAllowed(path);
    this.assertInlineContent(content);
    this.assertVisible(path);
    this.requireAbsent(path);
    const diff = createUnifiedDiff({
      oldPath: null,
      newPath: path,
      oldContent: "",
      newContent: content,
      maxBytes: this.constraints.maxDiffBytes,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    return this.simulation(diff, [absentPrecondition(path)]);
  }

  private simulateWrite(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorSimulationResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    const content = arguments_.content as string;
    this.assertMutationPermitted();
    this.assertInsideAllowed(path);
    this.assertInlineContent(content);
    const source = this.readTextFile(path);
    this.validateParent(path);
    const diff = createUnifiedDiff({
      oldPath: path,
      newPath: path,
      oldContent: source.content,
      newContent: content,
      maxBytes: this.constraints.maxDiffBytes,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    return this.simulation(diff, [
      filePreconditionFromMetadata(
        path,
        source.sha256,
        source.bytes.byteLength,
      ),
    ]);
  }

  private simulateDelete(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorSimulationResult {
    const path = this.assertEffectivePath(arguments_.path, false);
    this.assertMutationPermitted();
    this.assertInsideAllowed(path);
    const source = this.readTextFile(path);
    const diff = createUnifiedDiff({
      oldPath: path,
      newPath: null,
      oldContent: source.content,
      newContent: "",
      maxBytes: this.constraints.maxDiffBytes,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    return this.simulation(diff, [
      filePreconditionFromMetadata(
        path,
        source.sha256,
        source.bytes.byteLength,
      ),
    ]);
  }

  private simulateMove(
    arguments_: Readonly<Record<string, unknown>>,
  ): ConnectorSimulationResult {
    const sourcePath = this.assertEffectivePath(arguments_.sourcePath, false);
    const destinationPath = this.assertEffectivePath(
      arguments_.destinationPath,
      false,
    );
    this.assertMutationPermitted();
    this.assertInsideAllowed(sourcePath);
    this.assertInsideAllowed(destinationPath);
    const source = this.readTextFile(sourcePath);
    this.assertVisible(destinationPath);
    this.requireAbsent(destinationPath);
    const diff = combineUnifiedDiffs(
      [
        createUnifiedDiff({
          oldPath: sourcePath,
          newPath: null,
          oldContent: source.content,
          newContent: "",
          maxBytes: this.constraints.maxDiffBytes,
          ...(this.signal === undefined ? {} : { signal: this.signal }),
        }),
        createUnifiedDiff({
          oldPath: null,
          newPath: destinationPath,
          oldContent: "",
          newContent: source.content,
          maxBytes: this.constraints.maxDiffBytes,
          ...(this.signal === undefined ? {} : { signal: this.signal }),
        }),
      ],
      this.constraints.maxDiffBytes,
      this.signal,
    );
    return this.simulation(diff, [
      filePreconditionFromMetadata(
        sourcePath,
        source.sha256,
        source.bytes.byteLength,
      ),
      absentPrecondition(destinationPath),
    ]);
  }

  private simulation(
    diff: string,
    preconditions: readonly ConnectorFilePrecondition[],
  ): ConnectorSimulationResult {
    if (
      new TextEncoder().encode(diff).byteLength > this.constraints.maxDiffBytes
    )
      throw new FilesystemOutputTooLargeError();
    return {
      kind: "simulation",
      diff,
      preconditions: Object.freeze([...preconditions]),
    };
  }

  private assertInlineContent(content: string): void {
    const bytes = new TextEncoder().encode(content).byteLength;
    if (
      bytes > this.constraints.maxInlineContentBytes ||
      bytes > this.constraints.maxFileBytes
    )
      throw new FilesystemFileTooLargeError();
  }
}

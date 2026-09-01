import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { ProjectArchiveAdapter } from "@ai-office/application/ports/project-archive-adapter.port.ts";
import {
  maximumPortableProjectBytes,
  portableProjectExtension,
  PortableProjectArchiveError,
} from "@ai-office/application/project-portability/project-snapshot.ts";

interface FileStatus {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}

export interface ProjectArchiveFileSystem {
  exists(path: string): boolean;
  openReadNoFollow(path: string): number;
  openExclusivePrivate(path: string): number;
  status(descriptor: number): FileStatus;
  read(descriptor: number): string;
  write(descriptor: number, contents: string): void;
  sync(descriptor: number): void;
  close(descriptor: number): void;
  realpath(path: string): string;
  pathStatus(path: string): FileStatus;
  link(source: string, destination: string): void;
  unlink(path: string): void;
}

export const nodeProjectArchiveFileSystem: ProjectArchiveFileSystem = {
  exists: existsSync,
  openReadNoFollow: (path) =>
    openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  openExclusivePrivate: (path) => openSync(path, "wx", 0o600),
  status: fstatSync,
  read: (descriptor) => readFileSync(descriptor, "utf8"),
  write: (descriptor, contents) => writeFileSync(descriptor, contents, "utf8"),
  sync: fsyncSync,
  close: closeSync,
  realpath: realpathSync,
  pathStatus: lstatSync,
  link: linkSync,
  unlink: unlinkSync,
};

export class LocalProjectArchiveAdapter implements ProjectArchiveAdapter {
  constructor(
    private readonly fileSystem: ProjectArchiveFileSystem = nodeProjectArchiveFileSystem,
  ) {}

  async read(path: string): Promise<string> {
    const absolutePath = resolve(path);
    if (extname(absolutePath) !== portableProjectExtension)
      throw new PortableProjectArchiveError(
        `Portable project archive must use ${portableProjectExtension}`,
      );
    let descriptor: number | null = null;
    try {
      descriptor = this.fileSystem.openReadNoFollow(absolutePath);
      const status = this.fileSystem.status(descriptor);
      if (!status.isFile())
        throw new PortableProjectArchiveError(
          "Portable project archive must be a regular, non-symlink file",
        );
      if (status.size > maximumPortableProjectBytes)
        throw new PortableProjectArchiveError(
          `Portable project archive exceeds ${maximumPortableProjectBytes} bytes`,
        );
      return this.fileSystem.read(descriptor);
    } catch (error) {
      if (error instanceof PortableProjectArchiveError) throw error;
      throw new PortableProjectArchiveError(
        this.fileSystem.exists(absolutePath)
          ? "Portable project archive must be a readable, regular, non-symlink file"
          : `Portable project archive does not exist: ${absolutePath}`,
      );
    } finally {
      if (descriptor !== null) this.fileSystem.close(descriptor);
    }
  }

  async write(path: string, contents: string): Promise<void> {
    const absolutePath = resolve(path);
    if (extname(absolutePath) !== portableProjectExtension)
      throw new PortableProjectArchiveError(
        `Portable project archive must use ${portableProjectExtension}`,
      );
    if (Buffer.byteLength(contents, "utf8") > maximumPortableProjectBytes)
      throw new PortableProjectArchiveError(
        `Portable project archive exceeds ${maximumPortableProjectBytes} bytes`,
      );
    if (this.fileSystem.exists(absolutePath))
      throw new PortableProjectArchiveError(
        `Refusing to overwrite existing portable project archive: ${absolutePath}`,
      );
    let parent: string;
    try {
      parent = this.fileSystem.realpath(dirname(absolutePath));
    } catch {
      throw new PortableProjectArchiveError(
        `Portable project archive parent does not exist: ${dirname(absolutePath)}`,
      );
    }
    if (!this.fileSystem.pathStatus(parent).isDirectory())
      throw new PortableProjectArchiveError(
        `Portable project archive parent is not a directory: ${parent}`,
      );
    const temporaryPath = join(
      parent,
      `.ai-office-project-${randomUUID()}.tmp`,
    );
    let descriptor: number | null = null;
    try {
      descriptor = this.fileSystem.openExclusivePrivate(temporaryPath);
      this.fileSystem.write(descriptor, contents);
      this.fileSystem.sync(descriptor);
      this.fileSystem.close(descriptor);
      descriptor = null;
      this.fileSystem.link(temporaryPath, absolutePath);
      this.fileSystem.unlink(temporaryPath);
    } catch (error) {
      if (descriptor !== null) this.fileSystem.close(descriptor);
      if (this.fileSystem.exists(temporaryPath))
        this.fileSystem.unlink(temporaryPath);
      if (error instanceof PortableProjectArchiveError) throw error;
      throw new PortableProjectArchiveError(
        this.fileSystem.exists(absolutePath)
          ? `Refusing to overwrite existing portable project archive: ${absolutePath}`
          : `Could not write portable project archive: ${absolutePath}`,
      );
    }
  }
}

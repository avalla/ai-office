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

export class LocalProjectArchiveAdapter implements ProjectArchiveAdapter {
  async read(path: string): Promise<string> {
    const absolutePath = resolve(path);
    if (extname(absolutePath) !== portableProjectExtension)
      throw new PortableProjectArchiveError(
        `Portable project archive must use ${portableProjectExtension}`,
      );
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const status = fstatSync(descriptor);
      if (!status.isFile())
        throw new PortableProjectArchiveError(
          "Portable project archive must be a regular, non-symlink file",
        );
      if (status.size > maximumPortableProjectBytes)
        throw new PortableProjectArchiveError(
          `Portable project archive exceeds ${maximumPortableProjectBytes} bytes`,
        );
      return readFileSync(descriptor, "utf8");
    } catch (error) {
      if (error instanceof PortableProjectArchiveError) throw error;
      throw new PortableProjectArchiveError(
        existsSync(absolutePath)
          ? "Portable project archive must be a readable, regular, non-symlink file"
          : `Portable project archive does not exist: ${absolutePath}`,
      );
    } finally {
      if (descriptor !== null) closeSync(descriptor);
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
    if (existsSync(absolutePath))
      throw new PortableProjectArchiveError(
        `Refusing to overwrite existing portable project archive: ${absolutePath}`,
      );
    let parent: string;
    try {
      parent = realpathSync(dirname(absolutePath));
    } catch {
      throw new PortableProjectArchiveError(
        `Portable project archive parent does not exist: ${dirname(absolutePath)}`,
      );
    }
    if (!lstatSync(parent).isDirectory())
      throw new PortableProjectArchiveError(
        `Portable project archive parent is not a directory: ${parent}`,
      );
    const temporaryPath = join(
      parent,
      `.ai-office-project-${randomUUID()}.tmp`,
    );
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      linkSync(temporaryPath, absolutePath);
      unlinkSync(temporaryPath);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      if (error instanceof PortableProjectArchiveError) throw error;
      throw new PortableProjectArchiveError(
        existsSync(absolutePath)
          ? `Refusing to overwrite existing portable project archive: ${absolutePath}`
          : `Could not write portable project archive: ${absolutePath}`,
      );
    }
  }
}

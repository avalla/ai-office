import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { AgentClientIntegrationError } from "@ai-office/application/agent-client/errors.ts";
import type { AgentClientFileOperation } from "@ai-office/application/ports/agent-client-adapter.port.ts";

const maximumInstructionBytes = 256 * 1024;

export interface LocalInstructionFile {
  relativePath: string;
  exists: boolean;
  content?: string;
  sha256?: string;
}

export interface LocalAgentClientFilesHooks {
  beforeCommit?(relativePath: string): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inside(rootPath: string, targetPath: string): boolean {
  const path = relative(rootPath, targetPath);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export class LocalAgentClientFiles {
  constructor(private readonly hooks: LocalAgentClientFilesHooks = {}) {}

  resolveRoot(input: string): string {
    let rootPath: string;
    try {
      rootPath = realpathSync(resolve(input));
    } catch {
      throw new AgentClientIntegrationError(
        `Agent client integration root does not exist: ${input}`,
      );
    }
    if (!statSync(rootPath).isDirectory())
      throw new AgentClientIntegrationError(
        `Agent client integration root is not a directory: ${input}`,
      );
    return rootPath;
  }

  read(rootPath: string, relativePath: string): LocalInstructionFile {
    const targetPath = resolve(rootPath, relativePath);
    if (!inside(rootPath, targetPath))
      throw new AgentClientIntegrationError(
        `Agent client instruction path escapes its root: ${relativePath}`,
      );
    if (!existsSync(targetPath)) return { relativePath, exists: false };
    const status = lstatSync(targetPath);
    if (!status.isFile() || status.isSymbolicLink())
      throw new AgentClientIntegrationError(
        `Agent client instruction path must be a regular file: ${relativePath}`,
      );
    if (status.size > maximumInstructionBytes)
      throw new AgentClientIntegrationError(
        `Agent client instruction file exceeds ${maximumInstructionBytes} bytes: ${relativePath}`,
      );
    const content = readFileSync(targetPath, "utf8");
    return { relativePath, exists: true, content, sha256: sha256(content) };
  }

  apply(
    rootPath: string,
    operations: readonly AgentClientFileOperation[],
  ): void {
    for (const operation of operations) {
      const targetPath = resolve(rootPath, operation.relativePath);
      if (!inside(rootPath, targetPath))
        throw new AgentClientIntegrationError(
          `Agent client instruction path escapes its root: ${operation.relativePath}`,
        );
      const current = this.read(rootPath, operation.relativePath);
      const currentHash = current.sha256 ?? null;
      if (currentHash !== operation.expectedSha256)
        throw new AgentClientIntegrationError(
          `Agent client instruction changed after planning: ${operation.relativePath}`,
        );

      if (operation.kind === "delete") {
        this.hooks.beforeCommit?.(operation.relativePath);
        const latest = this.read(rootPath, operation.relativePath);
        if ((latest.sha256 ?? null) !== operation.expectedSha256)
          throw new AgentClientIntegrationError(
            `Agent client instruction changed during apply: ${operation.relativePath}`,
          );
        try {
          unlinkSync(targetPath);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "EISDIR")
          )
            throw new AgentClientIntegrationError(
              `Agent client instruction changed during apply: ${operation.relativePath}`,
            );
          throw error;
        }
        continue;
      }

      const temporaryPath = join(
        dirname(targetPath),
        `.${basename(operation.relativePath)}.ai-office-${randomUUID()}.tmp`,
      );
      const mode = current.exists ? statSync(targetPath).mode & 0o777 : 0o644;
      try {
        writeFileSync(temporaryPath, operation.nextContent, {
          encoding: "utf8",
          flag: "wx",
          mode,
        });
        this.hooks.beforeCommit?.(operation.relativePath);
        const latest = this.read(rootPath, operation.relativePath);
        if ((latest.sha256 ?? null) !== operation.expectedSha256)
          throw new AgentClientIntegrationError(
            `Agent client instruction changed during apply: ${operation.relativePath}`,
          );
        if (operation.expectedSha256 === null) {
          linkSync(temporaryPath, targetPath);
          unlinkSync(temporaryPath);
        } else {
          renameSync(temporaryPath, targetPath);
        }
      } catch (error) {
        if (existsSync(temporaryPath)) rmSync(temporaryPath);
        if (
          error instanceof AgentClientIntegrationError ||
          (error instanceof Error && "code" in error && error.code === "EEXIST")
        )
          throw new AgentClientIntegrationError(
            error instanceof AgentClientIntegrationError
              ? error.message
              : `Agent client instruction changed during apply: ${operation.relativePath}`,
          );
        throw error;
      }
    }
  }
}

export class PathExecutableLocator {
  constructor(private readonly pathValue = process.env.PATH ?? "") {}

  find(command: string): string | null {
    for (const directory of this.pathValue.split(delimiter)) {
      if (directory === "") continue;
      const candidate = resolve(directory, command);
      try {
        const status = statSync(candidate);
        if (!status.isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        continue;
      }
    }
    return null;
  }
}

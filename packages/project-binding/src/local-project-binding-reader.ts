import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parseProjectBinding,
  projectBindingFile,
  ProjectBindingError,
  type ProjectBindingInspection,
} from "@ai-office/application/project-lifecycle/project-binding.ts";
import type { ProjectBindingReader } from "@ai-office/application/ports/project-binding-adapter.port.ts";

const maximumBindingBytes = 64 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDirectory(inputPath: string): string {
  let rootPath: string;
  try {
    rootPath = realpathSync(resolve(inputPath));
  } catch {
    throw new ProjectBindingError(
      `Project path does not exist: ${resolve(inputPath)}`,
    );
  }
  if (!statSync(rootPath).isDirectory())
    throw new ProjectBindingError(
      `Project path is not a directory: ${rootPath}`,
    );
  return rootPath;
}

function gitWorktreeRoot(inputPath: string): string | null {
  let current = inputPath;
  const startingDevice = statSync(inputPath).dev;
  while (true) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      const state = lstatSync(gitPath);
      if (state.isSymbolicLink())
        throw new ProjectBindingError(
          `.git must be a real directory or worktree file: ${gitPath}`,
        );
      if (state.isDirectory()) return current;
      if (state.isFile()) {
        if (state.size > maximumBindingBytes)
          throw new ProjectBindingError(
            `.git worktree file exceeds ${maximumBindingBytes} bytes: ${gitPath}`,
          );
        const pointer = readFileSync(gitPath, "utf8").trim();
        if (/^gitdir:\s*\S/iu.test(pointer)) return current;
        throw new ProjectBindingError(
          `.git worktree file is malformed: ${gitPath}`,
        );
      }
      throw new ProjectBindingError(
        `.git must be a directory or worktree file: ${gitPath}`,
      );
    }
    const parent = dirname(current);
    if (parent === current || statSync(parent).dev !== startingDevice)
      return null;
    current = parent;
  }
}

function invalidInspection(
  searchedFrom: string,
  rootPath: string,
  issue: string,
): ProjectBindingInspection {
  return {
    status: "invalid",
    searchedFrom,
    rootPath,
    bindingPath: join(rootPath, projectBindingFile),
    issue,
  };
}

function inspectAt(
  searchedFrom: string,
  rootPath: string,
): ProjectBindingInspection | null {
  const statePath = join(rootPath, ".ai-office");
  const bindingPath = join(rootPath, projectBindingFile);
  if (!existsSync(statePath)) return null;

  const state = lstatSync(statePath);
  if (state.isSymbolicLink() || !state.isDirectory())
    return invalidInspection(
      searchedFrom,
      rootPath,
      ".ai-office must be a real directory, not a symlink or another filesystem type",
    );
  if (!existsSync(bindingPath)) return null;

  const bindingStatus = lstatSync(bindingPath);
  if (bindingStatus.isSymbolicLink() || !bindingStatus.isFile())
    return invalidInspection(
      searchedFrom,
      rootPath,
      `${projectBindingFile} must be a regular file and cannot be a symlink`,
    );
  if (bindingStatus.size > maximumBindingBytes)
    return invalidInspection(
      searchedFrom,
      rootPath,
      `${projectBindingFile} exceeds ${maximumBindingBytes} bytes`,
    );

  const contents = readFileSync(bindingPath, "utf8");
  try {
    const binding = parseProjectBinding(JSON.parse(contents) as unknown);
    return {
      status: "valid",
      searchedFrom,
      rootPath,
      bindingPath,
      binding,
      sha256: sha256(contents),
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Project binding is invalid";
    return invalidInspection(searchedFrom, rootPath, detail);
  }
}

export class LocalProjectBindingReader implements ProjectBindingReader {
  async resolveProjectRoot(inputPath: string): Promise<string> {
    const searchedFrom = canonicalDirectory(inputPath);
    const worktreeRoot = gitWorktreeRoot(searchedFrom);
    const inspection = await this.inspect(searchedFrom, {
      ancestors: true,
      ...(worktreeRoot === null ? {} : { stopAt: worktreeRoot }),
    });
    if (inspection.status !== "missing") return inspection.rootPath;
    return worktreeRoot ?? searchedFrom;
  }

  async inspect(
    inputPath: string,
    options: { ancestors?: boolean; stopAt?: string } = {},
  ): Promise<ProjectBindingInspection> {
    const searchedFrom = canonicalDirectory(inputPath);
    const stopAt =
      options.stopAt === undefined
        ? undefined
        : canonicalDirectory(options.stopAt);
    if (
      stopAt !== undefined &&
      searchedFrom !== stopAt &&
      !searchedFrom.startsWith(`${stopAt}/`)
    )
      throw new ProjectBindingError(
        `Project binding traversal boundary is not an ancestor: ${stopAt}`,
      );
    let current = searchedFrom;
    const startingDevice = statSync(searchedFrom).dev;

    while (true) {
      const inspection = inspectAt(searchedFrom, current);
      if (inspection !== null) return inspection;
      if (options.ancestors !== true) break;
      if (current === stopAt) break;
      const parent = dirname(current);
      if (parent === current || statSync(parent).dev !== startingDevice) break;
      current = parent;
    }

    return {
      status: "missing",
      searchedFrom,
      rootPath: searchedFrom,
      bindingPath: join(searchedFrom, projectBindingFile),
    };
  }
}

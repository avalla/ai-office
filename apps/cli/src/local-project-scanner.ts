import { basename, dirname, join, resolve, sep } from "node:path";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ProjectScanner } from "@ai-office/application/ports/project-scanner.port.ts";
import type { ProjectScanSummary } from "@ai-office/domain/project/project-profile.ts";

const ignoredDirectories = new Set([
  ".git", ".ai-office", "node_modules", "dist", "build", "coverage", ".next", "target", "vendor"
]);

/**
 * Where Git keeps the metadata of a checkout. A plain clone stores everything in
 * one directory; a linked worktree splits per-checkout state (`HEAD`) from the
 * repository-wide state (config, branch refs) it shares with the main checkout.
 */
interface GitLayout {
  worktreeGitDir: string;
  commonGitDir: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Resolves the Git directory pair for a checkout. A linked worktree or a
 * submodule stores a `gitdir:` pointer file instead of a directory; only a
 * linked worktree also stores a `commondir` pointer back to the shared Git
 * directory, so the common directory falls back to the resolved gitdir.
 */
function resolveGitLayout(rootPath: string): GitLayout | undefined {
  const candidate = join(rootPath, ".git");
  if (!existsSync(candidate)) return undefined;

  const worktreeGitDir = statSync(candidate).isDirectory()
    ? candidate
    : resolveGitDirectoryPointer(rootPath, candidate);
  if (worktreeGitDir === undefined) return undefined;

  const commonPointer = readText(join(worktreeGitDir, "commondir"))?.trim();
  if (commonPointer === undefined || commonPointer.length === 0) {
    return { worktreeGitDir, commonGitDir: worktreeGitDir };
  }

  const commonGitDir = resolve(worktreeGitDir, commonPointer);
  return {
    worktreeGitDir,
    commonGitDir: existsSync(commonGitDir) ? commonGitDir : worktreeGitDir
  };
}

function resolveGitDirectoryPointer(rootPath: string, pointerFile: string): string | undefined {
  const pointer = readText(pointerFile)?.match(/^gitdir:\s*(.+)$/mu)?.[1]?.trim();
  if (pointer === undefined) return undefined;
  const resolved = resolve(rootPath, pointer);
  return existsSync(resolved) ? resolved : undefined;
}

/**
 * Reads the first URL of each configured remote, preferring `origin`. A bare
 * search for `url =` would otherwise return whichever remote — or unrelated
 * section — happens to appear first.
 */
function detectRemoteUrl(config: string | undefined): string | undefined {
  if (config === undefined) return undefined;
  const remotes = new Map<string, string>();
  let remote: string | undefined;

  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    const section = line.match(/^\[remote\s+"([^"]+)"\]$/u);
    if (section !== null) {
      remote = section[1];
      continue;
    }
    if (line.startsWith("[")) {
      remote = undefined;
      continue;
    }
    const url = remote === undefined ? undefined : line.match(/^url\s*=\s*(.+)$/u)?.[1]?.trim();
    if (url !== undefined && !remotes.has(remote!)) remotes.set(remote!, url);
  }

  return remotes.get("origin") ?? [...remotes.values()][0];
}

function detectGit(layout: GitLayout | undefined): { remoteUrl?: string; currentBranch?: string } {
  if (layout === undefined) return {};
  const head = readText(join(layout.worktreeGitDir, "HEAD"))?.trim();
  const remoteUrl = detectRemoteUrl(readText(join(layout.commonGitDir, "config")));
  const currentBranch = head?.startsWith("ref: refs/heads/")
    ? head.slice("ref: refs/heads/".length)
    : undefined;

  return {
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(currentBranch === undefined ? {} : { currentBranch })
  };
}

function hasBranchReference(gitDirectory: string): boolean {
  const packed = readText(join(gitDirectory, "packed-refs")) ?? "";
  if (/^[0-9a-f]{40,64}\s+refs\/heads\//mu.test(packed)) return true;

  const heads = join(gitDirectory, "refs", "heads");
  if (!existsSync(heads)) return false;
  const pending = [heads];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry);
      if (statSync(absolutePath).isDirectory()) pending.push(absolutePath);
      else return true;
    }
  }
  return false;
}

/**
 * Cheap, offline evidence that the repository has at least one commit. A branch
 * pointer in HEAD is not history: `git init` writes it before any commit
 * exists, so branch heads and packed refs are the signal. Those live in the
 * common Git directory, which a linked worktree shares with the main checkout.
 */
function detectCommitHistory(layout: GitLayout | undefined): boolean {
  if (layout === undefined) return false;
  if (hasBranchReference(layout.commonGitDir)) return true;
  return layout.worktreeGitDir !== layout.commonGitDir
    && hasBranchReference(layout.worktreeGitDir);
}

function canonicalDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canonical roots of the linked worktrees Git has registered for this
 * repository, read from `<commonGitDir>/worktrees/<name>/gitdir`, which points
 * at the `.git` pointer file of each checkout. Entries left behind by a deleted
 * worktree are dropped.
 */
function registeredWorktreeRoots(layout: GitLayout | undefined): string[] {
  if (layout === undefined) return [];
  const registry = join(layout.commonGitDir, "worktrees");
  if (!existsSync(registry)) return [];

  const roots: string[] = [];
  for (const entry of readdirSync(registry)) {
    const pointer = readText(join(registry, entry, "gitdir"))?.trim();
    if (pointer === undefined || pointer.length === 0) continue;
    const root = canonicalDirectory(dirname(resolve(registry, entry, pointer)));
    if (root !== undefined) roots.push(root);
  }
  return roots;
}

/**
 * A linked worktree placed inside the project is an alternative checkout of the
 * same repository, not part of the project. Counting its files would make the
 * repository evidence describe how the checkout is materialized. The worktree
 * being scanned is itself registered, so only strict descendants are excluded.
 */
function nestedWorktrees(rootPath: string, layout: GitLayout | undefined): Set<string> {
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return new Set(
    registeredWorktreeRoots(layout).filter((root) => root.startsWith(prefix))
  );
}

function collectFiles(
  rootPath: string,
  excludedDirectories: ReadonlySet<string>,
  limit = 20_000
): string[] {
  const files: string[] = [];
  const pending = [rootPath];

  while (pending.length > 0 && files.length < limit) {
    const directory = pending.pop();
    if (directory === undefined) break;

    for (const entry of readdirSync(directory).sort()) {
      if (ignoredDirectories.has(entry)) continue;
      const absolutePath = join(directory, entry);
      const relativePath = absolutePath.slice(rootPath.length + 1);
      const stats = statSync(absolutePath);

      if (stats.isDirectory()) {
        if (isExcluded(absolutePath, excludedDirectories)) continue;
        pending.push(absolutePath);
      }
      else if (stats.isFile()) files.push(relativePath);
    }
  }

  return files;
}

function isExcluded(path: string, excludedDirectories: ReadonlySet<string>): boolean {
  if (excludedDirectories.size === 0) return false;
  if (excludedDirectories.has(path)) return true;
  const canonical = canonicalDirectory(path);
  return canonical !== undefined && excludedDirectories.has(canonical);
}

function detectLanguages(files: string[]): string[] {
  const extensions = new Map<string, string>([
    [".ts", "TypeScript"], [".tsx", "TypeScript"], [".js", "JavaScript"],
    [".jsx", "JavaScript"], [".rs", "Rust"], [".py", "Python"], [".go", "Go"],
    [".java", "Java"], [".php", "PHP"], [".rb", "Ruby"], [".sql", "SQL"]
  ]);

  return [...new Set(
    files.flatMap((file) => {
      const extension = [...extensions.keys()].find((candidate) => file.endsWith(candidate));
      return extension === undefined ? [] : [extensions.get(extension)!];
    })
  )].sort();
}

export class LocalProjectScanner implements ProjectScanner {
  async scan(inputPath: string): Promise<ProjectScanSummary> {
    const resolvedPath = resolve(inputPath);
    const rootPath = existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new Error(`Project path does not exist or is not a directory: ${rootPath}`);
    }

    const gitLayout = resolveGitLayout(rootPath);
    const files = collectFiles(rootPath, nestedWorktrees(rootPath, gitLayout)).sort();
    const fileSet = new Set(files);
    const packageJson = readText(join(rootPath, "package.json"));
    const manifest = packageJson === undefined
      ? {}
      : JSON.parse(packageJson) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const hasDependency = (name: string): boolean => dependencies[name] !== undefined;

    const frameworks = [
      hasDependency("react") ? "React" : undefined,
      hasDependency("next") ? "Next.js" : undefined,
      hasDependency("vite") ? "Vite" : undefined,
      hasDependency("@nestjs/core") ? "NestJS" : undefined,
      hasDependency("express") ? "Express" : undefined
    ].filter((value): value is string => value !== undefined);

    const databases = [
      files.some((file) => file.endsWith(".sqlite") || file.endsWith(".db")) ? "SQLite" : undefined,
      hasDependency("pg") || fileSet.has("supabase/config.toml") ? "PostgreSQL" : undefined,
      hasDependency("mongoose") ? "MongoDB" : undefined
    ].filter((value): value is string => value !== undefined);

    const testing = [
      hasDependency("vitest") ? "Vitest" : undefined,
      hasDependency("jest") ? "Jest" : undefined,
      hasDependency("@playwright/test") ? "Playwright" : undefined,
      hasDependency("cypress") ? "Cypress" : undefined
    ].filter((value): value is string => value !== undefined);

    const documentation = [
      "README.md", "AGENTS.md", "CLAUDE.md", "CODEX.md", "CONTRIBUTING.md"
    ].filter((file) => fileSet.has(file));

    const packageManager = fileSet.has("bun.lock") || fileSet.has("bun.lockb")
      ? "bun"
      : fileSet.has("pnpm-lock.yaml")
        ? "pnpm"
        : fileSet.has("yarn.lock")
          ? "yarn"
          : fileSet.has("package-lock.json")
            ? "npm"
            : undefined;

    return {
      rootPath,
      projectName: basename(rootPath),
      ...detectGit(gitLayout),
      hasCommitHistory: detectCommitHistory(gitLayout),
      ...(packageManager === undefined ? {} : { packageManager }),
      languages: detectLanguages(files),
      frameworks,
      databases,
      testing,
      documentation,
      detectedFiles: files
    };
  }
}

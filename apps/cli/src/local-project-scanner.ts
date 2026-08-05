import { basename, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ProjectScanner } from "@ai-office/application/ports/project-scanner.port.ts";
import type { ProjectScanSummary } from "@ai-office/domain/project/project-profile.ts";

const ignoredDirectories = new Set([
  ".git", ".ai-office", "node_modules", "dist", "build", "coverage", ".next", "target", "vendor"
]);

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function detectGit(rootPath: string): { remoteUrl?: string; currentBranch?: string } {
  const gitConfig = readText(join(rootPath, ".git", "config"));
  const head = readText(join(rootPath, ".git", "HEAD"))?.trim();
  const remoteUrl = gitConfig?.match(/url\s*=\s*(.+)/)?.[1]?.trim();
  const currentBranch = head?.startsWith("ref: refs/heads/")
    ? head.slice("ref: refs/heads/".length)
    : undefined;

  return {
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(currentBranch === undefined ? {} : { currentBranch })
  };
}

function collectFiles(rootPath: string, limit = 20_000): string[] {
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

      if (stats.isDirectory()) pending.push(absolutePath);
      else if (stats.isFile()) files.push(relativePath);
    }
  }

  return files;
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

    const files = collectFiles(rootPath).sort();
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
      ...detectGit(rootPath),
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

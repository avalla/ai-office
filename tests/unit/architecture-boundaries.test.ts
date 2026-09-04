import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function typescriptFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...typescriptFiles(path));
      continue;
    }
    if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Every module specifier in a static import, re-export, or dynamic import. */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1]!);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

/** Resolves a relative specifier so a `../../cli/src/...` hop is visible. */
function resolvedTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return relative(repositoryRoot, resolve(dirname(file), specifier));
}

describe("application architecture boundaries", () => {
  test("the persistent Runtime host does not depend on the CLI client", () => {
    const offenders: string[] = [];
    for (const file of typescriptFiles(
      join(repositoryRoot, "apps", "daemon"),
    )) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        const target = resolvedTarget(file, specifier);
        const reachesCli =
          specifier.startsWith("@ai-office/cli") ||
          specifier.includes("apps/cli/") ||
          (target !== null && target.startsWith("apps/cli"));
        if (reachesCli)
          offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the Runtime host package does not depend on any application entry point", () => {
    const offenders: string[] = [];
    for (const file of typescriptFiles(
      join(repositoryRoot, "packages", "runtime-host"),
    )) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        const target = resolvedTarget(file, specifier);
        const reachesApp =
          specifier.startsWith("@ai-office/cli") ||
          specifier.includes("apps/") ||
          (target !== null && target.startsWith("apps"));
        if (reachesApp)
          offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the CLI client owns no Runtime command composition", () => {
    const clientFiles = typescriptFiles(join(repositoryRoot, "apps", "cli"));
    const offenders: string[] = [];
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        // Direct SQLite access from a client would reintroduce the embedded
        // write path ADR-0014 rejects.
        if (specifier.startsWith("@ai-office/storage-sqlite"))
          offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

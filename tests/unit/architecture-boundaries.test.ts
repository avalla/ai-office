import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

  test("CLI and neutral support have no transitive dependency on Runtime composition", () => {
    const visited = new Set<string>();
    const offenders: string[] = [];
    const visit = (file: string, chain: string[]) => {
      if (visited.has(file)) return;
      visited.add(file);
      const location = relative(repositoryRoot, file);
      if (
        /^(packages\/(runtime-host|storage-sqlite)\/|apps\/daemon\/)/u.test(
          location,
        )
      ) {
        offenders.push([...chain, location].join(" -> "));
        return;
      }
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const follow = (specifier: string) => {
        if (
          /^@ai-office\/(runtime-host|storage-sqlite|daemon)(\/|$)/u.test(
            specifier,
          )
        ) {
          offenders.push([...chain, location, specifier].join(" -> "));
          return;
        }
        const packageMatch = /^@ai-office\/([^/]+)\/(.+)$/u.exec(specifier);
        const target = specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : packageMatch === null
            ? null
            : join(
                repositoryRoot,
                "packages",
                packageMatch[1]!,
                "src",
                packageMatch[2]!,
              );
        if (target === null) return;
        const candidates = [
          target,
          target.replace(/\.js$/u, ".ts"),
          target + ".ts",
          join(target, "index.ts"),
        ];
        const resolved = candidates.find(
          (candidate) => candidate.endsWith(".ts") && existsSync(candidate),
        );
        if (resolved !== undefined) visit(resolved, [...chain, location]);
      };
      const walk = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          follow(node.moduleSpecifier.text);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "require"))
        ) {
          const argument = node.arguments[0];
          if (argument !== undefined && ts.isStringLiteral(argument)) {
            // The linkable launcher has one explicit host-start branch. Its
            // bootstrap is lazy; ordinary client invocation must load no server.
            const explicitHostStart =
              location === "bin/ai-office.ts" &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              argument.text === "../apps/daemon/src/bootstrap.ts";
            if (!explicitHostStart) follow(argument.text);
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(source);
    };
    for (const directory of [
      "apps/cli",
      "packages/command-support",
      "packages/project-binding",
    ])
      for (const file of typescriptFiles(join(repositoryRoot, directory)))
        visit(file, []);
    visit(join(repositoryRoot, "bin/ai-office.ts"), []);
    expect(offenders).toEqual([]);
  });
});

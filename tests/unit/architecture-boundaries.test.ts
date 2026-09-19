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

function importsStorageSqlite(file: string, specifier: string): boolean {
  if (specifier === "@ai-office/storage-sqlite") return true;
  if (specifier.startsWith("@ai-office/storage-sqlite/")) return true;
  const target = resolvedTarget(file, specifier);
  return (
    target === "packages/storage-sqlite" ||
    target?.startsWith("packages/storage-sqlite/") === true
  );
}

function storageSqliteImports(file: string): string[] {
  return importedSpecifiers(readFileSync(file, "utf8")).filter((specifier) =>
    importsStorageSqlite(file, specifier),
  );
}

describe("application architecture boundaries", () => {
  test("project Runtime composition consumes repository ports, not SQLite classes", () => {
    const contextPath = join(
      repositoryRoot,
      "packages",
      "runtime-host",
      "src",
      "commands",
      "shared.ts",
    );
    const runtimeCommandPath = join(
      repositoryRoot,
      "packages",
      "runtime-host",
      "src",
      "runtime-command.ts",
    );
    const projectStoragePath = join(
      repositoryRoot,
      "packages",
      "application",
      "src",
      "ports",
      "project-storage.port.ts",
    );
    const context = readFileSync(contextPath, "utf8");
    const runtimeCommand = readFileSync(runtimeCommandPath, "utf8");
    const projectStorage = readFileSync(projectStoragePath, "utf8");

    expect(context).toContain("extends ProjectStorage");
    expect(storageSqliteImports(contextPath)).toEqual([]);
    expect(storageSqliteImports(projectStoragePath)).toEqual([]);
    expect(importedSpecifiers(projectStorage)).not.toContain("bun:sqlite");
    expect(runtimeCommand).toContain("createSqliteProjectStorage");
    expect(
      storageSqliteImports(runtimeCommandPath).filter(
        (specifier) =>
          specifier.includes("/repositories/") &&
          !specifier.endsWith("/sqlite-global-memory.repository.ts"),
      ),
    ).toEqual([]);
  });

  test("Runtime command handlers cannot import SQLite adapters", () => {
    const offenders: string[] = [];
    for (const file of typescriptFiles(
      join(repositoryRoot, "packages", "runtime-host", "src", "commands"),
    )) {
      for (const specifier of storageSqliteImports(file))
        offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
    }
    expect(offenders).toEqual([]);
  });

  test("SQLite adapter imports stay in infrastructure composition roots", () => {
    const allowed = new Set([
      "packages/runtime-host/src/runtime-command.ts",
      "apps/daemon/src/bootstrap.ts",
    ]);
    const offenders: string[] = [];
    for (const directory of ["packages", "apps"])
      for (const file of typescriptFiles(join(repositoryRoot, directory))) {
        const location = relative(repositoryRoot, file);
        if (location.startsWith("packages/storage-sqlite/")) continue;
        if (!allowed.has(location) && storageSqliteImports(file).length > 0)
          offenders.push(location);
      }
    expect(offenders).toEqual([]);
  });

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

function assertNoPlatformMechanics(relativePath: string): void {
  const path = join(repositoryRoot, relativePath);
  const source = readFileSync(path, "utf8");
  const forbidden = importedSpecifiers(source).filter((specifier) =>
    /(?:apps\/|runtime-host|storage-sqlite|node:(?:fs|child_process|http|net|os|path)|bun:)/.test(
      specifier,
    ),
  );
  expect(forbidden).toEqual([]);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const mechanics: string[] = [];
  function walk(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      ["Bun", "process", "fetch", "SQLite", "Database"].includes(node.text)
    )
      mechanics.push(node.text);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  expect(mechanics).toEqual([]);
}

test("service lifecycle orchestration stays behind ports without platform mechanics", () => {
  // systemd, launchd, unit text, plists and process execution belong to the
  // adapters. The application layer only decides what a report means.
  assertNoPlatformMechanics(
    "packages/application/src/service-management/manage-office-services.ts",
  );
  assertNoPlatformMechanics(
    "packages/application/src/service-management/managed-definition.ts",
  );
  assertNoPlatformMechanics(
    "packages/application/src/ports/office-service-manager.port.ts",
  );
  // Naming the two platforms in prose is what the port is for; emitting their
  // command names or file syntax is not.
  for (const relativePath of [
    "packages/application/src/service-management/manage-office-services.ts",
    "packages/application/src/service-management/managed-definition.ts",
    "packages/application/src/ports/office-service-manager.port.ts",
  ]) {
    const source = readFileSync(join(repositoryRoot, relativePath), "utf8");
    expect(source).not.toMatch(
      /["'`](?:systemctl|launchctl)["'`]|ExecStart|<plist/u,
    );
  }
});

test("the CLI presentation layer carries no platform branch", () => {
  const source = readFileSync(
    join(repositoryRoot, "apps/cli/src/service-cli.ts"),
    "utf8",
  );
  // Help text may name the platforms; rendering or invoking them must not
  // happen here, and the presentation layer never branches on the platform.
  expect(source).not.toMatch(
    /["'`](?:systemctl|launchctl)["'`]|ExecStart|<plist/u,
  );
  expect(source).not.toMatch(/process\.platform/u);
});

test("distribution update orchestration stays behind ports without platform mechanics", () => {
  const path = join(
    repositoryRoot,
    "packages/application/src/runtime/manage-distribution-update.ts",
  );
  const source = readFileSync(path, "utf8");
  const forbidden = importedSpecifiers(source).filter((specifier) =>
    /(?:apps\/|runtime-host|storage-sqlite|node:(?:fs|child_process|http|net)|bun:)/.test(
      specifier,
    ),
  );
  expect(forbidden).toEqual([]);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const mechanics: string[] = [];
  function walk(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      ["Bun", "process", "fetch", "SQLite", "Database"].includes(node.text)
    )
      mechanics.push(node.text);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  expect(mechanics).toEqual([]);
});

test("project memory stays behind its application port and the CairnKeep adapter", () => {
  // Application and domain know a provider-neutral port only: no MCP, no
  // CairnKeep, no AgentFS, no subprocesses, no configuration lookups.
  for (const directory of ["packages/domain/src", "packages/application/src"])
    for (const file of typescriptFiles(join(repositoryRoot, directory))) {
      const source = readFileSync(file, "utf8");
      const forbidden = importedSpecifiers(source).filter((specifier) =>
        /cairnkeep|modelcontextprotocol|agentfs|node:child_process|bun:/iu.test(
          specifier,
        ),
      );
      expect(forbidden, relative(repositoryRoot, file)).toEqual([]);
    }
  for (const relativePath of [
    "packages/application/src/context/run-context-assembler.ts",
    "packages/application/src/ports/project-memory-provider.port.ts",
    "packages/application/src/project-memory/project-memory-identity.ts",
    "packages/application/src/project-memory/describe-project-memory.ts",
  ])
    assertNoPlatformMechanics(relativePath);

  // Worker adapters, executors and the pipeline never reach the adapter.
  const adapterReachers: string[] = [];
  for (const directory of [
    "packages/agent-runtime",
    "packages/application",
    "packages/domain",
    "packages/storage-sqlite",
    "packages/orchestration",
    "apps/cli",
    "apps/dashboard",
  ])
    for (const file of typescriptFiles(join(repositoryRoot, directory)))
      if (
        importedSpecifiers(readFileSync(file, "utf8")).some((specifier) =>
          specifier.includes("cairnkeep-memory"),
        )
      )
        adapterReachers.push(relative(repositoryRoot, file));
  expect(adapterReachers).toEqual([]);

  // The adapter names exactly one CairnKeep tool; no mutation tool is ever
  // referenced by production code.
  const adapterSources = typescriptFiles(
    join(repositoryRoot, "packages/cairnkeep-memory"),
  ).map((file) => readFileSync(file, "utf8"));
  const toolNames = new Set(
    adapterSources.flatMap(
      (source) =>
        source.match(
          /\b(?:memory|artifact|context|domain_knowledge|route|work_evidence)_[a-z_]+\b/gu,
        ) ?? [],
    ),
  );
  expect([...toolNames]).toEqual(["memory_search"]);
});

test("raw provider credential values are reachable only at the gateway provider construction boundary", () => {
  const productionFiles = ["packages", "apps"].flatMap((directory) =>
    typescriptFiles(join(repositoryRoot, directory))
      .map((file) => relative(repositoryRoot, file))
      .filter((file) => !file.split("/").includes("node_modules")),
  );
  const referencing = (identifier: string): string[] =>
    productionFiles
      .filter((file) =>
        new RegExp(`\\b${identifier}\\b`, "u").test(
          readFileSync(join(repositoryRoot, file), "utf8"),
        ),
      )
      .sort();

  // The only accessor that returns values, scoped to one resolved provider.
  expect(referencing("resolvedProviderCredentialEnvironment")).toEqual([
    "packages/llm-gateway/src/gateway-worker-runtime.ts",
    "packages/llm-gateway/src/provider-credentials.ts",
  ]);
  // The only function that turns a Runtime home credential into a string.
  expect(referencing("loadRuntimeHomeCredentialValue")).toEqual([
    "packages/llm-gateway/src/provider-credentials.ts",
    "packages/llm-gateway/src/runtime-home-credential-store.ts",
  ]);
  // No generic secret-by-name accessor exists any more.
  expect(
    productionFiles.filter((file) =>
      /\.secret\(|\bsecret\(name/u.test(
        readFileSync(join(repositoryRoot, file), "utf8"),
      ),
    ),
  ).toEqual([]);
  // `credential status` inspects metadata only.
  const credentialCli = readFileSync(
    join(repositoryRoot, "apps/cli/src/credential-cli.ts"),
    "utf8",
  );
  expect(credentialCli).toMatch(/\binspectRuntimeHomeCredential\b/u);
  expect(credentialCli).not.toMatch(
    /\b(?:loadRuntimeHomeCredentialValue|loadProviderCredentials)\b/u,
  );

  // Application, domain and Runtime command code never import the value side.
  const valueModules: string[] = [];
  for (const directory of [
    "packages/application",
    "packages/domain",
    "packages/runtime-host",
  ])
    for (const file of typescriptFiles(join(repositoryRoot, directory)))
      if (
        importedSpecifiers(readFileSync(file, "utf8")).some((specifier) =>
          /(?:provider-credentials|runtime-home-credential-store)(?:\.ts)?$/u.test(
            specifier,
          ),
        )
      )
        valueModules.push(relative(repositoryRoot, file));
  expect(valueModules).toEqual([]);
});

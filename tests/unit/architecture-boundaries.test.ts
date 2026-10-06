import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as installedPackResolver from "../../packages/application/src/domain-pack/resolve-installed-packs.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function typescriptFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...typescriptFiles(path));
      continue;
    }
    if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("GP-06 configuration remains derived and outside scheduling and portable authority", () => {
  const resolver = readFileSync(
    join(
      repositoryRoot,
      "packages/application/src/domain-pack/resolve-project-configuration.ts",
    ),
    "utf8",
  );
  const reader = readFileSync(
    join(
      repositoryRoot,
      "packages/application/src/domain-pack/read-project-configuration.ts",
    ),
    "utf8",
  );
  const storagePort = readFileSync(
    join(
      repositoryRoot,
      "packages/application/src/ports/project-storage.port.ts",
    ),
    "utf8",
  );
  const archive = readFileSync(
    join(
      repositoryRoot,
      "packages/application/src/project-portability/project-snapshot.ts",
    ),
    "utf8",
  );
  const manifests = readFileSync(
    join(
      repositoryRoot,
      "packages/application/src/domain-pack/resolve-installed-pack-manifests.ts",
    ),
    "utf8",
  );
  expect(resolver).toContain("resolveInstalledPackManifests");
  expect(manifests).toContain("resolveInstalledPacks(");
  expect(reader).toContain("resolveProjectConfiguration");
  expect(storagePort).not.toContain("ResolvedProjectConfiguration");
  expect(archive).not.toContain("ResolvedProjectConfiguration");
  expect(resolver).not.toMatch(
    /org\.ai-office\.development|org\.example\.(?:legal|manufacturing)/u,
  );
  for (const file of typescriptFiles(
    join(repositoryRoot, "packages/application/src/runtime"),
  ))
    expect(readFileSync(file, "utf8")).not.toContain(
      "ReadProjectConfiguration",
    );
  for (const file of typescriptFiles(
    join(repositoryRoot, "packages/storage-sqlite/src"),
  ))
    expect(readFileSync(file, "utf8")).not.toContain(
      "resolved_project_configuration",
    );
});

test("GP-09 legacy profile stays a derived read model outside scheduling, storage and portable state", () => {
  const profileModules = [
    "packages/application/src/domain-pack/legacy-development-profile.ts",
    "packages/application/src/domain-pack/read-legacy-development-profile.ts",
  ];
  // The reader service and the one read-only command are the only importers.
  const allowedImporters = new Set([
    ...profileModules,
    "packages/runtime-host/src/commands/project-configuration.ts",
  ]);
  const importers: string[] = [];
  for (const root of ["packages", "apps"])
    for (const file of typescriptFiles(join(repositoryRoot, root))) {
      const location = relative(repositoryRoot, file);
      if (/legacy-development-profile/u.test(readFileSync(file, "utf8")))
        importers.push(location);
    }
  expect(importers.sort()).toEqual([...allowedImporters].sort());

  // No port, storage adapter or archive schema names the profile or its type.
  const authority = [
    ...typescriptFiles(join(repositoryRoot, "packages/application/src/ports")),
    ...typescriptFiles(join(repositoryRoot, "packages/storage-sqlite/src")),
    ...typescriptFiles(join(repositoryRoot, "packages/storage-postgres/src")),
    ...typescriptFiles(join(repositoryRoot, "packages/storage-bootstrap/src")),
    ...typescriptFiles(
      join(repositoryRoot, "packages/application/src/project-portability"),
    ),
    ...typescriptFiles(
      join(repositoryRoot, "packages/application/src/pipeline"),
    ),
    ...typescriptFiles(
      join(repositoryRoot, "packages/application/src/runtime"),
    ),
    ...typescriptFiles(
      join(repositoryRoot, "packages/application/src/commands"),
    ),
    ...typescriptFiles(join(repositoryRoot, "packages/domain/src")),
    join(
      repositoryRoot,
      "packages/application/src/domain-pack/resolve-project-configuration.ts",
    ),
    join(
      repositoryRoot,
      "packages/application/src/domain-pack/read-project-configuration.ts",
    ),
  ];
  expect(authority.length).toBeGreaterThan(100);
  expect(
    authority
      .filter((file) =>
        /LegacyDevelopmentProfile|legacyDevelopmentProfile|legacy_development_profile/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(repositoryRoot, file)),
  ).toEqual([]);

  // The derivation is pure: domain types and the JCS serializer, nothing else.
  const derivation = join(repositoryRoot, profileModules[0]!);
  expect(importedSpecifiers(readFileSync(derivation, "utf8")).sort()).toEqual([
    "../../../domain-pack-contracts/src/jcs.ts",
    "@ai-office/domain/agent/agent.ts",
    "@ai-office/domain/agent/role.ts",
    "@ai-office/domain/office/office-manifest.ts",
    "node:crypto",
  ]);
  for (const location of profileModules)
    expect(readFileSync(join(repositoryRoot, location), "utf8")).not.toMatch(
      /org\.ai-office\.development|org\.example\.(?:legal|manufacturing)|Date\.now|new Date\(/u,
    );
  // No migration creates a place to store it.
  for (const directory of ["migrations/project", "supabase/migrations"])
    for (const entry of readdirSync(join(repositoryRoot, directory)))
      expect(
        readFileSync(join(repositoryRoot, directory, entry), "utf8"),
      ).not.toMatch(/legacy_development|legacy_profile/u);
});

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

const allowedGlobalSqliteImports = new Set([
  "@ai-office/storage-sqlite/database/migrate-global.ts",
  "@ai-office/storage-sqlite/database/open-database.ts",
  "@ai-office/storage-sqlite/repositories/sqlite-global-memory.repository.ts",
]);

function isAllowedGlobalSqliteImport(file: string, specifier: string): boolean {
  const location = relative(repositoryRoot, file);
  return (
    (location === "apps/daemon/src/bootstrap.ts" ||
      location === "packages/runtime-host/src/runtime-command.ts") &&
    allowedGlobalSqliteImports.has(specifier)
  );
}

function importsStoragePostgres(file: string, specifier: string): boolean {
  if (specifier === "@ai-office/storage-postgres") return true;
  if (specifier.startsWith("@ai-office/storage-postgres/")) return true;
  const target = resolvedTarget(file, specifier);
  return (
    target === "packages/storage-postgres" ||
    target?.startsWith("packages/storage-postgres/") === true
  );
}

describe("application architecture boundaries", () => {
  test("Domain Pack contracts remain independent and cannot form a package cycle", () => {
    const contracts = join(repositoryRoot, "packages", "domain-pack-contracts");
    const offenders: string[] = [];
    for (const file of typescriptFiles(contracts)) {
      for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
        const target = resolvedTarget(file, specifier);
        if (
          specifier.startsWith("@ai-office/") ||
          (target?.startsWith("packages/") === true &&
            !target.startsWith("packages/domain-pack-contracts/"))
        )
          offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("domain and application do not import official Domain Packs", () => {
    const offenders: string[] = [];
    for (const layer of ["domain", "application"]) {
      for (const file of typescriptFiles(
        join(repositoryRoot, "packages", layer),
      )) {
        for (const specifier of importedSpecifiers(
          readFileSync(file, "utf8"),
        )) {
          const target = resolvedTarget(file, specifier);
          if (
            (specifier.startsWith("@ai-office/domain-pack-") &&
              !specifier.startsWith("@ai-office/domain-pack-contracts")) ||
            (target?.startsWith("packages/domain-pack-") === true &&
              !target.startsWith("packages/domain-pack-contracts/"))
          )
            offenders.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("GP-04 availability and resolution cannot reach project storage or Runtime scheduling", () => {
    const gp04Files = [
      "packages/application/src/ports/installed-domain-pack-catalog.port.ts",
      "packages/application/src/domain-pack/resolve-installed-packs.ts",
      "packages/application/src/domain-pack/internal/verified-pack-closure.ts",
      "packages/runtime-host/src/installed-domain-pack-catalog.ts",
    ];
    for (const location of gp04Files) {
      const file = join(repositoryRoot, location);
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(
        /ProjectStorage|projectId|pipeline:|run:schedule/,
      );
      expect(
        importedSpecifiers(source).filter((specifier) =>
          /storage|repository|domain-pack-development|commands\//.test(
            specifier,
          ),
        ),
      ).toEqual([]);
      if (location.startsWith("packages/application/"))
        expect(
          importedSpecifiers(source).filter(
            (specifier) =>
              specifier.startsWith("@ai-office/runtime-host") ||
              resolvedTarget(file, specifier)?.startsWith(
                "packages/runtime-host/",
              ) === true,
          ),
        ).toEqual([]);
    }
    const runtimeCommand = readFileSync(
      join(repositoryRoot, "packages/runtime-host/src/runtime-command.ts"),
      "utf8",
    );
    expect(runtimeCommand).toContain(
      "new InMemoryInstalledDomainPackCatalog(1, [])",
    );
    expect(Object.keys(installedPackResolver)).toEqual([
      "resolveInstalledPacks",
    ]);
  });

  test("GP-05 project selection stays separate from host artifacts and scheduling", () => {
    const bindingPort = readFileSync(
      join(
        repositoryRoot,
        "packages/application/src/ports/project-pack-binding-repository.port.ts",
      ),
      "utf8",
    );
    const bindingService = readFileSync(
      join(
        repositoryRoot,
        "packages/application/src/domain-pack/manage-project-pack-binding.ts",
      ),
      "utf8",
    );
    const sqliteBinding = readFileSync(
      join(
        repositoryRoot,
        "packages/storage-sqlite/src/repositories/sqlite-project-pack-binding.repository.ts",
      ),
      "utf8",
    );
    const postgresBinding = readFileSync(
      join(
        repositoryRoot,
        "packages/storage-postgres/src/repositories/postgres-project-pack-binding.repository.ts",
      ),
      "utf8",
    );
    const projectStorage = readFileSync(
      join(
        repositoryRoot,
        "packages/application/src/ports/project-storage.port.ts",
      ),
      "utf8",
    );
    const bindingCommands = readFileSync(
      join(
        repositoryRoot,
        "packages/runtime-host/src/commands/project-pack.ts",
      ),
      "utf8",
    );
    const projectCommands = readFileSync(
      join(repositoryRoot, "packages/runtime-host/src/commands/project.ts"),
      "utf8",
    );
    for (const source of [bindingPort, sqliteBinding, postgresBinding])
      expect(source).not.toMatch(/artifactDigest|installerId|provenance|bytes/);
    expect(projectStorage).not.toContain("InstalledDomainPackCatalog");
    for (const migration of [
      "migrations/project/0041_project_pack_binding.sql",
      "supabase/migrations/20261002000100_project_pack_binding.sql",
    ]) {
      const schema = readFileSync(
        join(repositoryRoot, migration),
        "utf8",
      ).replace(/^--.*$/gm, "");
      expect(schema).not.toMatch(
        /artifact_digest|artifact_bytes|installer_id|installation_reference|provenance|catalog_/i,
      );
    }
    expect(bindingService).toContain('from "./resolve-installed-packs.ts"');
    for (const source of [bindingService, bindingCommands])
      expect(source).not.toMatch(
        /run:schedule|pipeline:start|resolveVerifiedPackClosure|configurationDigest|effectiveRoles|resolveAliases|reconcilePacks/,
      );
    expect(projectCommands).not.toContain("packBindings.replace");
  });

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
    expect(runtimeCommand).toContain("ProjectStorageBootstrap");
    expect(runtimeCommand).not.toContain("createSqliteProjectStorage");
    expect(
      storageSqliteImports(runtimeCommandPath).filter(
        (specifier) =>
          specifier.includes("/repositories/") &&
          !specifier.endsWith("/sqlite-global-memory.repository.ts"),
      ),
    ).toEqual([]);
  });

  test("GP-07 definition authority stays outside scheduling and effective resolution", () => {
    const read = (path: string) =>
      readFileSync(join(repositoryRoot, path), "utf8");
    const service = read(
      "packages/application/src/domain-pack/manage-project-definitions.ts",
    );
    const contract = read(
      "packages/application/src/domain-pack/project-definition.ts",
    );
    const commands = read(
      "packages/runtime-host/src/commands/project-definition.ts",
    );
    const scheduling = [
      "packages/runtime-host/src/commands/run.ts",
      "packages/runtime-host/src/commands/pipeline.ts",
      "packages/application/src/runtime/schedule-agent-run.ts",
    ];
    for (const source of [service, contract, commands])
      expect(source).not.toMatch(
        /configurationDigest|resolveEffective|reconcileUpgrade|domain-pack-development/u,
      );
    expect(contract).toContain('"runtime_resolved"');
    expect(service).not.toContain("packBindings.replace");
    for (const path of scheduling)
      if (existsSync(join(repositoryRoot, path)))
        expect(read(path)).not.toMatch(
          /\.definitions\b|project_definition_override/u,
        );
    const sqlite = read(
      "migrations/project/0042_project_definition_ownership.sql",
    );
    const postgres = read(
      "supabase/migrations/20261003000100_project_definition_ownership.sql",
    );
    for (const migration of [sqlite, postgres])
      expect(migration).not.toMatch(
        /artifact_digest|installer_id|catalog_availability|configuration_digest|runtime_resolved/iu,
      );
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
    const offenders: string[] = [];
    for (const directory of ["packages", "apps"])
      for (const file of typescriptFiles(join(repositoryRoot, directory))) {
        const location = relative(repositoryRoot, file);
        if (location.startsWith("packages/storage-sqlite/")) continue;
        const disallowed = storageSqliteImports(file).filter(
          (specifier) => !isAllowedGlobalSqliteImport(file, specifier),
        );
        if (
          disallowed.length > 0 &&
          location !==
            "packages/storage-bootstrap/src/project-storage-bootstrap.ts"
        )
          offenders.push(location + " -> " + disallowed.join(", "));
      }
    expect(offenders).toEqual([]);
  });

  test("Runtime and daemon use the centralized provider bootstrap", () => {
    const bootstrapPath = join(
      repositoryRoot,
      "packages",
      "storage-bootstrap",
      "src",
      "project-storage-bootstrap.ts",
    );
    const bootstrap = readFileSync(bootstrapPath, "utf8");
    expect(bootstrap).toContain("@ai-office/storage-sqlite/");
    expect(bootstrap).toContain("@ai-office/storage-postgres/");

    const offenders: string[] = [];
    for (const directory of [
      join(repositoryRoot, "packages", "runtime-host"),
      join(repositoryRoot, "apps", "daemon"),
    ])
      for (const file of typescriptFiles(directory)) {
        const location = relative(repositoryRoot, file);
        const source = readFileSync(file, "utf8");
        if (source.includes("createSqliteProjectStorage"))
          offenders.push(`${location} constructs SQLite project storage`);
        if (
          importedSpecifiers(source).some((specifier) =>
            importsStoragePostgres(file, specifier),
          )
        )
          offenders.push(`${location} imports PostgreSQL storage directly`);
      }
    expect(offenders).toEqual([]);
  });

  test("PostgreSQL storage remains an inward infrastructure adapter", () => {
    const adapterRoot = join(repositoryRoot, "packages", "storage-postgres");
    const adapterFiles = typescriptFiles(adapterRoot);
    const adapterOffenders = adapterFiles.flatMap((file) =>
      importedSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => importsStorageSqlite(file, specifier))
        .map(
          (specifier) => `${relative(repositoryRoot, file)} -> ${specifier}`,
        ),
    );
    expect(adapterOffenders).toEqual([]);

    const applicationAndDomain = [
      ...typescriptFiles(join(repositoryRoot, "packages", "application")),
      ...typescriptFiles(join(repositoryRoot, "packages", "domain")),
    ];
    const inwardOffenders = applicationAndDomain.flatMap((file) =>
      importedSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => importsStoragePostgres(file, specifier))
        .map(
          (specifier) => `${relative(repositoryRoot, file)} -> ${specifier}`,
        ),
    );
    expect(inwardOffenders).toEqual([]);

    const runtimeOffenders = [
      ...typescriptFiles(join(repositoryRoot, "packages", "runtime-host")),
      ...typescriptFiles(join(repositoryRoot, "apps", "daemon")),
    ].flatMap((file) =>
      importedSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => importsStoragePostgres(file, specifier))
        .map(
          (specifier) => `${relative(repositoryRoot, file)} -> ${specifier}`,
        ),
    );
    expect(runtimeOffenders).toEqual([]);
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

test("retired CairnKeep adapter is absent from production composition", () => {
  expect(
    existsSync(join(repositoryRoot, "packages/cairnkeep-memory/package.json")),
  ).toBe(false);
  for (const directory of ["packages", "apps"])
    for (const file of typescriptFiles(join(repositoryRoot, directory))) {
      const source = readFileSync(file, "utf8");
      expect(
        importedSpecifiers(source).filter(
          (specifier) =>
            specifier.includes("cairnkeep-memory") ||
            specifier.includes("project-memory-provider.port") ||
            specifier.includes("legacy-memory-reader.port"),
        ),
        relative(repositoryRoot, file),
      ).toEqual([]);
    }
  assertNoPlatformMechanics(
    "packages/application/src/context/run-context-assembler.ts",
  );
  assertNoPlatformMechanics(
    "packages/application/src/project-memory/project-memory-identity.ts",
  );
});

test("active code, manifests, help, and generated guidance cannot advertise retired memory entry points", () => {
  const forbidden = [
    "@ai-office/cairnkeep-memory",
    "project-memory-provider.port",
    "legacy-memory-reader.port",
    "AI_OFFICE_PROJECT_MEMORY_PROVIDER",
    "project-memory:status",
    "knowledge:legacy-plan",
    "knowledge:legacy-import",
  ];
  const activeFiles = [
    ...["packages", "apps"].flatMap((directory) =>
      typescriptFiles(join(repositoryRoot, directory)),
    ),
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "bun.lock"),
    ...["packages", "apps"].flatMap((directory) =>
      readdirSync(join(repositoryRoot, directory))
        .map((name) => join(repositoryRoot, directory, name, "package.json"))
        .filter(existsSync),
    ),
    join(repositoryRoot, ".agents/skills/ai-office/SKILL.md"),
  ];
  for (const file of activeFiles) {
    const source = readFileSync(file, "utf8");
    for (const retired of forbidden)
      expect(
        source,
        `${relative(repositoryRoot, file)} still contains ${retired}`,
      ).not.toContain(retired);
  }
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
  // Gateway providers and the trusted Runtime composition for the two fixed
  // SurrealDB names are the only consumers of credential file values.
  expect(referencing("loadRuntimeHomeCredentialValue")).toEqual([
    "apps/daemon/src/bootstrap.ts",
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

test("only the Runtime admission service writes native knowledge", () => {
  const writes =
    /\.(?:recordMemory|recordDecision|recordNonRunKnowledge)\s*\(/u;
  const callers = ["packages", "apps", "scripts"]
    .flatMap((directory) => typescriptFiles(join(repositoryRoot, directory)))
    .filter((file) => writes.test(readFileSync(file, "utf8")))
    .map((file) => relative(repositoryRoot, file));
  // Workers, skills, host clients, hooks and the dashboard have no write path.
  expect(callers).toEqual([
    "packages/application/src/agent-knowledge/manage-knowledge-admission.ts",
  ]);
  // The admission service itself is reachable only through Runtime commands.
  const importers = ["packages", "apps", "scripts"]
    .flatMap((directory) => typescriptFiles(join(repositoryRoot, directory)))
    .filter((file) =>
      /from\s+"[^"]*agent-knowledge\/manage-knowledge-admission\.ts"/u.test(
        readFileSync(file, "utf8"),
      ),
    )
    .map((file) => relative(repositoryRoot, file))
    .sort();
  expect(importers).toEqual([
    "packages/runtime-host/src/commands/knowledge.ts",
    "packages/runtime-host/src/runtime-command.ts",
  ]);
});

describe("GP-10A development pack stays a reference artifact outside production", () => {
  const packDirectory = "packages/domain-pack-development";
  const names = /domain-pack-development|org\.ai-office\.development/u;

  /** Every file under a directory, whatever its type. */
  function allFiles(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap((entry) => {
      if (entry === "node_modules") return [];
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? allFiles(path) : [path];
    });
  }

  /** Imports of a pack source file that leave the pack and its contracts. */
  function importsOutsideContracts(file: string, source: string): string[] {
    return importedSpecifiers(source).filter((specifier) => {
      const target = resolvedTarget(file, specifier);
      if (target === null)
        return !specifier.startsWith("@ai-office/domain-pack-contracts/");
      return !(
        target.startsWith("packages/domain-pack-contracts/") ||
        target.startsWith(`${packDirectory}/`)
      );
    });
  }

  test("no package, app, entry point or script imports the pack package or contains its ID", () => {
    const scanned = ["packages", "apps", "bin", "scripts"].flatMap(
      (directory) => allFiles(join(repositoryRoot, directory)),
    );
    const mentions = scanned
      .filter((file) => names.test(readFileSync(file, "utf8")))
      .map((file) => relative(repositoryRoot, file))
      .sort();
    // The scan sees the pack, so an empty result elsewhere is not blindness.
    expect(mentions).toEqual([
      `${packDirectory}/README.md`,
      `${packDirectory}/manifest.json`,
      `${packDirectory}/outside-pack-vocabulary.json`,
      `${packDirectory}/package.json`,
    ]);
    // The layers the contract names were all walked.
    for (const layer of [
      "packages/domain/",
      "packages/application/",
      "packages/runtime-host/",
      "packages/storage-sqlite/",
      "packages/storage-postgres/",
      "packages/storage-surrealdb/",
      "packages/storage-bootstrap/",
      "apps/",
    ])
      expect(
        scanned.some((file) =>
          relative(repositoryRoot, file).startsWith(layer),
        ),
      ).toBe(true);
    // No path alias or workspace dependency reaches it either.
    for (const location of ["tsconfig.json", "vitest.config.ts"])
      expect(readFileSync(join(repositoryRoot, location), "utf8")).not.toMatch(
        names,
      );
    for (const manifest of scanned.filter(
      (file) =>
        file.endsWith("package.json") &&
        !relative(repositoryRoot, file).startsWith(`${packDirectory}/`),
    ))
      expect(readFileSync(manifest, "utf8")).not.toMatch(names);
    expect(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ).not.toMatch(names);
  });

  test("the pack package is data and imports only the contracts package", () => {
    const files = allFiles(join(repositoryRoot, packDirectory));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const location = relative(repositoryRoot, file);
      if (/\.(?:json|md)$/u.test(file)) continue;
      if (!/\.(?:ts|tsx|mts|js|mjs)$/u.test(file)) {
        offenders.push(`${location} is neither data nor source`);
        continue;
      }
      for (const specifier of importsOutsideContracts(
        file,
        readFileSync(file, "utf8"),
      ))
        offenders.push(`${location} -> ${specifier}`);
    }
    expect(offenders).toEqual([]);
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, packDirectory, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: "@ai-office/domain-pack-development",
      private: true,
      type: "module",
    });
    // The rule itself: contracts pass, anything else is reported.
    const probe = join(repositoryRoot, packDirectory, "src", "index.ts");
    expect(
      importsOutsideContracts(
        probe,
        [
          'import type { DomainPackManifest } from "../../domain-pack-contracts/src/index.ts";',
          'import { x } from "@ai-office/domain-pack-contracts/manifest.ts";',
          'import { local } from "./local.ts";',
          'import { Project } from "@ai-office/domain/project/project.ts";',
          'import { y } from "../../application/src/errors.ts";',
          'import { readFileSync } from "node:fs";',
        ].join("\n"),
      ),
    ).toEqual([
      "@ai-office/domain/project/project.ts",
      "../../application/src/errors.ts",
      "node:fs",
    ]);
  });

  test("production composes an empty catalog and registers no pack", () => {
    const runtimeCommand = readFileSync(
      join(repositoryRoot, "packages/runtime-host/src/runtime-command.ts"),
      "utf8",
    );
    expect(runtimeCommand.replace(/\s+/gu, " ")).toContain(
      "options.installedPacks ?? new InMemoryInstalledDomainPackCatalog(1, [])",
    );
    const production = ["packages", "apps", "bin", "scripts"].flatMap(
      (directory) => typescriptFiles(join(repositoryRoot, directory)),
    );
    // One place constructs a catalog, and nothing registers an artifact in
    // one: a pack is resolvable only from a catalog a caller supplies.
    expect(
      production
        .filter((file) =>
          /new InMemoryInstalledDomainPackCatalog\(/u.test(
            readFileSync(file, "utf8"),
          ),
        )
        .map((file) => relative(repositoryRoot, file)),
    ).toEqual(["packages/runtime-host/src/runtime-command.ts"]);
    expect(
      production
        .filter((file) => /\.register\(/u.test(readFileSync(file, "utf8")))
        .map((file) => relative(repositoryRoot, file)),
    ).toEqual([]);
  });
});

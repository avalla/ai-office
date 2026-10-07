import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// GP-14A declares validator references as data. Nothing that reads or
// resolves them may reach a process, the network, the file system, a
// connector or an adapter: this is checked on the import graph of the files
// that hold the contract.

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Every module specifier a source file imports or re-exports. */
function specifiers(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gu,
    ),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => match[1]!);
}

describe("GP-14A boundary", () => {
  test("the contracts package imports no file system, network or process module", () => {
    const directory = "packages/domain-pack-contracts/src";
    const files = readdirSync(join(root, directory)).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(files).toContain("manifest.ts");
    const imported = files.flatMap((name) =>
      specifiers(read(`${directory}/${name}`)),
    );
    // Only hashing and the package's own modules.
    expect(imported.filter((value) => !value.startsWith("./"))).toEqual([
      "node:crypto",
    ]);
    for (const value of imported)
      expect(value).not.toMatch(
        /^(?:node:)?(?:fs|net|http|https|child_process|dgram|dns|tls|worker_threads|cluster|os|vm)(?:\/|$)|^bun(?::|$)/u,
      );
    // Nor does any file reach for a global that runs or fetches.
    for (const name of files)
      expect(read(`${directory}/${name}`)).not.toMatch(
        /\b(?:fetch|eval)\s*\(|new Function\b|Bun\.(?:spawn|file|write)/u,
      );
  });

  test("the contract modules reach no connector, adapter, provider or host module, directly or transitively", () => {
    const newModules = [
      "packages/application/src/domain-pack/pack-evidence-contracts.ts",
      "packages/application/src/domain-pack/pack-evidence-contract-changes.ts",
    ];
    // The transitive closure of relative imports, as repository paths.
    const closure = new Set<string>();
    const visit = (file: string): void => {
      if (closure.has(file)) return;
      closure.add(file);
      for (const value of specifiers(read(file)))
        if (value.startsWith("."))
          visit(relative(root, resolve(root, dirname(file), value)));
    };
    for (const file of newModules) visit(file);
    expect(closure.size).toBeGreaterThan(newModules.length);
    // The closure runs through the resolver, which already imports the
    // application-level GP-16 provider port; no infrastructure module is in it.
    for (const file of closure)
      expect([
        file,
        /connector|llm-gateway|storage-|runtime-host|^apps\//u.test(file),
      ]).toEqual([file, false]);
    // Bare specifiers are the contracts package and hashing, nothing else.
    for (const file of closure)
      for (const value of specifiers(read(file)).filter(
        (entry) => !entry.startsWith("."),
      ))
        expect([file, value]).toEqual([
          file,
          expect.stringMatching(/^node:crypto$|domain-pack-contracts/u),
        ]);
  });

  test("the resolver's import of the provider port is the GP-16 binding only, never a validator path", () => {
    // The resolver may import the operation provider port for capability
    // binding; the new modules must not be the path that leads there. The
    // limit: this inspects imports, not what a function does with them.
    for (const file of [
      "packages/application/src/domain-pack/pack-evidence-contracts.ts",
      "packages/application/src/domain-pack/pack-evidence-contract-changes.ts",
    ])
      expect(
        specifiers(read(file)).filter((value) =>
          /operation-provider|capability-contracts/u.test(value),
        ),
      ).toEqual([]);
  });

  test("no validator vocabulary reaches the operation provider port or the connector registry", () => {
    for (const file of [
      "packages/application/src/ports/operation-provider-catalog.port.ts",
      "packages/runtime-host/src/operation-provider-catalog.ts",
    ])
      expect(read(file)).not.toMatch(/validator|evidence|adapter/iu);
  });
});

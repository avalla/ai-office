import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("the resolver and the contract views import no connector, adapter or provider package", () => {
    for (const file of [
      "packages/application/src/domain-pack/pack-evidence-contracts.ts",
      "packages/application/src/domain-pack/pack-evidence-contract-changes.ts",
      "packages/application/src/domain-pack/resolve-project-configuration.ts",
    ])
      for (const value of specifiers(read(file)).filter(
        (entry) => entry !== "node:crypto",
      ))
        expect([
          file,
          value.startsWith(".") || value.includes("domain-pack-contracts"),
        ]).toEqual([file, true]);
  });

  test("no validator vocabulary reaches the operation provider port or the connector registry", () => {
    for (const file of [
      "packages/application/src/ports/operation-provider-catalog.port.ts",
      "packages/runtime-host/src/operation-provider-catalog.ts",
    ])
      expect(read(file)).not.toMatch(/validator|evidence|adapter/iu);
  });
});

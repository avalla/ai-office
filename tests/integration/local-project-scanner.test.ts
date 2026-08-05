import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalProjectScanner } from "../../apps/cli/src/local-project-scanner.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalProjectScanner", () => {
  test("detects a Bun TypeScript project with Vitest", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-import-"));
    temporaryDirectories.push(root);

    writeFileSync(join(root, "bun.lock"), "");
    writeFileSync(join(root, "index.ts"), "export const value = 1;");
    writeFileSync(join(root, "README.md"), "# Demo");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "latest" } })
    );

    const result = await new LocalProjectScanner().scan(root);

    expect(result.packageManager).toBe("bun");
    expect(result.languages).toContain("TypeScript");
    expect(result.testing).toContain("Vitest");
    expect(result.documentation).toContain("README.md");
  });
});

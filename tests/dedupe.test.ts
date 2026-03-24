import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { FRAMEWORK_DIR, runGit } from "./helpers";

describe("repo hygiene", () => {
  it("has no tracked exact duplicate files", () => {
    const result = runGit(FRAMEWORK_DIR, ["ls-files"]);
    expect(result.exitCode).toBe(0);

    const duplicates = new Map<string, string[]>();

    const trackedPaths = result.stdout
      .split("\n")
      .filter(Boolean)
      .filter((relativePath) => existsSync(join(FRAMEWORK_DIR, relativePath)));

    for (const relativePath of trackedPaths) {
      const content = readFileSync(join(FRAMEWORK_DIR, relativePath));
      const hash = createHash("sha1").update(content).digest("hex");
      const existing = duplicates.get(hash) ?? [];
      existing.push(relativePath);
      duplicates.set(hash, existing);
    }

    const exactDuplicates = [...duplicates.values()]
      .filter((paths) => paths.length > 1)
      .sort((left, right) => left[0].localeCompare(right[0]));

    expect(exactDuplicates).toEqual([]);
  });
});

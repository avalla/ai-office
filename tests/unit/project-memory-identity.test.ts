import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveProjectMemoryIdentity,
  projectMemoryIdentityPattern,
} from "@ai-office/application/project-memory/project-memory-identity.ts";
import { LocalProjectBindingReader } from "@ai-office/project-binding/local-project-binding-reader.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function checkout(repositoryId: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), `ao-memory-${name}-`));
  cleanup.push(root);
  mkdirSync(join(root, ".ai-office"));
  writeFileSync(
    join(root, ".ai-office", "project.json"),
    `${JSON.stringify({ schemaVersion: 2, managedBy: "ai-office", repositoryId })}\n`,
  );
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  return root;
}

async function identityFor(directory: string): Promise<string> {
  const inspection = await new LocalProjectBindingReader().inspect(directory, {
    ancestors: true,
  });
  const binding = inspection.binding;
  if (binding?.schemaVersion !== 2) throw new Error("fixture binding missing");
  return deriveProjectMemoryIdentity(binding.repositoryId).memoryProjectId;
}

describe("project memory identity", () => {
  test("every checkout and worktree of one repository ID shares one identity", async () => {
    const main = checkout("repo_shared", "main");
    const feature = checkout("repo_shared", "feature-worktree");
    const fix = checkout("repo_shared", "fix-worktree");
    const identities = await Promise.all([
      identityFor(main),
      identityFor(join(feature, "src", "deep")),
      identityFor(fix),
    ]);
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toMatch(projectMemoryIdentityPattern);
  });

  test("different repository IDs derive different identities", () => {
    expect(deriveProjectMemoryIdentity("repo_a").memoryProjectId).not.toBe(
      deriveProjectMemoryIdentity("repo_b").memoryProjectId,
    );
  });

  test("the derivation is a fixed, path-free function of the repository ID alone", () => {
    const repositoryId = "repo_0f1e2d3c";
    const before = deriveProjectMemoryIdentity(repositoryId).memoryProjectId;
    const previous = process.cwd();
    const home = process.env.HOME;
    try {
      process.chdir(tmpdir());
      process.env.HOME = "/somewhere/else";
      expect(deriveProjectMemoryIdentity(repositoryId).memoryProjectId).toBe(
        before,
      );
    } finally {
      process.chdir(previous);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
    // Golden vector (independently: printf "ai-office-project-memory-identity-v1\\0repo_0f1e2d3c" | sha256sum).
    // Changing the derivation would orphan existing memory.
    expect(before).toBe("aio-cbfb77d671998c5670472590f3c237dc");
    expect(before).not.toContain("/");
    expect(before.length).toBeLessThanOrEqual(64);
    // Existing imported records retain this namespace.
    expect(before).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  test("an empty or oversized repository ID is refused", () => {
    expect(() => deriveProjectMemoryIdentity(" ")).toThrow();
    expect(() => deriveProjectMemoryIdentity("r".repeat(257))).toThrow();
  });
});

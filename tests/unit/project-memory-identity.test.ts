import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveProjectMemoryIdentity,
  projectMemoryIdentityPattern,
} from "@ai-office/application/project-memory/project-memory-identity.ts";
import { LocalProjectBindingReader } from "@ai-office/project-binding/local-project-binding-reader.ts";
import { resolveProjectMemoryConfiguration } from "@ai-office/cairnkeep-memory/cairnkeep-configuration.ts";
import {
  cairnKeepChildEnvironment,
  cairnKeepSearchTerm,
  normalizeCairnKeepResults,
  parseCairnKeepSearchResult,
} from "@ai-office/cairnkeep-memory/cairnkeep-memory-provider.ts";

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
    // Valid for CairnKeep named scopes and project IDs.
    expect(before).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  test("an empty or oversized repository ID is refused", () => {
    expect(() => deriveProjectMemoryIdentity(" ")).toThrow();
    expect(() => deriveProjectMemoryIdentity("r".repeat(257))).toThrow();
  });
});

describe("CairnKeep configuration and boundary parsing", () => {
  test("configuration is explicit, disabled by default, and fails clearly", () => {
    expect(resolveProjectMemoryConfiguration({}, "linux")).toEqual({
      kind: "disabled",
    });
    expect(
      resolveProjectMemoryConfiguration(
        { AI_OFFICE_PROJECT_MEMORY_PROVIDER: "none" },
        "darwin",
      ),
    ).toEqual({ kind: "disabled" });
    expect(
      resolveProjectMemoryConfiguration(
        { AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep" },
        "darwin",
      ),
    ).toEqual({ kind: "cairnkeep", command: "cairn", timeoutMs: 5_000 });
    for (const environment of [
      { AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkep" },
      {
        AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
        AI_OFFICE_CAIRNKEEP_COMMAND: "./bin/cairn",
      },
      {
        AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
        AI_OFFICE_CAIRNKEEP_COMMAND: "cairn memory_write",
      },
      {
        AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
        AI_OFFICE_PROJECT_MEMORY_TIMEOUT_MS: "99",
      },
      {
        AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
        AI_OFFICE_PROJECT_MEMORY_TIMEOUT_MS: "5s",
      },
    ])
      expect(resolveProjectMemoryConfiguration(environment, "linux").kind).toBe(
        "misconfigured",
      );
  });

  test("the child environment is an allowlist that forces the single-tool profile", () => {
    expect(
      cairnKeepChildEnvironment({
        PATH: "/bin",
        HOME: "/home/u",
        CAIRN_AGENTFS_BASE_DIR: "/data/cairn",
        CAIRN_LLM_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        MCP_HTTP_PORT: "1",
        CAIRN_MCP_TOOL_PROFILE: "full",
        CAIRN_TYPED_MEMORY_NODES: "1",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      CAIRN_AGENTFS_BASE_DIR: "/data/cairn",
      CAIRN_MCP_TOOL_PROFILE: "custom",
      CAIRN_MCP_ALLOWED_TOOLS: "memory_search",
    });
  });

  test("the substring search term is the most distinctive word", () => {
    expect(cairnKeepSearchTerm("Fix the login flow for users")).toBe("login");
    expect(cairnKeepSearchTerm("Rotate database credentials")).toBe(
      "credentials",
    );
    expect(cairnKeepSearchTerm("Document the deploy flow")).toBe("deploy");
    expect(cairnKeepSearchTerm("Implement upload retries")).toBe("retries");
    expect(cairnKeepSearchTerm("a b")).toBe("a b");
  });

  const scope = "aio-00000000000000000000000000000000";
  test.each([
    [{}],
    [{ structuredContent: { count: 2, results: [] } }],
    [
      {
        structuredContent: {
          count: 1,
          results: [{ scope, key: "", value: "v", score: 1 }],
        },
      },
    ],
    [
      {
        structuredContent: {
          count: 1,
          results: [{ scope, key: "k", value: 3, score: 1 }],
        },
      },
    ],
    [
      {
        structuredContent: {
          count: 1,
          results: [{ scope, key: "k", value: "v", score: Number.NaN }],
        },
      },
    ],
    [
      {
        structuredContent: {
          count: 1,
          results: [{ scope, key: "k\u0000", value: "v", score: 1 }],
        },
      },
    ],
    [
      {
        structuredContent: {
          count: 1,
          results: [{ scope, key: "k".repeat(257), value: "v", score: 1 }],
        },
      },
    ],
    [{ content: [{ type: "text", text: "not json" }] }],
    [
      {
        structuredContent: {
          count: 51,
          results: Array.from({ length: 51 }, (_, i) => ({
            scope,
            key: `k${i}`,
            value: "v",
            score: 1,
          })),
        },
      },
    ],
  ])("malformed payload %# fails closed", (payload) => {
    expect(() => parseCairnKeepSearchResult(payload, scope)).toThrow(
      expect.objectContaining({ code: "PROJECT_MEMORY_INVALID_RESPONSE" }),
    );
  });

  test("control and format characters are neutralized in excerpts but not in the digest", () => {
    const value = "a\u0000b\u202Ec\td\ne";
    const [hit] = normalizeCairnKeepResults(
      [{ scope, key: "k", value, score: 1 }],
      1,
    );
    expect(hit!.excerpt).toBe("a b c\td\ne");
    expect(hit!.contentDigest).toBe(
      `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
    );
  });

  test("normalization is deterministic regardless of provider order", () => {
    const results = [
      { scope, key: "b", value: "2", score: 1 },
      { scope, key: "a", value: "1", score: 1 },
      { scope, key: "c", value: "3", score: 2 },
    ];
    const forward = normalizeCairnKeepResults(results, 5);
    const reversed = normalizeCairnKeepResults([...results].reverse(), 5);
    expect(forward).toEqual(reversed);
    expect(forward.map((value) => value.referenceId)).toEqual(["c", "a", "b"]);
    expect(normalizeCairnKeepResults(results, 2)).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import { knowledgeCompatibilitySearchTerm } from "@ai-office/application/context/knowledge-search-term.ts";
import { cairnKeepSearchTerm } from "../../packages/cairnkeep-memory/src/cairnkeep-memory-provider.ts";
import {
  assertKnowledgeScope,
  assertKnowledgeIdentifier,
  assertKnowledgeSearchQuery,
  knowledgeRetrievalLimits,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";

describe("AgentKnowledgeStore application boundary", () => {
  it("preserves the deployed CairnKeep literal-term choices", () => {
    for (const [query, expected] of [
      ["Fix the login flow for users", "login"],
      ["Rotate database credentials", "credentials"],
      ["Document the deploy flow", "deploy"],
      ["Implement upload retries", "retries"],
      ["Review API_auth failures", "api_auth"],
      ["Alpha BETA", "alpha"],
      ["Error, retry!", "error"],
      ["foo-bar baz_qux", "foo-bar"],
      ["v2a 2026", "2026"],
      ["Fix the and", "Fix the and"],
      ["Å β 𐐀𐐁", "Å β 𐐀𐐁"],
      ["!!!", "!!!"],
      ["RÉSUMÉ café", "résumé"],
      ["𐐀𐐁𐐂 xy", "𐐨𐐩𐐪"],
      ["X".repeat(knowledgeRetrievalLimits.queryCharacters), "x".repeat(knowledgeRetrievalLimits.queryCharacters)],
      ["a b", "a b"],
    ] as const) {
      expect(knowledgeCompatibilitySearchTerm(query)).toBe(expected);
      expect(cairnKeepSearchTerm(query)).toBe(expected);
    }
  });

  it("selects Unicode literals with host-independent default lowercase", () => {
    for (const [query, expected] of [
      ["İSTANBUL", "stanbul"],
      ["ΟΣΟΣ", "οσος"],
      ["ẞtraße", "ßtraße"],
      ["Kelvin", "kelvin"],
    ] as const) {
      expect(knowledgeCompatibilitySearchTerm(query)).toBe(expected);
    }
  });

  it("requires a trusted tenant and portable repository identity without fallback", () => {
    expect(() => assertKnowledgeScope({ tenantId: "tenant-a", repositoryId: "repo-a" })).not.toThrow();
    for (const scope of [
      { tenantId: "", repositoryId: "repo-a" },
      { tenantId: "tenant-a", repositoryId: "" },
      { tenantId: "tenant-a", repositoryId: " " },
      { tenantId: " tenant-a", repositoryId: "repo-a" },
      { tenantId: "tenant-a ", repositoryId: "repo-a" },
      { tenantId: "tenant-a", repositoryId: " repo-a" },
      { tenantId: "tenant-a", repositoryId: "repo-a " },
      { tenantId: "tenant-a", repositoryId: "repo-a".repeat(60) },
      { tenantId: "tenant-a".repeat(60), repositoryId: "repo-a" },
      { tenantId: 7, repositoryId: "repo-a" },
      { tenantId: "tenant-a", repositoryId: 7 },
    ]) {
      expect(() => assertKnowledgeScope(scope as never)).toThrow(
        expect.objectContaining({ code: "KNOWLEDGE_INVALID_SCOPE" }),
      );
    }
  });

  it("requires canonical bounded identifiers before query construction", () => {
    expect(() => assertKnowledgeIdentifier("task-a")).not.toThrow();
    for (const id of ["", " ", " task-a", "task-a ", "x".repeat(257), 42, null, {}]) {
      expect(() => assertKnowledgeIdentifier(id)).toThrow(
        expect.objectContaining({ code: "KNOWLEDGE_INVALID_QUERY" }),
      );
    }
  });

  it("accepts only a bounded literal query and a bounded result count", () => {
    expect(() => assertKnowledgeSearchQuery({
      text: "deployment",
      limit: knowledgeRetrievalLimits.maxResults,
      agentId: "agent-a",
    })).not.toThrow();
    expect(() => assertKnowledgeSearchQuery({
      text: "𐐀".repeat(knowledgeRetrievalLimits.queryCharacters),
    })).not.toThrow();
    for (const query of [
      { text: "" },
      { text: " deployment" },
      { text: "x".repeat(knowledgeRetrievalLimits.queryCharacters + 1) },
      { text: "deployment", limit: 0 },
      { text: "deployment", limit: knowledgeRetrievalLimits.maxResults + 1 },
      { text: "deployment", agentId: " " },
    ]) {
      expect(() => assertKnowledgeSearchQuery(query)).toThrow(
        expect.objectContaining({ code: "KNOWLEDGE_INVALID_QUERY" }),
      );
    }
  });
});

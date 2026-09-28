import { describe, expect, it } from "vitest";
import {
  assertKnowledgeScope,
  assertKnowledgeSearchQuery,
  knowledgeRetrievalLimits,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";

describe("AgentKnowledgeStore application boundary", () => {
  it("requires a trusted tenant and portable repository identity without fallback", () => {
    expect(() => assertKnowledgeScope({ tenantId: "tenant-a", repositoryId: "repo-a" })).not.toThrow();
    for (const scope of [
      { tenantId: "", repositoryId: "repo-a" },
      { tenantId: "tenant-a", repositoryId: "" },
      { tenantId: "tenant-a", repositoryId: " " },
    ]) {
      expect(() => assertKnowledgeScope(scope)).toThrow(
        expect.objectContaining({ code: "KNOWLEDGE_INVALID_SCOPE" }),
      );
    }
  });

  it("accepts only a bounded literal query and a bounded result count", () => {
    expect(() => assertKnowledgeSearchQuery({
      text: "deployment",
      limit: knowledgeRetrievalLimits.maxResults,
      agentId: "agent-a",
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

import { describe, expect, it } from "vitest";
import {
  assertKnowledgeScope,
  assertKnowledgeIdentifier,
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

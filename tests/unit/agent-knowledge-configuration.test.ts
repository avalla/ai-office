import { describe, expect, it } from "vitest";
import { resolveAgentKnowledgeConfiguration } from "@ai-office/storage-surrealdb/agent-knowledge-configuration.ts";

const configured = {
  AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER: "surrealdb",
  AI_OFFICE_SURREALDB_URL: "ws://127.0.0.1:8000",
  AI_OFFICE_SURREALDB_NAMESPACE: "ai_office",
  AI_OFFICE_SURREALDB_DATABASE: "knowledge",
  AI_OFFICE_SURREALDB_USERNAME: "operator",
  AI_OFFICE_SURREALDB_PASSWORD: "secret",
  AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID: "tenant-a",
};

describe("agent knowledge host configuration", () => {
  it("is disabled by default, independently of CairnKeep", () => {
    expect(resolveAgentKnowledgeConfiguration({})).toEqual({
      kind: "disabled",
    });
    expect(
      resolveAgentKnowledgeConfiguration({
        AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
        AI_OFFICE_SURREALDB_PASSWORD: "unused",
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("requires explicit trusted scope and a complete SurrealDB connection", () => {
    expect(resolveAgentKnowledgeConfiguration(configured)).toEqual({
      kind: "surrealdb",
      tenantId: "tenant-a",
      connection: {
        endpoint: "ws://127.0.0.1:8000",
        namespace: "ai_office",
        database: "knowledge",
        username: "operator",
        password: "secret",
      },
    });
    expect(
      resolveAgentKnowledgeConfiguration(
        {
          ...configured,
          AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID: "untrusted-tenant",
        },
        "authoritative-tenant",
      ),
    ).toMatchObject({ kind: "surrealdb", tenantId: "authoritative-tenant" });
    expect(resolveAgentKnowledgeConfiguration(configured, " bad ")).toEqual({
      kind: "misconfigured",
      provider: "surrealdb",
    });
  });

  it.each(["none", ""])("disables the %s provider", (provider) => {
    expect(
      resolveAgentKnowledgeConfiguration({
        ...configured,
        AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER: provider,
      }),
    ).toEqual({ kind: "disabled" });
  });

  it.each([
    "ws://localhost:8000",
    "ws://127.0.0.1:8000",
    "ws://[::1]:8000",
    "wss://database.example:8000",
  ])("accepts the intended endpoint %s", (endpoint) => {
    expect(
      resolveAgentKnowledgeConfiguration({
        ...configured,
        AI_OFFICE_SURREALDB_URL: endpoint,
      }).kind,
    ).toBe("surrealdb");
  });

  it.each([
    { AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER: "other" },
    { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID: "" },
    { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID: " tenant" },
    { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID: "a".repeat(257) },
    { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID: "tenant\u0000id" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "x".repeat(2049) },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://user:pass@127.0.0.1:8000" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://@localhost:8000" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://localhost:8000?" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://localhost:8000#" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://localhost:8000\n" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "file:///tmp/knowledge" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://database.example:8000" },
    {
      ...configured,
      AI_OFFICE_SURREALDB_URL: "ws://localhost.example.com:8000",
    },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://127.1:8000" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://[::2]:8000" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "ws://[::1" },
    { ...configured, AI_OFFICE_SURREALDB_URL: "wss://[invalid" },
    { ...configured, AI_OFFICE_SURREALDB_NAMESPACE: "bad name" },
    { ...configured, AI_OFFICE_SURREALDB_DATABASE: "bad.name" },
    { ...configured, AI_OFFICE_SURREALDB_USERNAME: "" },
    { ...configured, AI_OFFICE_SURREALDB_PASSWORD: "" },
    { ...configured, AI_OFFICE_SURREALDB_DATABASE: undefined },
  ])(
    "rejects incomplete or unsafe configuration without echoing values",
    (environment) => {
      expect(resolveAgentKnowledgeConfiguration(environment)).toEqual({
        kind: "misconfigured",
        provider:
          environment.AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER === "surrealdb"
            ? "surrealdb"
            : "unknown",
      });
    },
  );
});

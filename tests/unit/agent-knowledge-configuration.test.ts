import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadAgentKnowledgeConfiguration,
  resolveAgentKnowledgeConfiguration,
} from "@ai-office/storage-surrealdb/agent-knowledge-configuration.ts";
import { runtimeHomeAgentKnowledgePath } from "@ai-office/runtime-paths/agent-knowledge-location.ts";

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

describe("managed Agent Knowledge source", () => {
  function withHome(check: (home: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), "ai-office-knowledge-config-"));
    try {
      check(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const managed = { AI_OFFICE_AGENT_KNOWLEDGE_SOURCE: "runtime_home" };
  const document = {
    provider: "surrealdb",
    endpoint: "ws://127.0.0.1:8000",
    namespace: "ai_office",
    database: "knowledge",
    tenantId: "tenant-a",
  };
  const credentials = (name: string) =>
    name === "AI_OFFICE_SURREALDB_USERNAME" ? "operator" : "secret";

  it("loads only the Runtime-home file and protected credentials", () =>
    withHome((home) => {
      writeFileSync(
        runtimeHomeAgentKnowledgePath(home),
        JSON.stringify(document),
      );
      const loadCredential = vi.fn(credentials);
      const result = loadAgentKnowledgeConfiguration(
        {
          ...configured,
          ...managed,
          AI_OFFICE_SURREALDB_PASSWORD: "ambient-secret",
        },
        { runtimeHome: home, loadCredential },
      );
      expect(result).toMatchObject({
        kind: "surrealdb",
        tenantId: "tenant-a",
        connection: { password: "secret", username: "operator" },
      });
      expect(loadCredential).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain("ambient-secret");
    }));

  it("keeps absent provider disabled and never falls back to ambient values", () =>
    withHome((home) => {
      expect(
        loadAgentKnowledgeConfiguration(
          { ...configured, ...managed },
          {
            runtimeHome: home,
            loadCredential: credentials,
          },
        ),
      ).toEqual({ kind: "disabled" });
      writeFileSync(runtimeHomeAgentKnowledgePath(home), "{invalid");
      expect(
        loadAgentKnowledgeConfiguration(
          { ...configured, ...managed },
          {
            runtimeHome: home,
            loadCredential: credentials,
          },
        ),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
    }));

  it("refuses a symlinked managed file without reading its target", () =>
    withHome((home) => {
      const target = join(home, "target.json");
      writeFileSync(target, JSON.stringify(document));
      symlinkSync(target, runtimeHomeAgentKnowledgePath(home));
      const loadCredential = vi.fn(credentials);
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential,
        }),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
      expect(loadCredential).not.toHaveBeenCalled();
    }));

  it("rejects credential fields, missing credentials and invalid tenant without echoing them", () =>
    withHome((home) => {
      const file = runtimeHomeAgentKnowledgePath(home);
      writeFileSync(
        file,
        JSON.stringify({ ...document, password: "leaked-secret" }),
      );
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential: credentials,
        }),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
      writeFileSync(file, JSON.stringify(document));
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential: () => undefined,
        }),
      ).toEqual({ kind: "misconfigured", provider: "surrealdb" });
      writeFileSync(file, JSON.stringify({ ...document, tenantId: " bad " }));
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential: credentials,
        }),
      ).toEqual({ kind: "misconfigured", provider: "surrealdb" });
    }));

  it("uses the authoritative PostgreSQL tenant and rejects a duplicate configured tenant", () =>
    withHome((home) => {
      const file = runtimeHomeAgentKnowledgePath(home);
      writeFileSync(file, JSON.stringify(document));
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          authoritativeTenantId: "postgres-tenant",
          loadCredential: credentials,
        }),
      ).toEqual({ kind: "misconfigured", provider: "surrealdb" });
      writeFileSync(file, JSON.stringify({ ...document, tenantId: undefined }));
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          authoritativeTenantId: "postgres-tenant",
          loadCredential: credentials,
        }),
      ).toMatchObject({ kind: "surrealdb", tenantId: "postgres-tenant" });
    }));

  it("preserves the foreground environment source and rejects unknown source markers", () =>
    withHome((home) => {
      writeFileSync(runtimeHomeAgentKnowledgePath(home), "{invalid");
      expect(
        loadAgentKnowledgeConfiguration(configured, {
          runtimeHome: home,
          loadCredential: () => undefined,
        }),
      ).toMatchObject({ kind: "surrealdb", tenantId: "tenant-a" });
      expect(
        loadAgentKnowledgeConfiguration(
          { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_SOURCE: "other" },
          { runtimeHome: home, loadCredential: credentials },
        ),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
      expect(
        loadAgentKnowledgeConfiguration(
          { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_SOURCE: "" },
          { runtimeHome: home, loadCredential: credentials },
        ),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
    }));
});

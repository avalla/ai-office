import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  function writeManagedDocument(home: string, content: string | Buffer): void {
    const file = runtimeHomeAgentKnowledgePath(home);
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  function expectRejectedWithoutCredentials(
    home: string,
    environment: Record<string, string> = managed,
  ): void {
    const canary = "ak09-protected-credential-canary";
    const loadCredential = vi.fn((_name: string) => canary);
    const result = loadAgentKnowledgeConfiguration(
      { ...configured, ...environment },
      { runtimeHome: home, loadCredential },
    );
    expect(result.kind).toBe("misconfigured");
    expect(loadCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result).includes(canary)).toBe(false);
  }

  it("loads only the Runtime-home file and protected credentials", () =>
    withHome((home) => {
      writeManagedDocument(home, JSON.stringify(document));
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
      writeManagedDocument(home, "{invalid");
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
      expectRejectedWithoutCredentials(home);
    }));

  it.each([
    ["group-writable", 0o620],
    ["world-writable", 0o602],
  ])("rejects a %s remote endpoint before loading credentials", (_name, mode) =>
    withHome((home) => {
      const file = runtimeHomeAgentKnowledgePath(home);
      writeManagedDocument(
        home,
        JSON.stringify({ ...document, endpoint: "wss://redirect.example" }),
      );
      chmodSync(file, mode);
      expectRejectedWithoutCredentials(home);
    }),
  );

  it("rejects a non-regular managed file before loading credentials", () =>
    withHome((home) => {
      mkdirSync(runtimeHomeAgentKnowledgePath(home), { mode: 0o700 });
      expectRejectedWithoutCredentials(home);
    }));

  it("rejects a managed file larger than 8 KiB before loading credentials", () =>
    withHome((home) => {
      writeManagedDocument(home, " ".repeat(8193));
      expectRejectedWithoutCredentials(home);
    }));

  it.each([
    ["malformed JSON", "{invalid"],
    ["extra field", { ...document, unexpected: "value" }],
    ["credential field", { ...document, password: "not-a-credential" }],
    ["invalid provider", { ...document, provider: "other" }],
    ["invalid endpoint", { ...document, endpoint: "ws://redirect.example" }],
    ["invalid namespace", { ...document, namespace: "bad name" }],
    ["invalid database", { ...document, database: "bad.name" }],
    ["missing SQLite tenant", { ...document, tenantId: undefined }],
    ["invalid SQLite tenant", { ...document, tenantId: " bad " }],
  ])("rejects %s before loading credentials", (_name, content) =>
    withHome((home) => {
      writeManagedDocument(
        home,
        typeof content === "string" ? content : JSON.stringify(content),
      );
      expectRejectedWithoutCredentials(home);
    }),
  );

  it("rejects malformed UTF-8 before loading credentials", () =>
    withHome((home) => {
      writeManagedDocument(home, Buffer.from([0xc3, 0x28]));
      expectRejectedWithoutCredentials(home);
    }));

  it.skipIf(typeof process.getuid !== "function")(
    "rejects a file not owned by the Runtime UID without requiring root",
    () =>
      withHome((home) => {
        const file = runtimeHomeAgentKnowledgePath(home);
        writeManagedDocument(home, JSON.stringify(document));
        const currentOwner = statSync(file).uid;
        const getuid = vi
          .spyOn(process, "getuid")
          .mockReturnValue(currentOwner + 1);
        try {
          expectRejectedWithoutCredentials(home);
        } finally {
          getuid.mockRestore();
        }
      }),
  );

  it("rejects credential fields, missing credentials and invalid tenant without echoing them", () =>
    withHome((home) => {
      writeManagedDocument(
        home,
        JSON.stringify({ ...document, password: "leaked-secret" }),
      );
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential: credentials,
        }),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
      writeManagedDocument(home, JSON.stringify(document));
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential: () => undefined,
        }),
      ).toEqual({ kind: "misconfigured", provider: "surrealdb" });
      writeManagedDocument(
        home,
        JSON.stringify({ ...document, tenantId: " bad " }),
      );
      expect(
        loadAgentKnowledgeConfiguration(managed, {
          runtimeHome: home,
          loadCredential: credentials,
        }),
      ).toEqual({ kind: "misconfigured", provider: "surrealdb" });
    }));

  it("uses the authoritative PostgreSQL tenant and rejects a duplicate configured tenant", () =>
    withHome((home) => {
      writeManagedDocument(home, JSON.stringify(document));
      const loadCredential = vi.fn(credentials);
      const conflict = loadAgentKnowledgeConfiguration(managed, {
        runtimeHome: home,
        authoritativeTenantId: "postgres-tenant",
        loadCredential,
      });
      expect(conflict.kind).toBe("misconfigured");
      expect(loadCredential).not.toHaveBeenCalled();
      writeManagedDocument(
        home,
        JSON.stringify({ ...document, tenantId: undefined }),
      );
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
      writeManagedDocument(home, "{invalid");
      const loadCredential = vi.fn(credentials);
      expect(
        loadAgentKnowledgeConfiguration(configured, {
          runtimeHome: home,
          loadCredential,
        }),
      ).toMatchObject({ kind: "surrealdb", tenantId: "tenant-a" });
      expect(loadCredential).not.toHaveBeenCalled();
      expect(
        loadAgentKnowledgeConfiguration(
          { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_SOURCE: "other" },
          { runtimeHome: home, loadCredential },
        ),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
      expect(loadCredential).not.toHaveBeenCalled();
      expect(
        loadAgentKnowledgeConfiguration(
          { ...configured, AI_OFFICE_AGENT_KNOWLEDGE_SOURCE: "" },
          { runtimeHome: home, loadCredential },
        ),
      ).toEqual({ kind: "misconfigured", provider: "unknown" });
      expect(loadCredential).not.toHaveBeenCalled();
    }));
});

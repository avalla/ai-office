import type { SurrealAgentKnowledgeConfig } from "./connect-agent-knowledge-store.ts";

export const agentKnowledgeEnvironment = {
  provider: "AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER",
  endpoint: "AI_OFFICE_SURREALDB_URL",
  namespace: "AI_OFFICE_SURREALDB_NAMESPACE",
  database: "AI_OFFICE_SURREALDB_DATABASE",
  username: "AI_OFFICE_SURREALDB_USERNAME",
  password: "AI_OFFICE_SURREALDB_PASSWORD",
  tenantId: "AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID",
} as const;

export type AgentKnowledgeConfiguration =
  | { kind: "disabled" }
  | { kind: "misconfigured"; provider: "surrealdb" | "unknown" }
  | {
      kind: "surrealdb";
      connection: SurrealAgentKnowledgeConfig;
      tenantId: string;
    };

/** Host-only configuration; never include supplied values in diagnostics. */
export function resolveAgentKnowledgeConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  authoritativeTenantId?: string,
): AgentKnowledgeConfiguration {
  const provider = environment[agentKnowledgeEnvironment.provider];
  if (provider === undefined || provider === "" || provider === "none")
    return { kind: "disabled" };
  if (provider !== "surrealdb")
    return { kind: "misconfigured", provider: "unknown" };

  const endpoint = environment[agentKnowledgeEnvironment.endpoint];
  const namespace = environment[agentKnowledgeEnvironment.namespace];
  const database = environment[agentKnowledgeEnvironment.database];
  const username = environment[agentKnowledgeEnvironment.username];
  const password = environment[agentKnowledgeEnvironment.password];
  const tenantId =
    authoritativeTenantId ?? environment[agentKnowledgeEnvironment.tenantId];
  if (
    endpoint === undefined ||
    namespace === undefined ||
    database === undefined ||
    username === undefined ||
    password === undefined ||
    tenantId === undefined ||
    tenantId.length === 0 ||
    tenantId.length > 256 ||
    tenantId.trim() !== tenantId ||
    username.length === 0 ||
    password.length === 0 ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(namespace) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(database)
  )
    return { kind: "misconfigured", provider: "surrealdb" };

  try {
    const url = new URL(endpoint);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.hostname.length === 0 ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      endpoint.length > 2048 ||
      /\p{Cc}/u.test(endpoint) ||
      (url.protocol === "ws:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return { kind: "misconfigured", provider: "surrealdb" };
  } catch {
    return { kind: "misconfigured", provider: "surrealdb" };
  }
  return {
    kind: "surrealdb",
    connection: { endpoint, namespace, database, username, password },
    tenantId,
  };
}

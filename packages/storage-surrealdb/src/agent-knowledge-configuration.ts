import type { SurrealAgentKnowledgeConfig } from "./connect-agent-knowledge-store.ts";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  agentKnowledgeSourceEnvironmentVariable,
  runtimeHomeAgentKnowledgePath,
  runtimeHomeAgentKnowledgeSource,
} from "@ai-office/runtime-paths/agent-knowledge-location.ts";

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

const maximumConfigurationBytes = 8 * 1024;
const managedFields = new Set([
  "provider",
  "endpoint",
  "namespace",
  "database",
  "tenantId",
]);

function managedDocument(
  runtimeHome: string,
):
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "parsed"; value: unknown } {
  let descriptor: number;
  try {
    descriptor = openSync(
      runtimeHomeAgentKnowledgePath(runtimeHome),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size > maximumConfigurationBytes)
      return { state: "invalid" };
    const buffer = Buffer.alloc(maximumConfigurationBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > maximumConfigurationBytes) return { state: "invalid" };
    return {
      state: "parsed",
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        ),
      ) as unknown,
    };
  } catch {
    return { state: "invalid" };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Selects exactly one host source. A managed service never consults ambient
 * knowledge values, and a foreground host never opens the Runtime-home file.
 */
export function loadAgentKnowledgeConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly runtimeHome: string;
    readonly authoritativeTenantId?: string;
    readonly loadCredential: (name: string) => string | undefined;
  },
): AgentKnowledgeConfiguration {
  const source = environment[agentKnowledgeSourceEnvironmentVariable];
  if (source === undefined)
    return resolveAgentKnowledgeConfiguration(
      environment,
      options.authoritativeTenantId,
    );
  if (source !== runtimeHomeAgentKnowledgeSource)
    return { kind: "misconfigured", provider: "unknown" };

  const document = managedDocument(options.runtimeHome);
  if (document.state === "missing") return { kind: "disabled" };
  if (document.state === "invalid")
    return { kind: "misconfigured", provider: "unknown" };
  if (
    typeof document.value !== "object" ||
    document.value === null ||
    Array.isArray(document.value)
  )
    return { kind: "misconfigured", provider: "unknown" };
  const fields = document.value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !managedFields.has(key)))
    return { kind: "misconfigured", provider: "unknown" };
  if (fields.provider === "none")
    return Object.keys(fields).length === 1
      ? { kind: "disabled" }
      : { kind: "misconfigured", provider: "unknown" };
  if (fields.provider !== "surrealdb")
    return { kind: "misconfigured", provider: "unknown" };
  if (
    typeof fields.endpoint !== "string" ||
    typeof fields.namespace !== "string" ||
    typeof fields.database !== "string" ||
    (fields.tenantId !== undefined && typeof fields.tenantId !== "string") ||
    (options.authoritativeTenantId !== undefined &&
      fields.tenantId !== undefined)
  )
    return { kind: "misconfigured", provider: "surrealdb" };
  const username = options.loadCredential(agentKnowledgeEnvironment.username);
  const password = options.loadCredential(agentKnowledgeEnvironment.password);
  return resolveAgentKnowledgeConfiguration(
    {
      [agentKnowledgeEnvironment.provider]: "surrealdb",
      [agentKnowledgeEnvironment.endpoint]: fields.endpoint,
      [agentKnowledgeEnvironment.namespace]: fields.namespace,
      [agentKnowledgeEnvironment.database]: fields.database,
      [agentKnowledgeEnvironment.tenantId]: fields.tenantId as
        string | undefined,
      [agentKnowledgeEnvironment.username]: username,
      [agentKnowledgeEnvironment.password]: password,
    },
    options.authoritativeTenantId,
  );
}

export function isAgentKnowledgeTenantId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  );
}

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
    !isAgentKnowledgeTenantId(tenantId) ||
    username.length === 0 ||
    password.length === 0 ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(namespace) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(database)
  )
    return { kind: "misconfigured", provider: "surrealdb" };

  try {
    if (endpoint.length > 2048 || /[\p{Cc}?#]/u.test(endpoint))
      return { kind: "misconfigured", provider: "surrealdb" };
    const url = new URL(endpoint);
    const authority = /^wss?:\/\/([^/?#]*)/u.exec(endpoint)?.[1];
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.hostname.length === 0 ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      authority === undefined ||
      authority.includes("@") ||
      (url.protocol === "ws:" &&
        !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu.test(authority))
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

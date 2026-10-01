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

interface NonSecretSurrealFields {
  endpoint: string;
  namespace: string;
  database: string;
  tenantId: string;
}

function validNonSecretSurrealFields(fields: {
  endpoint: unknown;
  namespace: unknown;
  database: unknown;
  tenantId: unknown;
}): fields is NonSecretSurrealFields {
  const { endpoint, namespace, database, tenantId } = fields;
  if (
    typeof endpoint !== "string" ||
    typeof namespace !== "string" ||
    typeof database !== "string" ||
    typeof tenantId !== "string" ||
    !isAgentKnowledgeTenantId(tenantId) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(namespace) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(database)
  )
    return false;

  try {
    if (endpoint.length > 2048 || /[\p{Cc}?#]/u.test(endpoint)) return false;
    const url = new URL(endpoint);
    const authority = /^wss?:\/\/([^/?#]*)/u.exec(endpoint)?.[1];
    return (
      ["ws:", "wss:"].includes(url.protocol) &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      authority !== undefined &&
      !authority.includes("@") &&
      (url.protocol !== "ws:" ||
        /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu.test(authority))
    );
  } catch {
    return false;
  }
}

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
    // Both integrity checks and bounded reads use this opened descriptor. A
    // pathname replacement after open cannot substitute another document.
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      typeof process.getuid !== "function" ||
      status.uid !== process.getuid() ||
      (status.mode & 0o022) !== 0 ||
      status.size > maximumConfigurationBytes
    )
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
  const nonSecretFields = {
    endpoint: fields.endpoint,
    namespace: fields.namespace,
    database: fields.database,
    tenantId: options.authoritativeTenantId ?? fields.tenantId,
  };
  if (
    (options.authoritativeTenantId !== undefined &&
      fields.tenantId !== undefined) ||
    !validNonSecretSurrealFields(nonSecretFields)
  )
    return { kind: "misconfigured", provider: "surrealdb" };
  const username = options.loadCredential(agentKnowledgeEnvironment.username);
  const password = options.loadCredential(agentKnowledgeEnvironment.password);
  return resolveAgentKnowledgeConfiguration(
    {
      [agentKnowledgeEnvironment.provider]: "surrealdb",
      [agentKnowledgeEnvironment.endpoint]: nonSecretFields.endpoint,
      [agentKnowledgeEnvironment.namespace]: nonSecretFields.namespace,
      [agentKnowledgeEnvironment.database]: nonSecretFields.database,
      [agentKnowledgeEnvironment.tenantId]: nonSecretFields.tenantId,
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
  const nonSecretFields = {
    endpoint,
    namespace,
    database,
    tenantId:
      authoritativeTenantId ?? environment[agentKnowledgeEnvironment.tenantId],
  };
  if (
    !validNonSecretSurrealFields(nonSecretFields) ||
    username === undefined ||
    password === undefined ||
    username.length === 0 ||
    password.length === 0
  )
    return { kind: "misconfigured", provider: "surrealdb" };

  return {
    kind: "surrealdb",
    connection: {
      endpoint: nonSecretFields.endpoint,
      namespace: nonSecretFields.namespace,
      database: nonSecretFields.database,
      username,
      password,
    },
    tenantId: nonSecretFields.tenantId,
  };
}

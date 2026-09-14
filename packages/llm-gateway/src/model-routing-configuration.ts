import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  maximumOutputTokens,
  modelTokenPattern,
  reasoningEffortPattern,
} from "@ai-office/domain/agent/agent-run-model.ts";
import { isSensitiveFieldKey } from "@ai-office/domain/capability/sensitive-fields.ts";
import type {
  AgentModelOverride,
  ConcreteModel,
  ModelProfile,
  ModelRoutingIssue,
  ModelRoutingIssueCode,
  ModelRoutingState,
} from "@ai-office/application/model-routing/model-routing.ts";
import type { ModelProviderCatalog } from "@ai-office/application/ports/model-provider-catalog.port.ts";
import {
  defaultModelProviderDescriptors,
  ModelProviderConfigurationError,
  nonEmpty,
  parseCanonicalModelRef,
  parseModelRef,
  type ModelProviderDescriptor,
  type ModelProviderEnvironment,
} from "./model-ref.ts";

/**
 * Machine-local, environment-selected configuration read once by the Runtime
 * composition root. It is never written to SQLite, portable snapshots, office
 * manifests, generated Markdown or `.ai-office/project.json`.
 */
export const modelRoutingEnvironment = {
  file: "AI_OFFICE_MODEL_ROUTING_FILE",
  legacyModel: "AI_OFFICE_LLM_MODEL",
  legacyProvider: "AI_OFFICE_LLM_PROVIDER",
} as const;

const maximumConfigurationBytes = 256 * 1024;
const maximumEntries = 1_000;

export interface LoadModelRoutingOptions {
  readonly descriptors?: readonly ModelProviderDescriptor[];
  readonly readFile?: (path: string) => string;
}

class Issues {
  readonly items: ModelRoutingIssue[] = [];
  add(code: ModelRoutingIssueCode, subject: string, message: string): void {
    this.items.push({ code, subject, message });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
  issues: Issues,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    issues.add(
      "CONFIGURATION_INVALID",
      subject === "" ? key : `${subject}.${key}`,
      isSensitiveFieldKey(key)
        ? "Credentials are not accepted in model routing configuration; providers read them from the Runtime host environment."
        : `Unknown model routing key "${key}".`,
    );
  }
}

/** Absolute or `~/` paths only: the persistent host never uses its own cwd. */
function routingFilePath(
  value: string,
  home: string | undefined,
): string | null {
  if (value.length > 4096 || /\p{Cc}/u.test(value)) return null;
  if (value.startsWith("~/"))
    return home !== undefined && isAbsolute(home)
      ? resolve(`${home}/${value.slice(2)}`)
      : null;
  return isAbsolute(value) ? resolve(value) : null;
}

function concreteModel(
  value: unknown,
  subject: string,
  supported: ReadonlySet<string>,
  issues: Issues,
): ConcreteModel | null {
  // A malformed value is never echoed: it may be a credential pasted into the
  // wrong field.
  const malformed = () =>
    issues.add(
      "MODEL_REF_MALFORMED",
      subject,
      `${subject} must be a canonical <provider>:<model> reference.`,
    );
  if (typeof value !== "string") {
    malformed();
    return null;
  }
  let parsed;
  try {
    parsed = parseCanonicalModelRef(value);
  } catch (error) {
    if (!(error instanceof ModelProviderConfigurationError)) throw error;
    malformed();
    return null;
  }
  if (!supported.has(parsed.providerId)) {
    issues.add(
      "PROVIDER_UNSUPPORTED",
      subject,
      `Unsupported LLM provider "${parsed.providerId}" in ${subject}. Supported providers: ${[...supported].sort().join(", ")}.`,
    );
    return null;
  }
  return {
    modelRef: parsed.modelRef,
    providerId: parsed.providerId,
    model: parsed.model,
  };
}

function entries(
  value: unknown,
  subject: string,
  issues: Issues,
): [string, unknown][] {
  if (value === undefined || value === null) return [];
  const map = record(value);
  if (map === null) {
    issues.add("CONFIGURATION_INVALID", subject, `${subject} must be a map.`);
    return [];
  }
  const result = Object.entries(map);
  if (result.length > maximumEntries) {
    issues.add(
      "CONFIGURATION_INVALID",
      subject,
      `${subject} has more than ${maximumEntries} entries.`,
    );
    return [];
  }
  return result;
}

function validToken(value: string): boolean {
  return modelTokenPattern.test(value);
}

function validPolicyName(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 200 &&
    !/\p{Cc}/u.test(value)
  );
}

function parseDocument(
  document: unknown,
  supported: ReadonlySet<string>,
  issues: Issues,
): {
  profiles: Map<string, ModelProfile>;
  policies: Map<string, string>;
  defaultProfile: string | null;
  agentOverrides: Map<string, AgentModelOverride>;
} {
  const profiles = new Map<string, ModelProfile>();
  const policies = new Map<string, string>();
  const agentOverrides = new Map<string, AgentModelOverride>();
  let defaultProfile: string | null = null;
  const root = record(document);
  if (root === null) {
    issues.add(
      "CONFIGURATION_INVALID",
      "(root)",
      "Model routing configuration must be a map.",
    );
    return { profiles, policies, defaultProfile, agentOverrides };
  }
  checkKeys(
    root,
    ["schema_version", "profiles", "policies", "default_profile", "agents"],
    "",
    issues,
  );
  if (root.schema_version !== 1)
    issues.add(
      "CONFIGURATION_INVALID",
      "schema_version",
      "schema_version must be 1.",
    );

  const pendingProfiles = entries(root.profiles, "profiles", issues);
  for (const [key, raw] of pendingProfiles) {
    const subject = `profiles.${key}`;
    if (!validToken(key)) {
      issues.add(
        "CONFIGURATION_INVALID",
        subject,
        "Profile keys use letters, digits, '.', '_' or '-' (at most 64 characters).",
      );
      continue;
    }
    const value = record(raw);
    if (value === null) {
      issues.add("CONFIGURATION_INVALID", subject, `${subject} must be a map.`);
      continue;
    }
    checkKeys(
      value,
      ["model", "reasoning_effort", "max_output_tokens"],
      subject,
      issues,
    );
    const model = concreteModel(
      value.model,
      `${subject}.model`,
      supported,
      issues,
    );
    let reasoningEffort: string | null = null;
    if (value.reasoning_effort !== undefined) {
      if (
        typeof value.reasoning_effort === "string" &&
        reasoningEffortPattern.test(value.reasoning_effort)
      )
        reasoningEffort = value.reasoning_effort;
      else {
        issues.add(
          "EXECUTION_PARAMETER_INVALID",
          `${subject}.reasoning_effort`,
          "reasoning_effort must be a lowercase token such as low, medium or high.",
        );
        continue;
      }
    }
    let maxOutputTokens: number | null = null;
    if (value.max_output_tokens !== undefined) {
      if (
        typeof value.max_output_tokens === "number" &&
        Number.isSafeInteger(value.max_output_tokens) &&
        value.max_output_tokens >= 1 &&
        value.max_output_tokens <= maximumOutputTokens
      )
        maxOutputTokens = value.max_output_tokens;
      else {
        issues.add(
          "EXECUTION_PARAMETER_INVALID",
          `${subject}.max_output_tokens`,
          `max_output_tokens must be an integer from 1 to ${maximumOutputTokens}.`,
        );
        continue;
      }
    }
    if (model === null) continue;
    profiles.set(
      key,
      Object.freeze({ key, ...model, reasoningEffort, maxOutputTokens }),
    );
  }
  // A malformed profile is still "defined" for cross-reference purposes, so a
  // single bad model ref reports once instead of cascading.
  const declaredProfiles = new Set(pendingProfiles.map(([key]) => key));

  for (const [policy, profile] of entries(root.policies, "policies", issues)) {
    const subject = `policies.${policy}`;
    if (!validPolicyName(policy) || typeof profile !== "string") {
      issues.add(
        "CONFIGURATION_INVALID",
        subject,
        "Policy mappings map a model policy name to a profile key.",
      );
      continue;
    }
    if (!declaredProfiles.has(profile)) {
      issues.add(
        "PROFILE_UNDEFINED",
        subject,
        `Model policy "${policy}" maps to undefined profile "${profile}".`,
      );
      continue;
    }
    policies.set(policy, profile);
  }

  if (root.default_profile !== undefined && root.default_profile !== null) {
    if (
      typeof root.default_profile !== "string" ||
      !declaredProfiles.has(root.default_profile)
    )
      issues.add(
        "DEFAULT_UNRESOLVED",
        "default_profile",
        "default_profile must name a defined profile.",
      );
    else defaultProfile = root.default_profile;
  }

  for (const [agent, raw] of entries(root.agents, "agents", issues)) {
    const subject = `agents.${agent}`;
    const value = record(raw);
    if (agent.trim() === "" || agent.length > 200 || value === null) {
      issues.add(
        "CONFIGURATION_INVALID",
        subject,
        "Agent overrides map a synchronized agent name to a profile or model.",
      );
      continue;
    }
    checkKeys(value, ["profile", "model"], subject, issues);
    if ((value.profile === undefined) === (value.model === undefined)) {
      issues.add(
        "AGENT_OVERRIDE_UNAVAILABLE",
        subject,
        `${subject} must set exactly one of profile or model.`,
      );
      continue;
    }
    if (value.profile !== undefined) {
      if (
        typeof value.profile !== "string" ||
        !declaredProfiles.has(value.profile)
      ) {
        issues.add(
          "AGENT_OVERRIDE_UNAVAILABLE",
          `${subject}.profile`,
          `Agent override ${agent} names an undefined profile.`,
        );
        continue;
      }
      agentOverrides.set(
        agent,
        Object.freeze({ kind: "profile", profile: value.profile }),
      );
      continue;
    }
    const model = concreteModel(
      value.model,
      `${subject}.model`,
      supported,
      issues,
    );
    if (model !== null)
      agentOverrides.set(agent, Object.freeze({ kind: "model", ...model }));
  }
  return { profiles, policies, defaultProfile, agentOverrides };
}

/**
 * Loads host model routing once. Unset configuration is `unconfigured`; any
 * explicit invalid value makes the whole state `misconfigured`, so scheduling
 * fails closed instead of silently falling back to a lower precedence rule.
 */
export function loadModelRoutingState(
  environment: ModelProviderEnvironment,
  options: LoadModelRoutingOptions = {},
): ModelRoutingState {
  const descriptors = options.descriptors ?? defaultModelProviderDescriptors;
  const supported = new Set(descriptors.map((value) => value.providerId));
  const issues = new Issues();
  const warnings = new Issues();

  const fileSetting = nonEmpty(environment[modelRoutingEnvironment.file]);
  const legacySetting = nonEmpty(
    environment[modelRoutingEnvironment.legacyModel],
  );
  const sources = Object.freeze({
    file: fileSetting !== undefined,
    legacyEnvironment: legacySetting !== undefined,
  });

  let document: ReturnType<typeof parseDocument> | null = null;
  if (fileSetting !== undefined) {
    const path = routingFilePath(fileSetting, environment.HOME);
    if (path === null)
      // The configured value is a machine-local path and is never echoed.
      issues.add(
        "CONFIGURATION_INVALID",
        modelRoutingEnvironment.file,
        `${modelRoutingEnvironment.file} must be an absolute path or ~/path.`,
      );
    else {
      let text: string | null = null;
      try {
        text = (options.readFile ?? ((file) => readFileSync(file, "utf8")))(
          path,
        );
      } catch {
        issues.add(
          "CONFIGURATION_UNREADABLE",
          modelRoutingEnvironment.file,
          "The model routing file cannot be read.",
        );
      }
      if (text !== null && Buffer.byteLength(text) > maximumConfigurationBytes)
        issues.add(
          "CONFIGURATION_INVALID",
          modelRoutingEnvironment.file,
          `The model routing file exceeds ${maximumConfigurationBytes} bytes.`,
        );
      else if (text !== null) {
        let parsed: unknown;
        let readable = true;
        try {
          parsed = Bun.YAML.parse(text);
        } catch {
          readable = false;
          issues.add(
            "CONFIGURATION_INVALID",
            modelRoutingEnvironment.file,
            "The model routing file is not valid YAML or JSON.",
          );
        }
        if (readable) document = parseDocument(parsed, supported, issues);
      }
    }
  }

  let legacyDefault: ConcreteModel | null = null;
  if (legacySetting !== undefined) {
    try {
      const parsed = parseModelRef(
        legacySetting,
        environment[modelRoutingEnvironment.legacyProvider],
      );
      if (parsed.compatibilityConfiguration)
        warnings.add(
          "LEGACY_PROVIDER_FORM_DEPRECATED",
          modelRoutingEnvironment.legacyModel,
          "A bare AI_OFFICE_LLM_MODEL with AI_OFFICE_LLM_PROVIDER is deprecated; use <provider>:<model>.",
        );
      legacyDefault = concreteModel(
        parsed.modelRef,
        modelRoutingEnvironment.legacyModel,
        supported,
        issues,
      );
    } catch (error) {
      if (!(error instanceof ModelProviderConfigurationError)) throw error;
      issues.add(
        "MODEL_REF_MALFORMED",
        modelRoutingEnvironment.legacyModel,
        "AI_OFFICE_LLM_MODEL must be <provider>:<model> (or a bare model with AI_OFFICE_LLM_PROVIDER).",
      );
    }
  }

  if (issues.items.length > 0)
    return Object.freeze({
      status: "misconfigured",
      sources,
      issues: Object.freeze(issues.items),
      warnings: Object.freeze(warnings.items),
    });
  if (!sources.file && !sources.legacyEnvironment)
    return Object.freeze({
      status: "unconfigured",
      sources,
      warnings: Object.freeze(warnings.items),
    });
  return Object.freeze({
    status: "configured",
    sources,
    configuration: Object.freeze({
      profiles: document?.profiles ?? new Map(),
      policies: document?.policies ?? new Map(),
      defaultProfile: document?.defaultProfile ?? null,
      agentOverrides: document?.agentOverrides ?? new Map(),
      legacyDefault,
    }),
    warnings: Object.freeze(warnings.items),
  });
}

/** Reports credential presence by variable name; values are never returned. */
export class EnvironmentModelProviderCatalog implements ModelProviderCatalog {
  constructor(
    private readonly environment: ModelProviderEnvironment,
    private readonly descriptors: readonly ModelProviderDescriptor[] = defaultModelProviderDescriptors,
  ) {}

  supportedProviders(): readonly string[] {
    return this.descriptors.map((value) => value.providerId).sort();
  }

  missingCredentials(providerId: string): readonly string[] | null {
    const descriptor = this.descriptors.find(
      (value) => value.providerId === providerId,
    );
    if (descriptor === undefined) return null;
    return descriptor.requiredEnvironmentVariables.filter(
      (name) => nonEmpty(this.environment[name]) === undefined,
    );
  }
}

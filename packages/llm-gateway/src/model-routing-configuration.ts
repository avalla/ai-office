import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  maximumOutputTokens,
  modelTokenPattern,
  reasoningEffortPattern,
} from "@ai-office/domain/agent/agent-run-model.ts";
import { isSensitiveFieldKey } from "@ai-office/domain/capability/sensitive-fields.ts";
import {
  FrozenMap,
  type AgentModelOverride,
  type ConcreteModel,
  type ModelProfile,
  type ModelRoutingIssue,
  type ModelRoutingIssueCode,
  type ModelRoutingSources,
  type ModelRoutingState,
} from "@ai-office/application/model-routing/model-routing.ts";
import type { ModelProviderCatalog } from "@ai-office/application/ports/model-provider-catalog.port.ts";
import {
  modelRoutingSourceEnvironmentVariable,
  runtimeHomeModelRoutingFileName,
  runtimeHomeModelRoutingPath,
  runtimeHomeModelRoutingSource,
} from "@ai-office/runtime-paths/model-routing-location.ts";
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
 * Machine-local configuration read once by the Runtime composition root. It is
 * never written to SQLite, portable snapshots, office manifests, generated
 * Markdown or `.ai-office/project.json`.
 *
 * Sources, in order:
 *
 * - managed service (`AI_OFFICE_MODEL_ROUTING_SOURCE=runtime_home`, written by
 *   `service install`): only `<AI_OFFICE_HOME>/model-routing.yaml`; ambient
 *   `AI_OFFICE_MODEL_ROUTING_FILE` and `AI_OFFICE_LLM_MODEL` are ignored;
 * - foreground: `AI_OFFICE_MODEL_ROUTING_FILE` when set, otherwise
 *   `<AI_OFFICE_HOME>/model-routing.yaml` when it exists, plus the legacy
 *   `AI_OFFICE_LLM_MODEL` default.
 */
export const modelRoutingEnvironment = {
  file: "AI_OFFICE_MODEL_ROUTING_FILE",
  legacyModel: "AI_OFFICE_LLM_MODEL",
  legacyProvider: "AI_OFFICE_LLM_PROVIDER",
  source: modelRoutingSourceEnvironmentVariable,
} as const;

const maximumConfigurationBytes = 256 * 1024;
const maximumEntries = 1_000;

export interface LoadModelRoutingOptions {
  readonly descriptors?: readonly ModelProviderDescriptor[];
  readonly readFile?: (path: string) => string;
  /** The Runtime home whose `model-routing.yaml` is the canonical source. */
  readonly runtimeHome?: string;
}

class Issues {
  readonly items: ModelRoutingIssue[] = [];
  add(code: ModelRoutingIssueCode, subject: string, message: string): void {
    this.items.push(Object.freeze({ code, subject, message }));
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

/** Runtime project ids are opaque printable identifiers, never paths. */
function validProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function parseAgentOverrides(
  value: unknown,
  prefix: string,
  supported: ReadonlySet<string>,
  declaredProfiles: ReadonlySet<string>,
  issues: Issues,
): FrozenMap<string, AgentModelOverride> {
  const overrides = new Map<string, AgentModelOverride>();
  for (const [agent, raw] of entries(value, prefix, issues)) {
    const subject = `${prefix}.${agent}`;
    const override = record(raw);
    if (agent.trim() === "" || agent.length > 200 || override === null) {
      issues.add(
        "CONFIGURATION_INVALID",
        subject,
        "Agent overrides map a synchronized agent name to a profile or model.",
      );
      continue;
    }
    checkKeys(override, ["profile", "model"], subject, issues);
    if ((override.profile === undefined) === (override.model === undefined)) {
      issues.add(
        "AGENT_OVERRIDE_UNAVAILABLE",
        subject,
        `${subject} must set exactly one of profile or model.`,
      );
      continue;
    }
    if (override.profile !== undefined) {
      if (
        typeof override.profile !== "string" ||
        !declaredProfiles.has(override.profile)
      ) {
        issues.add(
          "AGENT_OVERRIDE_UNAVAILABLE",
          `${subject}.profile`,
          `Agent override ${subject} names an undefined profile.`,
        );
        continue;
      }
      overrides.set(
        agent,
        Object.freeze({ kind: "profile", profile: override.profile }),
      );
      continue;
    }
    const model = concreteModel(
      override.model,
      `${subject}.model`,
      supported,
      issues,
    );
    if (model !== null)
      overrides.set(agent, Object.freeze({ kind: "model", ...model }));
  }
  return new FrozenMap(overrides);
}

interface ParsedDocument {
  profiles: FrozenMap<string, ModelProfile>;
  policies: FrozenMap<string, string>;
  defaultProfile: string | null;
  agentOverrides: FrozenMap<string, AgentModelOverride>;
  projectAgentOverrides: FrozenMap<
    string,
    FrozenMap<string, AgentModelOverride>
  >;
}

function parseDocument(
  document: unknown,
  supported: ReadonlySet<string>,
  issues: Issues,
): ParsedDocument {
  const profiles = new Map<string, ModelProfile>();
  const policies = new Map<string, string>();
  let defaultProfile: string | null = null;
  const root = record(document);
  if (root === null) {
    issues.add(
      "CONFIGURATION_INVALID",
      "(root)",
      "Model routing configuration must be a map.",
    );
    return {
      profiles: new FrozenMap(),
      policies: new FrozenMap(),
      defaultProfile,
      agentOverrides: new FrozenMap(),
      projectAgentOverrides: new FrozenMap(),
    };
  }
  checkKeys(
    root,
    [
      "schema_version",
      "profiles",
      "policies",
      "default_profile",
      "agents",
      "projects",
    ],
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

  const agentOverrides = parseAgentOverrides(
    root.agents,
    "agents",
    supported,
    declaredProfiles,
    issues,
  );

  const projectAgentOverrides = new Map<
    string,
    FrozenMap<string, AgentModelOverride>
  >();
  for (const [projectId, raw] of entries(root.projects, "projects", issues)) {
    const valid = validProjectId(projectId);
    // An invalid key may be a repository path; it is never echoed.
    const subject = `projects.${valid ? projectId : "(invalid project id)"}`;
    const project = record(raw);
    if (!valid || project === null) {
      issues.add(
        "CONFIGURATION_INVALID",
        subject,
        "Project overrides map a Runtime project id (see project:list) to an agents map.",
      );
      continue;
    }
    checkKeys(project, ["agents"], subject, issues);
    projectAgentOverrides.set(
      projectId,
      parseAgentOverrides(
        project.agents,
        `${subject}.agents`,
        supported,
        declaredProfiles,
        issues,
      ),
    );
  }
  return {
    profiles: new FrozenMap(profiles),
    policies: new FrozenMap(policies),
    defaultProfile,
    agentOverrides,
    projectAgentOverrides: new FrozenMap(projectAgentOverrides),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Loads host model routing once. Unset configuration is `unconfigured`; any
 * explicit invalid value makes the whole state `misconfigured`, so scheduling
 * fails closed instead of silently falling back to a lower precedence rule.
 * The returned state is deeply immutable at runtime.
 */
export function loadModelRoutingState(
  environment: ModelProviderEnvironment,
  options: LoadModelRoutingOptions = {},
): ModelRoutingState {
  const descriptors = options.descriptors ?? defaultModelProviderDescriptors;
  const supported = new Set(descriptors.map((value) => value.providerId));
  const issues = new Issues();
  const warnings = new Issues();
  const read =
    options.readFile ?? ((file: string) => readFileSync(file, "utf8"));

  const sourceSetting = nonEmpty(environment[modelRoutingEnvironment.source]);
  const managed = sourceSetting === runtimeHomeModelRoutingSource;
  if (sourceSetting !== undefined && !managed)
    issues.add(
      "CONFIGURATION_INVALID",
      modelRoutingEnvironment.source,
      `${modelRoutingEnvironment.source} accepts only ${runtimeHomeModelRoutingSource}.`,
    );
  const fileSetting = nonEmpty(environment[modelRoutingEnvironment.file]);
  const legacyAmbient = nonEmpty(
    environment[modelRoutingEnvironment.legacyModel],
  );
  if (managed)
    for (const [name, value] of [
      [modelRoutingEnvironment.file, fileSetting],
      [modelRoutingEnvironment.legacyModel, legacyAmbient],
    ] as const)
      if (value !== undefined)
        warnings.add(
          "MANAGED_ENVIRONMENT_IGNORED",
          name,
          `${name} is ignored by the managed Runtime service, which reads model routing only from ${runtimeHomeModelRoutingFileName} in AI_OFFICE_HOME.`,
        );
  const legacySetting = managed ? undefined : legacyAmbient;

  // The file to read: the explicit foreground override, else the Runtime-home
  // file. A missing Runtime-home file simply means no routing file.
  let fileOrigin: ModelRoutingSources["fileOrigin"] = null;
  let text: string | null = null;
  if (!managed && fileSetting !== undefined) {
    fileOrigin = "environment";
    const path = routingFilePath(fileSetting, environment.HOME);
    if (path === null)
      // The configured value is a machine-local path and is never echoed.
      issues.add(
        "CONFIGURATION_INVALID",
        modelRoutingEnvironment.file,
        `${modelRoutingEnvironment.file} must be an absolute path or ~/path.`,
      );
    else
      try {
        text = read(path);
      } catch {
        issues.add(
          "CONFIGURATION_UNREADABLE",
          modelRoutingEnvironment.file,
          "The model routing file cannot be read.",
        );
      }
  } else if (options.runtimeHome !== undefined) {
    try {
      text = read(runtimeHomeModelRoutingPath(options.runtimeHome));
      fileOrigin = "runtime_home";
    } catch (error) {
      if (!isMissingFile(error)) {
        fileOrigin = "runtime_home";
        issues.add(
          "CONFIGURATION_UNREADABLE",
          runtimeHomeModelRoutingFileName,
          `The Runtime home ${runtimeHomeModelRoutingFileName} cannot be read.`,
        );
      }
    }
  } else if (managed)
    issues.add(
      "CONFIGURATION_UNREADABLE",
      runtimeHomeModelRoutingFileName,
      "The managed Runtime has no Runtime home to read model routing from.",
    );

  let document: ParsedDocument | null = null;
  const subject =
    fileOrigin === "environment"
      ? modelRoutingEnvironment.file
      : runtimeHomeModelRoutingFileName;
  if (text !== null && Buffer.byteLength(text) > maximumConfigurationBytes)
    issues.add(
      "CONFIGURATION_INVALID",
      subject,
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
        subject,
        "The model routing file is not valid YAML or JSON.",
      );
    }
    if (readable) document = parseDocument(parsed, supported, issues);
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
      const model = concreteModel(
        parsed.modelRef,
        modelRoutingEnvironment.legacyModel,
        supported,
        issues,
      );
      legacyDefault = model === null ? null : Object.freeze(model);
    } catch (error) {
      if (!(error instanceof ModelProviderConfigurationError)) throw error;
      issues.add(
        "MODEL_REF_MALFORMED",
        modelRoutingEnvironment.legacyModel,
        "AI_OFFICE_LLM_MODEL must be <provider>:<model> (or a bare model with AI_OFFICE_LLM_PROVIDER).",
      );
    }
  }

  const sources: ModelRoutingSources = Object.freeze({
    file: fileOrigin !== null,
    fileOrigin,
    legacyEnvironment: legacySetting !== undefined,
    managed,
  });
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
      profiles: document?.profiles ?? new FrozenMap(),
      policies: document?.policies ?? new FrozenMap(),
      defaultProfile: document?.defaultProfile ?? null,
      agentOverrides: document?.agentOverrides ?? new FrozenMap(),
      projectAgentOverrides: document?.projectAgentOverrides ?? new FrozenMap(),
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

  supportsGatewayExecution(providerId: string): boolean {
    return this.descriptors.some(
      (value) =>
        value.providerId === providerId && value.gatewayExecution !== undefined,
    );
  }
}

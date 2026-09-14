import type {
  AgentRunModelRouting,
  AgentRunModelSelection,
} from "@ai-office/domain/agent/agent-run-model.ts";

/** A canonical `<provider>:<model>` reference already validated by the gateway. */
export interface ConcreteModel {
  readonly modelRef: string;
  readonly providerId: string;
  readonly model: string;
}

/** Deployment configuration that satisfies a semantic model policy. */
export interface ModelProfile extends ConcreteModel {
  readonly key: string;
  readonly reasoningEffort: string | null;
  readonly maxOutputTokens: number | null;
}

/** A host-local override keyed by synchronized agent name. */
export type AgentModelOverride =
  | { readonly kind: "profile"; readonly profile: string }
  | ({ readonly kind: "model" } & ConcreteModel);

export interface ModelRoutingConfiguration {
  readonly profiles: ReadonlyMap<string, ModelProfile>;
  /** Explicit policy -> profile mappings; a policy may also name a profile directly. */
  readonly policies: ReadonlyMap<string, string>;
  readonly defaultProfile: string | null;
  readonly agentOverrides: ReadonlyMap<string, AgentModelOverride>;
  /** `AI_OFFICE_LLM_MODEL`, the lowest-precedence compatibility default. */
  readonly legacyDefault: ConcreteModel | null;
}

export type ModelRoutingIssueCode =
  | "CONFIGURATION_UNREADABLE"
  | "CONFIGURATION_INVALID"
  | "MODEL_REF_MALFORMED"
  | "PROVIDER_UNSUPPORTED"
  | "PROFILE_UNDEFINED"
  | "EXECUTION_PARAMETER_INVALID"
  | "DEFAULT_UNRESOLVED"
  | "AGENT_OVERRIDE_UNAVAILABLE"
  | "POLICY_UNDEFINED"
  | "POLICY_UNRESOLVED"
  | "PROVIDER_CREDENTIALS_MISSING"
  | "PRICING_MISSING"
  | "AGENT_OVERRIDE_UNKNOWN_AGENT"
  | "LEGACY_PROVIDER_FORM_DEPRECATED";

/** Diagnostic text names configuration keys and model refs, never secret values or host paths. */
export interface ModelRoutingIssue {
  readonly code: ModelRoutingIssueCode;
  readonly subject: string;
  readonly message: string;
}

export interface ModelRoutingSources {
  /** A routing file was configured through `AI_OFFICE_MODEL_ROUTING_FILE`. */
  readonly file: boolean;
  /** `AI_OFFICE_LLM_MODEL` was set. */
  readonly legacyEnvironment: boolean;
}

/**
 * Host model routing, read once by the Runtime composition root and immutable
 * for the host's lifetime. Nothing here is written to portable project state.
 */
export type ModelRoutingState =
  | {
      readonly status: "unconfigured";
      readonly sources: ModelRoutingSources;
      readonly warnings: readonly ModelRoutingIssue[];
    }
  | {
      readonly status: "configured";
      readonly sources: ModelRoutingSources;
      readonly configuration: ModelRoutingConfiguration;
      readonly warnings: readonly ModelRoutingIssue[];
    }
  | {
      readonly status: "misconfigured";
      readonly sources: ModelRoutingSources;
      readonly issues: readonly ModelRoutingIssue[];
      readonly warnings: readonly ModelRoutingIssue[];
    };

export const unconfiguredModelRouting: ModelRoutingState = Object.freeze({
  status: "unconfigured",
  sources: Object.freeze({ file: false, legacyEnvironment: false }),
  warnings: Object.freeze([]),
});

export type ModelRoutingErrorCode =
  | "MODEL_ROUTING_MISCONFIGURED"
  | "MODEL_POLICY_UNRESOLVED"
  | "MODEL_PROFILE_UNDEFINED";

export class ModelRoutingError extends Error {
  constructor(
    readonly code: ModelRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export interface AgentModelSubject {
  readonly agentName: string;
  readonly modelPolicy: string;
}

function fromProfile(
  configuration: ModelRoutingConfiguration,
  key: string,
  subject: AgentModelSubject,
  source: AgentRunModelSelection["source"],
): AgentRunModelSelection {
  const profile = configuration.profiles.get(key);
  if (profile === undefined)
    throw new ModelRoutingError(
      "MODEL_PROFILE_UNDEFINED",
      `Model profile "${key}" required by agent ${subject.agentName} is not defined. No run was scheduled.`,
    );
  return {
    policy: subject.modelPolicy,
    profile: profile.key,
    modelRef: profile.modelRef,
    providerId: profile.providerId,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    maxOutputTokens: profile.maxOutputTokens,
    source,
  };
}

function concrete(
  model: ConcreteModel,
  subject: AgentModelSubject,
  source: AgentRunModelSelection["source"],
): AgentRunModelSelection {
  return {
    policy: subject.modelPolicy,
    profile: null,
    modelRef: model.modelRef,
    providerId: model.providerId,
    model: model.model,
    reasoningEffort: null,
    maxOutputTokens: null,
    source,
  };
}

/**
 * Deterministic precedence, evaluated once at scheduling:
 *
 * 1. host agent override (profile or concrete model);
 * 2. the role's `modelPolicy` mapped to a profile;
 * 3. the configured default profile;
 * 4. legacy `AI_OFFICE_LLM_MODEL`.
 *
 * Invalid explicit configuration never falls through to a lower rule.
 */
export function resolveAgentRunModel(
  state: ModelRoutingState,
  subject: AgentModelSubject,
): AgentRunModelRouting {
  if (state.status === "unconfigured") return { status: "unrouted" };
  if (state.status === "misconfigured")
    throw new ModelRoutingError(
      "MODEL_ROUTING_MISCONFIGURED",
      "Model routing configuration is invalid; run model:check. No run was scheduled.",
    );
  const configuration = state.configuration;
  const override = configuration.agentOverrides.get(subject.agentName);
  if (override !== undefined)
    return {
      status: "resolved",
      selection:
        override.kind === "profile"
          ? fromProfile(
              configuration,
              override.profile,
              subject,
              "agent_override",
            )
          : concrete(override, subject, "agent_override"),
    };
  const mapped =
    configuration.policies.get(subject.modelPolicy) ??
    (configuration.profiles.has(subject.modelPolicy)
      ? subject.modelPolicy
      : undefined);
  if (mapped !== undefined)
    return {
      status: "resolved",
      selection: fromProfile(configuration, mapped, subject, "role_policy"),
    };
  if (configuration.defaultProfile !== null)
    return {
      status: "resolved",
      selection: fromProfile(
        configuration,
        configuration.defaultProfile,
        subject,
        "default",
      ),
    };
  if (configuration.legacyDefault !== null)
    return {
      status: "resolved",
      selection: concrete(
        configuration.legacyDefault,
        subject,
        "legacy_default",
      ),
    };
  throw new ModelRoutingError(
    "MODEL_POLICY_UNRESOLVED",
    `Model policy "${subject.modelPolicy}" of agent ${subject.agentName} has no model profile and no default is configured. No run was scheduled.`,
  );
}

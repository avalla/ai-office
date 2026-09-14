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

/**
 * A host-local override keyed by synchronized agent name. The name alone does
 * not identify an Agent entity: in the host-global `agents` section it applies
 * to every project's agent with that name; under `projects.<project-id>` it
 * applies only within that project.
 */
export type AgentModelOverride =
  | { readonly kind: "profile"; readonly profile: string }
  | ({ readonly kind: "model" } & ConcreteModel);

/**
 * A read-only map whose entries cannot be changed at runtime. `ReadonlyMap`
 * is only a type: a plain `Map` behind it can still be mutated by any code that
 * holds it, and `Object.freeze` does not freeze a Map's entries. The backing
 * map is private and never handed out, including through `forEach`.
 */
export class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]> = []) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }
  get size(): number {
    return this.#entries.size;
  }
  get(key: K): V | undefined {
    return this.#entries.get(key);
  }
  has(key: K): boolean {
    return this.#entries.has(key);
  }
  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries)
      callback.call(thisArg, value, key, this);
  }
  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
  keys(): MapIterator<K> {
    return this.#entries.keys();
  }
  values(): MapIterator<V> {
    return this.#entries.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
}

export interface ModelRoutingConfiguration {
  readonly profiles: ReadonlyMap<string, ModelProfile>;
  /** Explicit policy -> profile mappings; a policy may also name a profile directly. */
  readonly policies: ReadonlyMap<string, string>;
  readonly defaultProfile: string | null;
  /** Host-global overrides: every project's agent with this name. */
  readonly agentOverrides: ReadonlyMap<string, AgentModelOverride>;
  /** Project id -> agent name -> override, applied only inside that project. */
  readonly projectAgentOverrides: ReadonlyMap<
    string,
    ReadonlyMap<string, AgentModelOverride>
  >;
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
  | "PROJECT_OVERRIDE_UNKNOWN_PROJECT"
  | "MANAGED_ENVIRONMENT_IGNORED"
  | "LEGACY_PROVIDER_FORM_DEPRECATED";

/** Diagnostic text names configuration keys and model refs, never secret values or host paths. */
export interface ModelRoutingIssue {
  readonly code: ModelRoutingIssueCode;
  readonly subject: string;
  readonly message: string;
}

export interface ModelRoutingSources {
  /** A routing file was read. */
  readonly file: boolean;
  /**
   * `environment`: the explicit `AI_OFFICE_MODEL_ROUTING_FILE` override;
   * `runtime_home`: `<AI_OFFICE_HOME>/model-routing.yaml`.
   */
  readonly fileOrigin: "environment" | "runtime_home" | null;
  /** `AI_OFFICE_LLM_MODEL` was used as the legacy default. */
  readonly legacyEnvironment: boolean;
  /**
   * The Runtime runs as a managed service and reads routing only from its
   * Runtime home, ignoring ambient routing variables.
   */
  readonly managed: boolean;
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
  sources: Object.freeze({
    file: false,
    fileOrigin: null,
    legacyEnvironment: false,
    managed: false,
  }),
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
  /** The Runtime project that owns the agent; scopes project overrides. */
  readonly projectId: string;
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

function fromOverride(
  configuration: ModelRoutingConfiguration,
  override: AgentModelOverride,
  subject: AgentModelSubject,
  source: "project_agent_override" | "agent_override",
): AgentRunModelRouting {
  return {
    status: "resolved",
    selection:
      override.kind === "profile"
        ? fromProfile(configuration, override.profile, subject, source)
        : concrete(override, subject, source),
  };
}

/**
 * Deterministic precedence, evaluated once at scheduling:
 *
 * 1. project agent override (`projects.<project-id>.agents.<name>`);
 * 2. host-global agent override (`agents.<name>`, every project);
 * 3. the role's `modelPolicy` mapped to a profile;
 * 4. the configured default profile;
 * 5. legacy `AI_OFFICE_LLM_MODEL`.
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
  const projectOverride = configuration.projectAgentOverrides
    .get(subject.projectId)
    ?.get(subject.agentName);
  if (projectOverride !== undefined)
    return fromOverride(
      configuration,
      projectOverride,
      subject,
      "project_agent_override",
    );
  const override = configuration.agentOverrides.get(subject.agentName);
  if (override !== undefined)
    return fromOverride(configuration, override, subject, "agent_override");
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

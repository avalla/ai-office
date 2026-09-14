# ADR-0019: Agent model routing and immutable run model selection

Status: accepted, 2026-09-14. Amends [ADR-0005](ADR-0005-provider-registry-langchain-adapter.md)
for the OpenAI registration and [ADR-0017](ADR-0017-bounded-external-worker.md)
for worker model selection. Provider credential location amended by
[ADR-0020](ADR-0020-managed-provider-credential-boundary.md): a managed Runtime
reads credentials only from owner-only files in `<AI_OFFICE_HOME>/credentials/`.

## Context

Roles declare a semantic `modelPolicy` (`economical`, `balanced`,
`high_reasoning`, ...) and authoritative execution limits (`maxIterations`,
`maxCostMicros`, `timeoutSeconds`). Before this decision the policy was
descriptive only. The gateway registry resolved exactly one global model from
`AI_OFFICE_LLM_MODEL`, no normal daemon command composed it, and the bounded
Claude worker ([ADR-0017](ADR-0017-bounded-external-worker.md)) used its client
default or a per-tick `--worker-model`. A run therefore had no recorded model,
the model could depend on whichever operator flag or client default applied at
dispatch, and inexpensive models could not be reserved for high-volume roles.

## Decision

### Four distinct concepts

1. **Model policy** — the semantic requirement a role declares. It stays in
   role definitions, SQLite and portable snapshots. It is never replaced by a
   concrete model string.
2. **Model profile** — host deployment configuration mapping a policy (or an
   explicit profile key) to a canonical `<provider>:<model>` plus optional
   execution parameters (`reasoning_effort`, `max_output_tokens`).
3. **Resolved model** — an immutable, non-secret `AgentRunModelSelection`
   (`policy`, `profile`, `modelRef`, `providerId`, `model`, parameters,
   `source`) attached to one `AgentRun` when it is scheduled.
4. **Provider credentials** — Runtime host configuration (`OPENAI_API_KEY`, see
   [ADR-0020](ADR-0020-managed-provider-credential-boundary.md)) or a client's
   own login. Never in routing files, run snapshots, events, service
   definitions, diagnostics, dashboard state or portable state.

### Configuration sources

Routing is non-secret, host-local configuration read once by the Runtime
composition root and immutable for the host's lifetime; a change needs a Runtime
restart. Sources are deterministic:

- **Canonical file:** `<AI_OFFICE_HOME>/model-routing.yaml` (strict YAML/JSON,
  `schema_version: 1`, sections `profiles`, `policies`, `default_profile`,
  `agents`, `projects`).
- **Managed service:** `ai-office service install` renders
  `AI_OFFICE_MODEL_ROUTING_SOURCE=runtime_home` into the Runtime's systemd unit
  and launchd plist, next to `AI_OFFICE_HOME`. With it, the Runtime reads only
  the canonical file and ignores `AI_OFFICE_MODEL_ROUTING_FILE` and
  `AI_OFFICE_LLM_MODEL` from the service manager's environment (reported as
  `MANAGED_ENVIRONMENT_IGNORED`). Routing after reboot or login therefore never
  depends on an inherited shell environment, and both platforms behave the
  same. A missing file means `unconfigured`; an unreadable one fails closed.
- **Foreground:** `AI_OFFICE_MODEL_ROUTING_FILE` (absolute or `~/` path) is an
  explicit override of the canonical file; without it the canonical file is
  used when present. The legacy `AI_OFFICE_LLM_MODEL` remains the lowest
  precedence default in the foreground only.

The routing source marker is part of the rendered definition, so the existing
text-based ownership classification reports a pre-routing Runtime definition as
`managed_outdated` and `service install` replaces it; reinstalling an unchanged
plan stays idempotent. Routing file content is deliberately not part of the
definition: editing it needs a Runtime restart, not a reinstall.

Provider/model parsing and provider support stay in `packages/llm-gateway`
(`parseCanonicalModelRef`, provider descriptors,
`ModelProviderRegistry.resolveModelRef`), which constructs no client for
validation or diagnostics.

### Precedence

Resolution is a pure application function evaluated in this order:

1. project agent override: `projects.<project-id>.agents.<name>`, keyed by the
   Runtime project id (never a repository path) and applied only in that
   project;
2. host-global agent override: `agents.<name>`, applied to every project's
   agent with that synchronized name — a name does not identify one Agent;
3. the role's `modelPolicy` through an explicit `policies` mapping, or a profile
   with the same key;
4. `default_profile`;
5. `AI_OFFICE_LLM_MODEL` (`legacy_default`, foreground only).

The persisted `source` distinguishes `project_agent_override` from
`agent_override`. With no routing, runs are recorded `unrouted` and a client
worker keeps its own default, exactly as before. Any explicit invalid value
(unreadable file, unknown key, credential-like key, malformed ref, unsupported
provider, undefined profile, invalid parameter or project id, unresolved default
or override) makes routing `misconfigured`, and every schedule fails closed with
a typed `ModelRoutingError`. A configured host where none of the rules match
fails with `MODEL_POLICY_UNRESOLVED`. No invalid rule falls through to a lower
one.

The loaded state is structurally immutable: records and arrays are frozen and
every map is a `FrozenMap` whose backing `Map` is private, has no mutators and
is never handed out, including through `forEach`. `ReadonlyMap` types alone
would not prevent a composed component from mutating shared routing.

### Frozen at scheduling

`ScheduleAgentRun` reads the agent and its role inside the same short
`BEGIN IMMEDIATE` transaction that inserts the run and acquires its task lock,
resolves the model against the frozen host state, and persists the result in
`agent_run.model_routing_json` (migration `0030`). Resolution failure rolls the
transaction back: no run, event or lock remains. The queued event records the
same routing. A SQLite trigger rejects any later change, including backfilling
`NULL`.

Admission and execution never re-resolve. `WorkerAgentExecutor` passes the
persisted selection to the worker in `WorkerContext.model`, which the input
digest pins. A worker adapter declares `supportsModel`; one that cannot honor
the exact model and parameters fails with `WORKER_MODEL_UNSUPPORTED` before
`running`, and `run:tick` refuses such a batch before admission. An adapter
without a default model of its own declares `requiresModelSelection`, so
unrouted and historical runs fail with `WORKER_MODEL_REQUIRED` instead of using
an ambient default. Retry and recovery of a run use the same persisted row, so
they cannot switch models.

Controlled-action arguments are arbitrary connector payloads (a catalog entry
may legitimately carry `{"model": "Model 3"}`) and are not model-selection
authority. No routing or execution code reads them; the security invariant is
that model selection comes only from host routing and the agent's role, frozen
on the run. No generic field names are reserved in action payloads, and neither
`run:schedule` nor any worker offers a caller-selected model.

### Executors

- **Gateway worker (`run:tick --worker gateway`)** executes routed runs through
  the metered LLM gateway. It is a `WorkerRuntime`, so it reuses the whole
  authoritative worker path — context assembly and pinning, authority fence,
  lease renewal, provenance (`llm-gateway`), cancellation, deadline and fenced
  acceptance — and adds no execution lifecycle of its own. It sends one
  request: the persisted model, the profile's `reasoning_effort`, and an output
  cap (the profile's `max_output_tokens`, else a bounded executor default that
  is recorded with the result). Providers declare in their descriptor which
  parameters they apply exactly (`gatewayExecution`); anything else fails
  before pricing, reservation or request. `ModelRequest` carries
  provider-neutral `parameters`, and every adapter either applies each
  parameter exactly or throws `UnsupportedModelParameterError` before contacting
  the vendor. `ExactModelProvider` rejects a request or response for any other
  provider or model (`WORKER_MODEL_MISMATCH`); model substitution is not part of
  an approved provider contract, so aliases must be configured as the exact
  model the vendor reports. Credentials are resolved through
  `ModelProviderRegistry.resolveModelRef`, which ignores ambient
  `AI_OFFICE_LLM_MODEL`. Currently OpenAI is gateway-executable.
- **Claude worker (`run:tick --worker claude`)** honors only `anthropic:`
  models, maps `reasoning_effort` to `--effort`, rejects `max_output_tokens`,
  and treats `--worker-model` as applying only to unrouted and historical runs
  (`WORKER_MODEL_CONFLICT` otherwise). `--worker-model` is refused for the
  gateway worker.
- Configured `AgentExecutor` adapters receive the run with its selection but,
  like their acceptance fence, are trusted to honor it.

A Codex CLI worker was considered for OpenAI models. It would add a second
subprocess boundary whose cost is a client estimate or subscription-bound and
unmeterable by AI Office, and whose effective model cannot be verified; it would
duplicate the gateway's pricing and budget role without its guarantees. The
gateway worker satisfies the same bounded, fenced execution contract with
authoritative metering, so it is the first-party OpenAI path.

The default registry builds OpenAI providers with the native Responses adapter
instead of the LangChain compatibility adapter (amending ADR-0005 for this
provider): LangChain may drop reasoning options for some models and falls back
to the configured model name when the vendor reports none, while the native
adapter forwards parameters verbatim (the vendor rejects ones a model does not
support), requires the effective model and request ID, reports response status,
sends `store: false`, and never retries on its own. The Anthropic registration
keeps LangChain and therefore refuses execution parameters.

### Cost governance

Model selection never touches role limits. The same `maxCostMicros`,
iterations and timeout bound a run whatever model, profile, override or executor
was chosen.

For gateway execution the role's `maxCostMicros` (USD micros) becomes the run's
`agent_run` budget; an existing narrower run budget is kept and a wider one is
lowered to the role limit. `MeteredLlmGateway` remains the only accounting
component: it resolves active pricing (unknown pricing still fails closed with
`PricingNotFoundError`, reported as `WORKER_PRICING_UNAVAILABLE`), reserves the
worst-case cost of the bounded request — a byte-count upper bound for input and
the output cap for output and reasoning — against that budget in one atomic
transaction before the request (`WORKER_BUDGET_EXHAUSTED` when it does not fit),
records usage and cost idempotently afterwards, and releases the reservation on
failure. `completeMetered` returns the cost evidence the gateway recorded, so
the executor copies rather than recomputes it. Usage is recorded before the
answer is judged: a truncated or malformed answer still cost what the provider
reported and is never accepted.

`run:show [--json]` distinguishes the assigned model (`model.selection`), the
actual provider/model and tokens, and cost: gateway runs carry `metering`
(actual, estimated and reserved micros, currency, pricing version, applied
parameters and run budget) and never a client estimate; client-login workers
carry only their client-reported estimate or unknown cost, and AI Office never
fabricates gateway cost for them. The applied role limits are recorded for
every worker dispatch.

### Portability

Policies are portable. Profiles, overrides and resolved selections are
host-local deployment facts: the portable snapshot schema is unchanged, and a
restored historical run has no routing record. A project that must mandate a
concrete model needs a future, explicitly versioned portable-state decision.

### Security

Model selection is configuration, not an agent capability. There is no
operator mutation command and no worker-, action- or run-supplied model option,
and workers receive no tool that could change configuration. A persisted
selection is immutable in the domain and in SQLite. Diagnostics name
configuration keys, model refs and credential variable names only; they never
echo values that may be credentials, invalid project keys or host paths.

## Consequences

- Operators inspect routing with read-only `agent:models` and `model:check`
  (neither sends a model request nor writes state), which report the routing
  source, override scope, which providers are gateway-executable and which
  credentials the host lacks; a run's assignment and usage with
  `run:show [--json]`.
- Runs created before migration `0030` stay explicitly `not recorded` and keep
  their legacy execution semantics; they are never reinterpreted.
- A foreground host that sets `AI_OFFICE_LLM_MODEL` assigns that model to every
  otherwise unresolved run; if the selected worker cannot execute it, those runs
  are refused before dispatch instead of silently using another model.
- Service definitions never carry provider credentials. (Superseded in part by
  [ADR-0020](ADR-0020-managed-provider-credential-boundary.md): a managed
  Runtime now reads them only from `<AI_OFFICE_HOME>/credentials/` and ignores
  the service manager's environment.)
- A drifted provider response cannot be priced (pricing is keyed by the exact
  model), so its reservation is released without a usage record; the run fails
  closed with `WORKER_MODEL_MISMATCH`.
- Gateway execution reserves only the `agent_run` budget; project, task and
  agent budgets are not reserved in the same request.

Deferred, with roadmap items: a credential boundary for managed services
(since delivered by ADR-0020), gateway execution for Anthropic models,
co-reservation of wider budget scopes, an audited override mutation command,
dashboard rendering of the selection, and hot reload of routing files.

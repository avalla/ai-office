# ADR-0019: Agent model routing and immutable run model selection

Status: accepted, 2026-09-14.

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
4. **Provider credentials** — host environment only (`OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, or a client's own login). Never in routing files, run
   snapshots, events, diagnostics or portable state.

### Configuration and precedence

The Runtime composition root reads host routing once at start:
`AI_OFFICE_MODEL_ROUTING_FILE` (absolute or `~/` path to strict YAML/JSON,
`schema_version: 1`, sections `profiles`, `policies`, `default_profile`,
`agents`) and the legacy `AI_OFFICE_LLM_MODEL`. The state is immutable for the
host's lifetime; a change needs a host restart. Provider/model parsing and
provider support stay in `packages/llm-gateway` (`parseCanonicalModelRef`,
provider descriptors, `ModelProviderRegistry.resolveModelRef`), which constructs
no client for validation or diagnostics.

Resolution is a pure application function evaluated in this order:

1. host agent override (keyed by synchronized agent name; a profile or a
   concrete model);
2. the role's `modelPolicy` through an explicit `policies` mapping, or a profile
   with the same key;
3. `default_profile`;
4. `AI_OFFICE_LLM_MODEL` (`legacy_default`).

With neither a routing file nor `AI_OFFICE_LLM_MODEL`, routing is
`unconfigured` and runs are recorded `unrouted`: the selected executor keeps its
own default, exactly as before. Any explicit invalid value (unreadable file,
unknown key, credential-like key, malformed ref, unsupported provider, undefined
profile, invalid parameter, unresolved default or override) makes routing
`misconfigured`, and every schedule fails closed with a typed
`ModelRoutingError`. A configured host where none of the rules match fails with
`MODEL_POLICY_UNRESOLVED`. No invalid rule falls through to a lower one.

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
digest pins. A worker adapter must declare `supportsModel`; one that cannot
honor the exact model and parameters fails with `WORKER_MODEL_UNSUPPORTED`
before `running`, and `run:tick` refuses such a batch before admission. The
Claude worker honors only `anthropic:` models, maps `reasoning_effort` to
`--effort`, rejects `max_output_tokens`, and treats `--worker-model` as applying
only to unrouted and historical runs (`WORKER_MODEL_CONFLICT` otherwise).

Freezing at scheduling makes the model part of the admitted work rather than an
ambient dispatch-time fact: the operator who schedules sees the assignment, it
is auditable before execution, it cannot drift with host restarts, profile edits
or role re-synchronization, and recovery or retry of a queued run cannot
silently switch models.

### Cost governance

Model selection never touches role limits. The same `maxCostMicros`,
iterations and timeout bound a run whatever model it was assigned; a stronger
override grants no larger budget. Worker results record the applied role limits
next to reported model, tokens and estimated cost, so `run:show` answers which
agent ran, which policy was requested, which profile/model/provider was
resolved, what was used and which budget applied. Metering remains inside
`MeteredLlmGateway`: missing pricing still fails closed with
`PricingNotFoundError`, and `model:check` reports `PRICING_MISSING` without
treating unknown cost as zero.

### Portability

Policies are portable. Profiles, overrides and resolved selections are
host-local deployment facts: the portable snapshot schema is unchanged, and a
restored historical run has no routing record. A project that must mandate a
concrete model needs a future, explicitly versioned portable-state decision.

### Security

Model selection is configuration, not an agent capability. There is no
operator mutation command and no worker- or run-supplied model option:
`run:schedule` accepts none, an agent run's controlled-action arguments may not
carry model-selection fields, and workers receive no tool that could change
configuration. A persisted selection is immutable in the domain and in SQLite.

## Consequences

- Operators inspect routing with read-only `agent:models` and `model:check`
  (neither sends a model request nor writes state) and a run's assignment with
  `run:show [--json]`.
- Runs created before migration `0030` stay explicitly `not recorded` and keep
  their legacy execution semantics; they are never reinterpreted.
- A host that sets `AI_OFFICE_LLM_MODEL` now assigns that model to every run;
  if it names a provider the selected worker cannot execute, those runs are
  refused before dispatch instead of silently using another model.
- Configured `AgentExecutor` adapters receive the run with its selection but,
  like their acceptance fence, are trusted to honor it.

Deferred: per-project override scoping, an audited override mutation command,
dashboard rendering of the selection, a gateway-backed executor that applies
profile parameters to provider requests, and hot reload of routing files.

# LLM providers, gateway, and cost control

The LLM gateway provides a normalized provider port, provider registry, deterministic mock, infrastructure-only LangChain compatibility adapter, existing OpenAI Responses HTTP adapter, retry-aware fallback chain, and metered gateway. The default registry supports OpenAI and Anthropic. Callers must supply an estimated token envelope and accounting context.

No current onboarding or normal daemon command constructs a provider client from
this registry. Codex or Claude owns conversational onboarding through the
`ai-office` skill, so normal installation does not need a `.env`, model
reference, or provider credential. The Runtime host does use the registry's
provider descriptors and model-reference parser, without constructing clients,
to validate [agent model routing](#agent-model-routing) and assign each run an
immutable model.

## Agent model routing

Model selection keeps four concepts apart
([ADR-0019](../adr/ADR-0019-agent-model-routing.md)):

| Concept | Where it lives | Portable |
| --- | --- | --- |
| model policy (`economical`, `balanced`, `high_reasoning`) | role definition, SQLite | yes |
| model profile (`<provider>:<model>` plus parameters) | host routing file | no |
| resolved model | `agent_run.model_routing_json`, frozen at scheduling | no |
| provider credentials | Runtime host environment or client login | never |

The Runtime host reads routing once at start. Point
`AI_OFFICE_MODEL_ROUTING_FILE` at an absolute (or `~/`) YAML or JSON file:

```yaml
schema_version: 1
profiles:
  economical:
    model: openai:gpt-luna
    reasoning_effort: low
  balanced:
    model: openai:gpt-sol
    reasoning_effort: medium
  high_reasoning:
    model: openai:gpt-astra
    reasoning_effort: high
policies:          # optional; a policy also maps to a profile with its own name
  default: balanced
default_profile: balanced   # optional
agents:            # optional host-local overrides, keyed by synchronized agent name
  developer:
    profile: economical
  security:
    model: anthropic:claude-opus-4-1
```

Model names above are examples. The file never accepts credentials; unknown or
credential-like keys make routing invalid. Precedence is agent override, then
role policy, then `default_profile`, then the legacy `AI_OFFICE_LLM_MODEL`.
Without a file or `AI_OFFICE_LLM_MODEL`, runs are scheduled `unrouted` and the
selected executor keeps its default. Any explicit invalid value fails every
schedule closed; no invalid rule falls back to a lower one. Restart the Runtime
host after changing routing.

Inspection never sends a model request or writes state:

```bash
ai-office agent:models --project <id> [--json]   # agent, policy, profile, model, source, budget
ai-office model:check [--project <id>] [--json]  # exit 1 on errors
ai-office run:show --project <id> --run <id> [--json]
```

`model:check` reports undefined policies and profiles, malformed refs,
unsupported providers, invalid parameters, unresolved defaults and overrides as
errors, and missing gateway credentials (by variable name only), missing
pricing, overrides for unknown agents and deprecated legacy forms as warnings.

Runs keep the model assigned when they were scheduled, whatever changes later in
role policy, profiles, overrides or host environment. Execution uses only the
persisted selection; a worker that cannot honor it exactly fails before dispatch
and `run:tick` leaves such a batch queued. The Claude worker executes only
`anthropic:` models, maps `reasoning_effort` to `--effort`, and rejects
`max_output_tokens`. Runs created before migration `0030` show
`Model: not recorded` and keep their previous behavior.

Model routing does not change cost governance. Role `maxCostMicros`, iteration
and timeout limits apply unchanged whatever model was assigned, so a stronger
override never grants a larger budget. Worker results record the applied role
limits beside the reported model, tokens and estimated cost. Gateway metering
still requires active pricing for the resolved provider/model and fails closed
with `PricingNotFoundError` otherwise.

## Provider configuration

For an explicit gateway consumer, `ModelProviderRegistry.resolveModelRef` builds
a provider for a supplied canonical reference such as a run's persisted
selection, ignoring ambient `AI_OFFICE_LLM_MODEL`. The legacy single-model
`resolve` reads one canonical model reference in `<provider>:<model>` form:

```bash
AI_OFFICE_LLM_MODEL=openai:gpt-5.4
OPENAI_API_KEY=...
```

```bash
AI_OFFICE_LLM_MODEL=anthropic:claude-sonnet-4-6
ANTHROPIC_API_KEY=...
```

The registry derives the provider from the prefix, validates the model and required credential before constructing an adapter, and returns the bare model name to the gateway. Pricing therefore remains keyed by `provider=openai, model=gpt-5.4` or `provider=anthropic, model=claude-sonnet-4-6`.

For backwards compatibility, a bare `AI_OFFICE_LLM_MODEL=<model>` is accepted only when `AI_OFFICE_LLM_PROVIDER=<provider>` is also set. This compatibility form is deprecated. When the model is prefixed, its prefix is authoritative and the compatibility variable is ignored.

Provider-native credentials remain infrastructure concerns. The current registry reads only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; keys are never passed through domain or application objects. Missing configuration errors list environment-variable names, never their values.

## Dependency and execution boundary

```text
Explicit application consumer
    -> MeteredLlmGateway
    -> LlmProvider port
    -> ModelProviderRegistry
    -> LangChainModelProvider
    -> OpenAI or Anthropic
```

LangChain is a compatibility adapter only. It does not own agents, tools orchestration, memory, retries, policy, task execution, pricing, or budgets. Provider retries are disabled in the registered LangChain chat models so retry and fallback behavior remains explicit in AI Office.

Pricing values and budgets use integer micros, bounded by JavaScript's safe-integer range when stored in SQLite (`0..9,007,199,254,740,991`). Floating-point monetary values are never accepted.

For a fallback chain, the gateway resolves active pricing for every candidate provider/model and rejects the whole request if any candidate is unpriced or uses a different currency. It reserves the maximum candidate estimate with one atomic `authorizeAndReserve` transaction, executes outside the transaction, then prices and persists the provider/model that actually answered. The unused part of a reservation is not counted as spend. Actual cost above the reservation is allowed and recorded as an explicit `overage_micros`; it remains visible for audit.

Supported budget scopes are `project`, `task`, `agent`, and `agent_run`, each with project ownership checks. `milestone` is intentionally unsupported until a reliable milestone-to-task/run accounting relation exists. Reservations have an expiry. Expired rows stop reducing availability immediately, but their status changes only through the explicit, deterministic cleanup method. Failed and cancelled calls release their reservation.

Provider usage is idempotent by `provider + provider_request_id` when the provider supplies an ID. Pricing intervals use half-open boundaries (`effective_from <= at < effective_to`) and overlapping intervals for the same provider/model/currency are rejected.

The existing native OpenAI adapter still requires an API key passed by its composition root. The registry's provider builders read native environment variables and pass keys directly to the corresponding LangChain integration; no key is persisted. Automated tests use fake chat models or transports and never call live provider APIs.

The LangChain adapter maps text, effective model, provider request ID, standard usage metadata, provider response metadata, and measured latency into the normalized response. The cost contract requires numeric cached-input and reasoning token counts, so unavailable optional detail maps to zero, matching the existing native OpenAI adapter. The adapter does not infer or fabricate non-zero provider-specific usage fields. If total input or output usage is absent, the response is rejected instead of being guessed.

The CLI exposes pricing, budget, cost-report and read-only model routing
commands, but no current product command invokes a model provider through the
gateway. Standard gateway tests use
deterministic providers and injected transports rather than paid calls. A
future consumer must define its own purpose, accounting dimensions,
authentication boundary, and approval model before composition.

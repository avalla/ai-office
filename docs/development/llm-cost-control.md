# LLM providers, gateway, and cost control

The LLM gateway provides a normalized provider port, provider registry, deterministic mock, infrastructure-only LangChain compatibility adapter, existing OpenAI Responses HTTP adapter, retry-aware fallback chain, and metered gateway. The default registry supports OpenAI and Anthropic. Callers must supply an estimated token envelope and accounting context.

No current onboarding or normal daemon command composes this registry. Codex or
Claude owns conversational onboarding through the `ai-office` skill, so normal
installation does not need a `.env`, model reference, or provider credential.
The configuration below documents the infrastructure contract for an explicit
future consumer and adapter tests; it is not an onboarding setup guide.

## Provider configuration

Use one canonical model reference in `<provider>:<model>` form:

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

The CLI exposes pricing, budget, and cost-report commands, but no current
product command invokes a model provider. Standard gateway tests use
deterministic providers and injected transports rather than paid calls. A
future consumer must define its own purpose, accounting dimensions,
authentication boundary, and approval model before composition.

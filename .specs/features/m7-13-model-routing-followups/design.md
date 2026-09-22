# Design

## Decisions

1. Keep routing snapshots immutable. The daemon owns a small mutable holder whose replacement is atomic; scheduling receives one snapshot and persists it as before.
2. Keep routing configuration host-local. Operator mutation rewrites the selected routing file atomically as strict JSON (valid YAML), then reloads and audits the result. No credentials or paths enter SQLite or read models.
3. Extend the cost port with optional batch reservation/finalization seams. SQLite implements the batch transaction; compatibility fakes retain the existing single-reservation behavior.
4. Use a native Anthropic Messages API adapter over fetch, matching the native OpenAI adapter's transport and validation boundary. max_output_tokens maps to max_tokens; reasoning_effort is rejected because Anthropic's thinking budget is not equivalent to the provider-neutral effort contract.
5. Publish persisted model_routing_json through the operational read model and sanitize the existing worker output metering for dashboard presentation.

## Alternatives considered

- Mutating SQLite routing state: rejected because routing is explicitly host-local and non-portable.
- Reusing LangChain for Anthropic: rejected because parameter application and effective-model/request-id guarantees are not exact.
- Reserving scopes sequentially: rejected because partial reservations violate budget atomicity.

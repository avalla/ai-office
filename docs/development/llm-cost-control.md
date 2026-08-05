# LLM gateway and cost control

M4 provides a provider port, deterministic mock, OpenAI Responses HTTP adapter, retry-aware fallback chain, and metered gateway. Callers must supply an estimated token envelope and accounting context.

Pricing values and budgets use integer micros, bounded by JavaScript's safe-integer range when stored in SQLite (`0..9,007,199,254,740,991`). Floating-point monetary values are never accepted.

For a fallback chain, the gateway resolves active pricing for every candidate provider/model and rejects the whole request if any candidate is unpriced or uses a different currency. It reserves the maximum candidate estimate with one atomic `authorizeAndReserve` transaction, executes outside the transaction, then prices and persists the provider/model that actually answered. The unused part of a reservation is not counted as spend. Actual cost above the reservation is allowed and recorded as an explicit `overage_micros`; it remains visible for audit.

Supported budget scopes are `project`, `task`, `agent`, and `agent_run`, each with project ownership checks. `milestone` is intentionally unsupported until a reliable milestone-to-task/run accounting relation exists. Reservations have an expiry. Expired rows stop reducing availability immediately, but their status changes only through the explicit, deterministic cleanup method. Failed and cancelled calls release their reservation.

Provider usage is idempotent by `provider + provider_request_id` when the provider supplies an ID. Pricing intervals use half-open boundaries (`effective_from <= at < effective_to`) and overlapping intervals for the same provider/model/currency are rejected.

The OpenAI adapter requires an API key passed by its composition root. No environment variable is read inside the adapter, no key is persisted, and automated tests inject a fake `fetch` implementation.

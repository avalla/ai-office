# LLM gateway and cost control

M4 provides a provider port, deterministic mock, OpenAI Responses HTTP adapter, retry-aware fallback chain, and metered gateway. Callers must supply an estimated token envelope and accounting context.

Pricing values and budgets use integer micros. The gateway resolves the pricing version effective at call time, checks spend plus active reservations, reserves estimated cost, executes outside a transaction, then records normalized usage and actual cost. Failed calls release their reservation.

The OpenAI adapter requires an API key passed by its composition root. No environment variable is read inside the adapter, no key is persisted, and automated tests inject a fake `fetch` implementation.

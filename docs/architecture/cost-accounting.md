# Cost accounting

The LLM gateway meters provider usage and records successful calls as cost events. The CLI currently manages pricing, budgets, and reports; agent execution is still simulated and does not produce real provider usage.

## Accounting context

Every metered request has:

- a project;
- a purpose;
- provider and model identity;
- the pricing version used;
- optional task, agent, and agent-run dimensions.

Budget scopes currently supported are project, task, agent, and agent run. Workspace and milestone budgets are not accepted by the current application.

## Cost lifecycle

```text
authorize -> reserve -> execute -> measure -> consume -> release
```

Budget checks account for active reservations, not only historical spending. Pricing and budget values use integer micros; floating-point money is not accepted.

Before a provider call, the gateway prices all fallback candidates and atomically reserves the maximum candidate estimate. Provider work happens outside the transaction. On success, the gateway normalizes input, cached-input, output, and reasoning tokens, then atomically persists usage and actual cost for the provider/model that answered. Unused reservation is not spend; actual cost above the reservation is recorded as explicit overage.

On failure or cancellation, the reservation is released. Provider usage is idempotent by provider plus provider request ID when that ID is available. Historical cost rows retain the pricing version used at execution time.

Provider failures are typed. The fallback chain advances only for retryable failures; configuration and invalid-response errors stop immediately.

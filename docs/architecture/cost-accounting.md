# Cost accounting

Every external paid operation emits a cost event.

## Required dimensions

- workspace;
- project;
- task;
- agent;
- agent run;
- provider;
- model;
- purpose;
- pricing version.

## Cost lifecycle

```text
authorize -> reserve -> execute -> measure -> consume -> release
```

Budget checks must account for active reservations, not only historical spending.

## Estimates and actuals

The system records:

- estimated cost immediately;
- actual cost when the provider exposes authoritative usage or billing data.

Historical events retain the pricing version used at execution time.

The gateway normalizes input, cached-input, output, and reasoning tokens before applying integer-micro pricing. For fallback, it reserves the maximum priced candidate estimate and records the identity of the provider that actually answered. A reservation is created atomically with the budget check before the provider call, consumed atomically with usage and cost recording on success, or released on failure. Aggregations are available by project, task, agent, and agent run.

Milestone budgets are deferred: the schema does not yet have a reliable milestone-to-task/run accounting relation, so the application must not claim or accept that scope.

Provider failures are typed. The fallback chain advances only for retryable failures; configuration and invalid-response errors stop immediately.

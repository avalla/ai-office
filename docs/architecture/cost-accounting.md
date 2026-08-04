# Cost accounting

Every external paid operation emits a cost event.

## Required dimensions

- workspace;
- project;
- milestone;
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

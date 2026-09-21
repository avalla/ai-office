# M7.13 Model routing follow-ups

## Objective

Complete the remaining M7.13 runtime routing capabilities without weakening the immutable model selection contract.

## Acceptance criteria

- Anthropic gateway execution uses a native HTTP adapter, reports effective model/request ID, applies max output tokens exactly, and rejects unsupported reasoning effort before network access.
- A gateway request atomically reserves the run budget plus every configured project, task, and agent budget in the same currency; all reservations release on a pre-response failure.
- Operator-only model override mutation and routing reload commands persist non-secret routing configuration, audit the change, and affect future schedules only.
- Run detail exposes assigned model, actual model, usage, gateway metering, and client-reported estimate without host paths or credentials.
- Reload swaps the immutable routing snapshot between schedules and does not reinterpret an already persisted run.
- Existing task:list behavior remains unchanged.

## Out of scope

Credential storage, portable routing state, milestone budgets, and future M11 orchestration work.

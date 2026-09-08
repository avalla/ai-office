# ADR-0017: Explicit, bounded external worker execution

Status: accepted, 2026-09-07.

## Context

Normal queued tasks previously fell back to a simulator and could appear
completed without model execution. A general coding CLI with filesystem or
shell tools would bypass AI Office's controlled-resource boundary. The first
worker must provide useful generated work without creating that bypass.

## Decision

Introduce an application `WorkerRuntime` port and a Claude Code adapter that
receives only bounded, explicit task/agent/stage data. It runs in a private
temporary directory with built-in tools, MCP discovery, project settings,
hooks, skills and session persistence disabled. The installed trusted client
retains its own login; AI Office never copies credentials. This is a trusted
local execution contract, not protection against a hostile same-UID process.

The operator selects `run:tick --worker claude` or `--simulate`. Unconfigured
normal tasks remain queued. Action intents still use the controlled-action
gateway. No executor silently falls back to simulation.

The application builds context from SQLite and pins its SHA-256 digest with
executor kind and adapter/version before invoking the worker. Migration 0027
adds immutable dispatch metadata and leaves historical runs unknown. A digest
identifies input; it does not preserve an exact reconstructible input snapshot.
Worker results contain only a bounded final summary/content and supported
session/model/usage fields. They never establish task completion, stage
advancement, successful tests, or approval.

Role timeout and iteration limits bound the process. For this adapter only,
the role's currency-free `maxCostMicros` is interpreted as millionths of a USD
CLI cost estimate and passed to `--max-budget-usd`. This is a per-run CLI limit,
not a gateway reservation, cumulative project budget, hard billing ceiling, or
subscription charge. Zero budget refuses execution. Missing usage stays unknown.
Model selection is explicit through `--worker-model`, otherwise the client
chooses its model; generic `modelPolicy` values are not silently mapped to
provider model names. Versioned `system.md` prompt integration remains future.

The application renews the exclusive lease and checks task/agent/role/pipeline
facts. Loss of authority aborts the process. The adapter bounds output, enforces
a deadline, and waits for child termination before acknowledging cancellation.
After host interruption, reconciliation reports unobserved external work;
it resolves local records without claiming the old process stopped or replaying
the operation. No SQLite transaction spans client inspection or execution.

## Alternatives and consequences

A gateway-backed executor would reuse central metering but require provider
configuration and another output contract. It remains a valid later adapter.
A repository-enabled coding CLI needs an enforceable resource-access boundary
and is deferred. The selected slice supports real analysis and drafting now;
autonomous repository delivery, tools, durable observation across host restart,
organization-to-runtime configuration and review/fix loops remain later work.

See the [assessment](../implementation/first-worker-assessment.md) and
[operation guide](../development/agent-runtime.md).

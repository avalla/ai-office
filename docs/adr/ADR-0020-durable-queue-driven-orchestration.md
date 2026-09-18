# ADR-0020: Durable queue-driven orchestration

- Status: accepted
- Date: 2026-09-16

## Context

AI Office needs an automatic worker path for enforced pipelines, but Redis and
BullMQ are delivery infrastructure, not a second state store or workflow
engine. The existing Runtime, SQLite repositories, PipelineRun state machine,
AgentRun admission, model routing, capability policy, approvals, and audit
records already define what is true.

## Decision

SQLite remains the sole authority for tasks, PipelineRuns, StageRuns, AgentRuns,
approvals, capabilities, authorization, model routing, budgets, memory,
auditing, and governance. The application exposes a provider-neutral `JobQueue`
port. The first adapter is an optional BullMQ implementation backed by a
host-local Redis-compatible endpoint, including Valkey. It is disabled by
default and AI Office never installs the external service.

Authoritative mutations that request delivery append a bounded, secret-free
`job_outbox` row in the same short SQLite transaction. A Runtime-owned
dispatcher publishes pending rows and marks them dispatched only after the queue
accepts them. Delivery is at-least-once: replay may publish a job again, and a
crash after queue acceptance but before marking the row is expected.
Deterministic BullMQ IDs and existing SQLite admission/fencing make duplicate
publication and duplicate delivery harmless from the application's viewpoint.

Queue topology is logical rather than role-specific:
`ai-office-orchestration` wakes the pipeline engine and
`ai-office-agent-runs` wakes the existing AgentRun execution path. BullMQ
FlowProducer is not used. Jobs contain IDs and minimal project context only;
workers reload and validate authoritative state before doing anything. Queue
possession never grants capability or transition authority.

The pipeline engine continues to own stage activation, role/agent assignment,
separation of duties, approval gates, cancellation, terminal task state, and
audit. A successful fenced AgentRun completion validates its exact project,
pipeline, current-stage, assignment, role, and run binding, then persists stage
completion and the next orchestration intent. Approval-required stages remain
`awaiting_approval` and produce no next-stage intent until an operator approval
is committed.

Failures are classified by the application boundary. Only safe transient
delivery failures and provider transport failures without ambiguous side
effects are retryable, with bounded exponential backoff. Stale authority,
validation, model/configuration, approval rejection, failed fences, and
`execution_unknown` are terminal or require reconciliation and are never
replayed by generic BullMQ retry.

Role guidance is loaded from `system.md` during trusted `agent:sync`, validated
and bounded, persisted with a version, and pinned into each AgentRun. Workers
receive the generic Runtime constraints and the pinned role guidance as separate
system context. Guidance is included in the execution input hash but not in
audit or queue payloads. Core role keys explicitly equal default manifest role
IDs; incompatible catalogs fail validation rather than using fuzzy matching.

Runtime composition owns Redis connections, dispatch polling, worker lifecycle,
and graceful shutdown. Startup dispatches pending outbox intent. Redis loss
cannot erase SQLite intent; after a flush, pending intent is reconstructable by
normal startup and outbox replay, while completed authoritative work is a safe
worker no-op. Queue health is reported as sanitized reachability/configuration,
pending outbox count, and consumer status. Credentials never enter SQLite,
audit, portable state, logs, dashboard output, or jobs.

CairnKeep remains read-only. This ADR does not introduce autonomous memory
writes, a role-specific queue, distributed scheduling, or a new AgentRun state
machine.

## Consequences

The queue can be replaced by another `JobQueue` adapter without changing
orchestration or domain code. Redis persistence and delivery guarantees are not
treated as product durability; SQLite and its migrations remain the recovery
source. Operators must provide and secure Redis/Valkey separately, and a
misconfigured queue fails closed while leaving authoritative outbox work visible
for later dispatch.

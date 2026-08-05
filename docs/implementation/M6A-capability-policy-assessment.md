# M6A capability policy assessment

## Current structure

AI Office is a strict TypeScript monorepo with four relevant boundaries: domain
models in `packages/domain`, use cases and ports in `packages/application`,
explicit SQLite adapters in `packages/storage-sqlite`, and a daemon-backed CLI in
`apps/daemon` and `apps/cli`. The project database is authoritative, migrations
are ordered SQL files tracked by `schema_migration`, foreign keys are enabled by
`openDatabase`, and the daemon serializes commands through its existing queue.

M3 introduced project-scoped roles, agents, runs, task locking, and append-only
run events. M4 introduced budgets and accounting, but capability authorization
must not become a parallel budget mechanism. M5 introduced governance reviews
and approvals. Those approvals describe governance decisions and are not action
execution approvals; M6A therefore records that an action needs approval without
creating or deciding an M5 review.

## Models and repositories to reuse

- `ProjectRepository` remains the source for project existence.
- `AgentRuntimeRepository.findAgent` supplies the persisted agent and its role;
  callers cannot assert an arbitrary role membership.
- `Role` and `Agent` remain unchanged. The descriptive `capabilities_json` on a
  role definition is not an authorization grant and is not reused as one.
- `Clock`, `IdGenerator`, and `TransactionRunner` supply deterministic time,
  identifiers, and short atomic write boundaries.
- `AuditEvent`, `AuditEventRepository`, and `RecordAuditEvent` remain the single
  append-only security and lifecycle audit facility.
- Existing cost and governance repositories are not changed or duplicated.

M6A adds one focused capability-policy repository port and one SQLite adapter for
resources, grants, and action requests. This keeps SQL out of application
services while avoiding a repository per table with no independent aggregate
boundary.

## Relationship to project, agent, and role

Every resource, grant, and action request belongs to exactly one project. A grant
also references exactly one resource in that project. SQLite composite ownership
checks and triggers reject cross-project resource, agent, or role references.

Policy evaluation is always for one persisted agent. Agent principal grants match
that agent ID; role principal grants match the agent's persisted `role_id`.
`user`, `workflow`, and `application` principal types are stored for the complete
capability model, but do not match an agent policy input. Role definition
capability strings remain descriptive configuration and never imply authority.

## Migration strategy

`migrations/project/0012_capability_policy.sql` is additive and leaves all prior
migrations untouched. It creates `resources`, `capability_grants`, and
`action_requests`, plus the requested project/principal/resource/status/time
indexes. Existing projects upgrade in place from the full M5 schema. Composite
indexes and triggers enforce same-project ownership in addition to ordinary
foreign keys. JSON columns use `json_valid`; closed unions use `CHECK` clauses.

The migration runner continues to apply each file once in a transaction. Upgrade
tests first build an M5 database through `0011_governance_hardening.sql`, insert
existing project data, then apply `0012` and verify preservation and constraints.

## Audit model

M6A extends `audit_event`; it does not introduce another audit log. Application
services append sanitized events for resource registration/disabling,
grant creation/revocation, and action requested/authorized/denied outcomes.
Events contain IDs, decision, risk, and matched grant IDs, but do not contain
credentials or raw arguments. Resource/grant writes and their audit append run
in the same short transaction. Action request persistence and its decision event
are also atomic.

The concrete action events are `action.requested`, followed atomically by either
`action.authorized` or `action.denied`. Evaluation, the conditional status update,
and both audit appends execute under the same immediate transaction, so a grant
revocation cannot interleave between evaluation and the persisted decision.

The action request itself stores the canonical normalized arguments, effective
constraints, decision explanation, and payload hash for later M6 phases. Full
tamper-evident audit chaining remains deferred.

## Canonical payload

The canonical payload has schema version 1 and binds project, agent, resource,
connector identity/version, operation, normalized arguments, and effective
constraints. Canonical serialization recursively sorts object keys and preserves
array order. It omits nothing implicitly: `undefined` and sparse arrays are
rejected, while an absent key and an explicit `null` remain distinct. Non-finite
numbers, functions, symbols, bigint, cycles, non-plain objects, and other
non-JSON values are rejected with typed errors. SHA-256 is computed over the
canonical UTF-8 JSON representation.

Prototype-sensitive keys (`__proto__`, `constructor`, and `prototype`) are also
rejected recursively. Canonical objects use null prototypes internally, avoiding
setter-based prototype mutation even before rejection is reported.

## Constraint model

Constraints are not deep-merged. A connector constraint registry routes parsing,
combination, and argument checks to a connector-specific handler. M6A registers
only the fake connector. Its typed constraint rules are:

- `allowedTargets`: intersection, with absence meaning no additional allow-list;
- `deniedTargets`: union;
- `maxPayloadBytes`: minimum;
- `allowMutation`: logical AND, with absence treated as non-permissive;
- unknown or invalid fields, incompatible connector constraints, and other
  combinations that cannot be proven safe: denial.

The fake handler validates the target and canonical argument byte length after
combination. Mutation operations require the effective `allowMutation` flag.

## Policy and risk model

The policy engine is pure, synchronous, deterministic, and has no LLM dependency.
It denies disabled/cross-project resources, ignores invalid-time, revoked,
cross-project, wrong-resource, and wrong-principal grants, and denies when no
remaining grant covers the operation. Wildcards are limited to a single
connector namespace suffix such as `fake.*`; they never authorize a critical
operation. Critical access requires an exact operation in a valid grant.

Fake operation risk is fixed: `fake.read` low, `fake.write` medium,
`fake.delete` high, and `fake.admin` critical. The engine can only retain or
increase descriptor risk; no input or grant can lower it. The resulting internal
decisions are `allow`, `deny`, `allow_simulation_only`, or
`allow_with_approval`, projected by the CLI as `allowed`, `denied`,
`simulation_required`, or `approval_required`.

M6A exposes no risk-override input. Values such as `riskLevel` inside action
arguments are ordinary payload data and cannot affect the trusted descriptor.
Future override support, if added, must be a trusted policy input and may only
raise risk.

Resource configuration is canonical JSON but is not a credential transport.
Sensitive keys such as credential references, passwords, secrets, tokens, API
keys, and authorization values are rejected recursively in both resource
configuration and action arguments. The reserved
`credential_ref` storage column has no application or CLI write path and is
excluded from all resource SELECTs, DTOs, hashes, audit events, and CLI output.

## Planned files

- domain capability types, errors, fake constraint handler, policy engine, action
  state machine, and canonical-value validation;
- application capability repository port, canonical hashing helper, and the six
  small requested services;
- one SQLite capability-policy repository;
- migration `0012_capability_policy.sql`;
- one CLI handler plus CLI context/wiring updates;
- unit tests for policy, constraints, lifecycle, canonicalization, hashing, and
  typed failures;
- integration tests for SQLite, audit, M5 upgrade, and daemon/CLI round trips;
- focused architecture/development documentation updates where behavior needs to
  be discoverable.

## Deferred scope (M6B-M6D)

M6A does not access or mutate any registered resource and does not expose stored
credentials. M6B owns the connector SDK, real filesystem scope/path and symlink
security, deterministic diffs, and atomic writes. M6C owns approval decisions,
execution-time revalidation, real execution, replay prevention, batches, source
preconditions, action cost dimensions, and the audit hash chain. M6D owns agent
executor integration, pending/interrupted recovery workflows, and the complete
agent-to-controlled-resource path. GitHub, shell, and SQLite connectors and all UI
work remain outside this change.

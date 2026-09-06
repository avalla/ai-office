# ADR-0016: Isolate source development and retain run ownership evidence

- Status: Accepted for the authorized consolidation implementation
- Date: 2026-09-05

## Context

Source-distribution invocation could select personal state; development mode
isolated project state but defaulted global memory to the personal home. Run
claims also needed durable provenance and explicit recovery without adopting a
second execution engine or replaying controlled effects.

## Decision

The current bin identifies itself explicitly as the source distribution,
including when linked. Operational user-runtime access requires
`AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1`; `AI_OFFICE_HOME` still selects the
destination. A future packaged entry point must declare its installed mode
instead of guessing from cwd or Git metadata. Local help remains available.
Source-linked `update` also remains available without operational opt-in: its
health-only maintenance preflight covers selected-user and distribution-development
hosts and never enables Runtime commands or SQLite access; see ADR-0011.

Development CLI, daemon and migration entry points derive their source root
from their own location. Project and global memory default to that root's
`.ai-office`. Explicit adapter-level overrides remain available for tests.
Caller-local argument semantics remain client-owned under ADR-0014.

Queued run admission atomically compares the application-observed task, agent,
pipeline and lease facts, writes `preparing`, and appends its immutable event.
The event includes the Runtime instance ID, using the existing extensible JSON
payload; no table migration is needed. Historical events without that field
remain valid. Resource policy still performs its own fresh authorization.

One persistent Runtime owns ephemeral execution/cancellation handles. It reserves
the handle before admission, releases it after execution/cleanup, and drains
outstanding command work during graceful shutdown before releasing the socket.
Persisted status and owner evidence survive restart; ephemeral handles establish
which runs this host still observes. A response timeout is not cancellation.

Run cancellation requests stopping; it cannot assert that an unresponsive worker
has stopped. Approved reconciliation rechecks persisted evidence and resolves
orphaned work without replay. It refuses ambiguous controlled effects and leaves
their action records intact. If terminal state persistence fails, the execution
result is `interrupted`, not successful, and the task lock remains for recovery.

## Consequences

- Source-installed users must deliberately opt into personal-runtime operation.
- Development selection is stable within a checkout, including descendant cwd;
  moving a source checkout moves only its development-runtime location.
- No existing migration changes; event readers tolerate the additional field.
- Liveness depends on the current single-authoritative-host invariant and
  graceful draining, not on cryptographic authentication of the Unix user.
- Automatic retries, real worker heartbeat/deadline policies, native filesystem
  recovery and stronger isolation remain future work.

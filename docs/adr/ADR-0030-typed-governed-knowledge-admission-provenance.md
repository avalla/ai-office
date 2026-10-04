# ADR-0030: Typed governed knowledge admission provenance

- Status: Accepted
- Date: 2026-10-04
- Scope: AK-11, Native Agent Knowledge & CairnKeep Retirement

## Context

[ADR-0025](ADR-0025-native-agent-knowledge-store.md) made `AgentKnowledgeStore`
the native, non-authoritative store for project knowledge. AK-05 then admitted
new records only from a completed worker `AgentRun`. Durable knowledge learned
during project handover, or in an interactive Codex or Claude session, had no
admissible source: an agent could only report it to the user. The alternatives
were to fabricate a run so the record fit the model, or to model what actually
produced the knowledge.

## Decision

Provenance of native project knowledge is no longer necessarily an `AgentRun`.
A record is admitted from exactly one member of a closed, typed set, selected
explicitly and verified by the Runtime against authoritative project state:

```text
KnowledgeAdmissionSource =
    agent_run            a completed worker run of the project
  | handover             the project's current user-confirmed repository review
  | operator_confirmed   project evidence the Runtime resolves, confirmed by
                         the named operator at admission
```

Adding a source kind is an architectural change to this ADR, not a
configuration option.

## Principles

1. `agent_run` remains valid and backward compatible. Its plan shape, plan hash
   and record identity are unchanged, and existing records need no migration.
2. A handover is provenance only when the repository understanding was actually
   confirmed and is still current. A scan, an import, an agent interpretation
   or an approved office manifest is not a confirmation, and a confirmation
   whose repository evidence has changed is refused.
3. A confirmed handover review restored from a portable snapshot remains valid
   evidence while the Runtime still verifies it as the project's active review
   with a current fingerprint. Admission does not require that
   `handover:confirm` ran on the present Runtime.
4. Operator-confirmed knowledge cites evidence the Runtime can resolve and
   verify inside the project. Unverifiable references are rejected.
5. An identifier of an external Codex or Claude session is never provenance,
   evidence or a stored field. AI Office neither authenticates nor owns such a
   session.
6. The confirming operator is the current trusted-local actor. As
   [ADR-0027](ADR-0027-cross-domain-authority-and-evidence.md) states, a local
   actor label does not authenticate human presence; this ADR adds no
   authentication and claims none.
7. Provenance is part of the approved plan and of its hash. It cannot change
   between `knowledge:plan` and `knowledge:admit`, and it is immutable once
   admitted.
8. No `AgentRun`, task or agent is fabricated to satisfy the model. Non-run
   records carry none.
9. `AgentKnowledgeStore` stays non-authoritative. Provenance explains why a
   record was admitted. It does not turn knowledge into project authority,
   grant a capability, or make authoritative information admissible.
10. Only the Runtime validates and persists knowledge, through the existing
    plan, exact-hash approval and audit sequence.

## Consequences

- Handover and interactive work can produce governed knowledge without false
  run, cost or pipeline history.
- Provenance is stored as typed fields with the record rather than as a
  metadata blob; the knowledge schema evolves in place and authoritative
  SQLite/PostgreSQL state is unchanged.
- Evidence is verified when a plan is computed and again at admission. A record
  is not invalidated when a cited record later changes.
- The strength of `operator_confirmed` is bounded by the trusted-local model.
  Stronger operator-presence guarantees belong to the future boundary that
  ADR-0027 describes, not to this decision.
- Lifecycle operations on admitted records (supersede, relate, deprecate) are
  out of scope and must define their own rules for records without a task.

Current behavior is described in
[native agent knowledge](../development/agent-knowledge.md#admission-provenance-ak-11).

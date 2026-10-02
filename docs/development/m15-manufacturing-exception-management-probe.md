# M15-3 — Manufacturing exception-management design probe

Status: design probe, 2026-10-02. This synthetic scenario tests the
[M15-1 shared boundary](m15-shared-professional-model.md). It specifies no
machine-control interface, industrial deployment or production connector.

## Scenario and authority

ERP order `PO-204` at site `S-2` is due tomorrow. A WMS stock event indicates
that a required material lot is short. AI Office correlates a bounded ERP order
snapshot, BOM/routing reference and WMS inventory revision, creates an exception
task, asks a planner to evaluate alternatives, and escalates a rescheduling
proposal to a supervisor. If approved, a controlled ERP operation requests a
new planned date. The task closes only after the ERP confirms the exact order
revision and a human accepts the observed outcome.

The ERP owns the order, BOM and schedule; the WMS owns stock and movement facts.
An optional manufacturing domain projection normalizes identities, timestamps,
relationships and source revisions for queries. AI Office owns exception tasks,
runs, pipeline state, decisions, action intent and audit. No projection becomes
the source of record for inventory or production execution. PLC, OPC-UA, MES
command and safety-control surfaces are outside this probe.

| Stage            | Input and output                                                                                                                   | Required boundary                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Event admission  | `WMS/S-2/event-881` with event ID, source sequence, lot, quantity, timestamp and signature/transport validation result.            | Ingestion adapter authenticates source, deduplicates and checks site scope; model text does not emit trusted events.                      |
| Correlation      | Read `ERP/PO-204@rev12`, `BOM@rev5`, and `WMS/lot@seq881`; produce evidence links and a shortage hypothesis.                       | Source systems retain authority; conflicting or stale snapshots remain explicit.                                                          |
| Exception task   | One project task references order, site, affected operation and evidence revisions.                                                | Runtime owns task and pipeline transitions; repeated event does not create duplicate work.                                                |
| Analysis         | Planner proposes alternate material or revised date as artifact `P-1`; quality/safety implications are flagged.                    | Agent can recommend only from scoped reads; no automatic substitution or machine setting change.                                          |
| Review           | Qualified supervisor reviews `P-1` at its exact fingerprint; quality review is required if substitution changes approved material. | Department/site constraints and stable reviewer identities determine gates.                                                               |
| External request | Controlled ERP `reschedule_order` intent binds `PO-204@rev12`, new date, site and approved `P-1`.                                  | Recheck grant, connector version, order revision, current shortage, approvals and idempotency key immediately before one attempt.         |
| Reconciliation   | ERP response or later event reports new revision and date.                                                                         | Record observed outcome; ambiguous response stays unknown pending explicit reconciliation. Complete task only after accepted observation. |

This is exception orchestration, not direct process control. A physical or
safety-relevant change would require a separate deterministic domain service,
stronger preconditions, appropriate human approval and an industrial executor.
An LLM never receives PLC/MES/OPC-UA credentials or unrestricted write access.

## Failure probes

| Change or failure                                     | Expected Runtime decision                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Duplicate or out-of-order WMS event                   | Deduplicate by source event identity and sequence; keep history, reject stale projection updates, avoid a second task/action. |
| WMS and ERP disagree on lot or order state            | Mark evidence conflict and pause automatic progression until a trusted refresh or human resolution.                           |
| ERP order advances to `rev13` after approval of `P-1` | Treat the precondition as stale; block the `rev12` action and require renewed analysis/approval as policy requires.           |
| Site `S-3` agent requests `S-2` inventory or action   | Deny by effective tenant/project/site scope; no cross-site data in model context, error or audit payload.                     |
| Supervisor approves the proposal but has no ERP grant | Deny the controlled action; workflow approval does not mint capability.                                                       |
| ERP times out after request                           | Record one ambiguous attempt and reconcile by idempotency key and external state; do not automatically replay.                |
| Quality review is missing for a material substitution | Keep the pipeline at the required gate, even if a planner or LLM rates the change low risk.                                   |

## Core boundary exercised

Core owns project/task/run identity, event-to-work admission decisions,
versioned evidence and artifacts, pinned gates, capability evaluation,
controlled-action attempt and audit. Manufacturing definitions own order, BOM,
material, lot, site/department and exception vocabulary; source-system
correlation, quality rules, risk gates and typed ERP/WMS operations. The event
adapter owns authentication, deduplication input and bounded ingestion.
Historian or event-stream infrastructure handles high-frequency telemetry;
only the bounded facts needed for the exception enter AI Office authority.

The probe passes architecturally if the shortage event → source revisions →
exception task → `P-1` → supervisor decision → exact ERP attempt → observed
outcome chain is queryable, and every failure above has a deterministic
denial, pause or reconciliation state. Current connectors and typed evidence do
not implement that chain. A production pilot additionally needs industrial
security, safety, latency, reliability and integration assessments for the
specific site and systems.

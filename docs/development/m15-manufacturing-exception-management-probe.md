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

## Reference scenario and authority matrix

The material-shortage walkthrough above is one detailed path. The other two
rows test whether the same Project/task, source-version, artifact-review,
capability and outcome contracts remain usable. Site, department and work-cell
scope is a future policy input, not a claim of current Runtime isolation.
Source revisions and event IDs below are illustrative and must be verified by
the owning system's adapter before AI Office records provenance.
Every listed controlled operation additionally needs a scoped capability grant
and exact-action approval when policy requires it; workflow or professional
approval does not create either authority.

| Scenario          | Authoritative trigger and identity                                                                          | Domain scope and AI Office evidence                                                                                                                    | Proposal and required gate                                                                                                                                                      | Controlled operation and observed outcome                                                                                                                                        | Stale, conflicting or ambiguous path                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delayed order     | MES operation-delay event `MES/WC-4/seq240`; ERP order `PO-310@rev8` supplies committed due date.           | Project/site `S-2`, Production department, work cell `WC-4`; link the MES event, operation and ERP revision to one exception task.                     | Planner proposes a revised schedule artifact; supervisor reviews its exact version and approves any externally visible date change.                                             | If policy permits, a typed ERP schedule request targets `PO-310@rev8`; reconcile against ERP's new revision and the later MES observation.                                       | If ERP/MES disagree or the order revision changes, pause and refresh. Timeout leaves one unknown attempt for external reconciliation, not replay.                                                          |
| Material shortage | WMS stock event `WMS/S-2/event-881`, lot sequence `881`; ERP `PO-204@rev12` and `BOM@rev5` identify demand. | Project/site `S-2`, Logistics and Production, affected work cell; retain stock/order/BOM source anchors and a shortage claim with producer provenance. | Planner proposes alternate material or date in `P-1`; supervisor approves the exact version; Quality reviews any material substitution that crosses its threshold.              | This probe permits only a typed ERP `reschedule_order` request after gates. Observe ERP revision/date and later WMS stock facts; neither is replaced by an AI Office projection. | Duplicate/out-of-order WMS events do not create a second action. Stale ERP/BOM or contradictory stock pauses the task; unknown ERP outcome requires reconciliation.                                        |
| Abnormal scrap    | QMS nonconformity `NC-32@rev2` and MES batch scrap event `MES/WC-4/seq251`; CMMS history may add context.   | Project/site `S-2`, Quality and Production, work cell `WC-4`; retain QMS finding, MES event and any CMMS source versions as separate evidence.         | Quality proposes containment, CAPA or maintenance inspection as an artifact; Quality Manager reviews/approves it, with an additional safety gate if domain policy requires one. | A typed QMS CAPA request or CMMS inspection work-order request may be controlled; observe QMS/CMMS record IDs and status. No direct MES/PLC mutation is in scope.                | Revised scrap/batch facts or QMS status block a stale proposal. If QMS and MES disagree, request domain review; uncertain external creation is reconciled by external identity before any further attempt. |

### Authoritative systems

| System | Facts it owns for this probe                                                   | AI Office boundary                                                                                         |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| ERP    | Order, BOM, planned schedule, purchasing context and accepted schedule change. | Read versioned snapshots; request only a scoped typed ERP operation after the controlled-action gates.     |
| MES    | Production execution, operation/batch events and observed progress.            | Consume bounded authenticated event facts; no direct MES command or machine-setting mutation.              |
| WMS    | Inventory, lot stock and stock-movement events.                                | Consume versioned stock evidence; no inventory authority is copied into AI Office.                         |
| QMS    | Inspection, nonconformity, scrap determination and CAPA state.                 | Read exact records; a future typed CAPA request requires domain approval and observed QMS outcome.         |
| CMMS   | Maintenance history, work orders and inspection completion.                    | Read bounded history; a future typed work-order request requires its own grant and outcome reconciliation. |

AI Office remains authoritative only for its own exception task, run,
provenance, proposal artifact, review, approval, controlled-action attempt and
audit. It does not become authoritative for production, inventory, quality,
maintenance or machine state. Any physical or safety-relevant operation needs
a separate deterministic service and an explicit industrial safety assessment;
there is no unrestricted LLM-to-physical-control path.

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

In the target design, core owns project/task/run identity, event-to-work admission decisions,
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

## Domain-owner questions

These require answers from the site and source-system owners before a real
pilot; the probe does not assume an answer.

1. Who owns site, department and work-cell membership, and which identity can
   authorize a cross-department or cross-site exception?
2. Which ERP, MES, WMS, QMS and CMMS identifiers, sequence numbers and delivery
   guarantees establish event identity and ordering across retries?
3. Where do ERP schedule, MES progress, QMS scrap and CMMS machine condition
   overlap, and which system resolves a disagreement for each fact?
4. What quantity, quality and safety thresholds require planner, supervisor,
   Quality Manager or safety approval before a proposal or external request?
5. How are human qualifications, shift coverage, delegation and separation of
   duties verified rather than inferred from role names?
6. How old may an event or source snapshot be before an exception decision must
   pause for a fresh authoritative read?
7. How does each external system expose an idempotency key, receipt or query to
   reconcile a timeout or partially completed request without unsafe replay?
8. What retention, redaction and industrial audit rules apply to source events,
   derived evidence, proposals, operator decisions and error records?
9. What latency, availability and recovery requirements distinguish advisory
   analysis from time-critical production or safety control?
10. Which operations must never be triggered from an LLM-originated intent,
    even after a human workflow approval?

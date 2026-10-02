# M15-1 — Shared professional model boundary

Status: design assessment, 2026-10-02. This document records the evidence and
alternatives behind the [accepted architectural boundary in ADR-0027](../adr/ADR-0027-cross-domain-authority-and-evidence.md).
It does not change the Runtime, persistence,
portable snapshots, or supported domains. The [roadmap](roadmap.md#m15--domain-neutral-professional-work-and-vertical-profiles) owns milestone status.

## Objective and observed baseline

Reuse one authoritative work, policy, provenance, review, and audit model for
software, legal, and manufacturing work without treating a repository as a
prerequisite or weakening software behavior.

| Concern                  | Current repository evidence                                                                                                              | Boundary for M15                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project authority        | `Project` has an ID, name, description and timestamps; `CreateProject` also creates a `repo_<projectId>` association.                    | Keep `Project` as the authoritative top-level scope. A future non-repository creation path needs a real portable project identity independent of repository binding.                               |
| Work lifecycle           | `Task` is keyed by `ProjectId` and has a generic transition table; pipeline runs pin definitions and stages.                             | Reuse these state machines. Domain terms such as legal matter or production order remain domain records linked to a project/task, not aliases for `Task`.                                          |
| Obligations              | M5 requirements are project governance records with current software-oriented usage.                                                     | Preserve those records and links. A domain obligation may reference a task or requirement, but its meaning and fulfillment rule belong to the vertical until a shared invariant is proven.         |
| Repository compatibility | ADR-0008 distinguishes portable `repositoryId`, Runtime-local `projectId`, and checkout association.                                     | Preserve all existing repository identities, CLI lifecycle paths, snapshots and audit references. Never synthesize a fake repository binding for a new professional project.                       |
| Knowledge                | `KnowledgeScope` currently requires tenant and `repositoryId`; retrieval also resolves that identity.                                    | Add a stable non-repository project scope only through a versioned port and migration. Existing knowledge keys and provenance remain readable; a path or model-supplied ID is never trusted scope. |
| Artifacts and evidence   | ADR-0021 accepts exact artifact-version review as a conceptual cross-domain capability; the typed artifact aggregate is not implemented. | Specify a common version/provenance envelope before domain schemas. Do not claim artifact approval, evidence graphs or bounded correction loops currently execute.                                 |
| Storage and deployment   | SQLite is the only complete Runtime authority; PostgreSQL parity is partial (ADR-0022).                                                  | One application contract across Lite and Pro. No hybrid authority, edition-specific state machines or direct domain-store writes by agents.                                                        |

Source anchors: [`Project`](../../packages/domain/src/project/project.ts),
[`CreateProject`](../../packages/application/src/commands/create-project.ts),
[`Task`](../../packages/domain/src/task/task.ts),
[`RepositoryIdentityRepository`](../../packages/application/src/ports/repository-identity-repository.port.ts),
[`KnowledgeScope`](../../packages/application/src/ports/agent-knowledge-store.port.ts),
[ADR-0008](../adr/ADR-0008-repository-local-project-binding.md),
[ADR-0021](../adr/ADR-0021-artifact-review-and-approval-workflow.md), and
[ADR-0022](../adr/ADR-0022-project-storage-adapters.md).

## Proposed ownership

`Project` remains the single Runtime authority scope for tasks, agents, policy,
governance, audit and configuration. Its current ID stays Runtime-local. A
future portable **project identity** is distinct from both that ID and the
existing repository identity. Repository binding is an optional software entry
path, with its own lifecycle and compatibility contract. A legal `Matter` or a
manufacturing `ProductionOrder` is a domain-owned record/reference within a
project; either may group several tasks, but neither creates a second task,
approval, capability or audit engine. Do not add a generic `WorkUnit` aggregate
until a concrete cross-domain invariant requires one.

```text
portable project identity -> Runtime Project (local projectId)
                               |-- tasks, runs, policy, audit
                               |-- optional repository identity -> checkout(s)
                               `-- domain-owned matter/order references
```

This is a target boundary, not a rename or reinterpretation of existing rows.
New creation, association and portable-state contracts require their own ADR,
forward migrations, SQLite upgrade tests, PostgreSQL parity where applicable,
and an explicit legacy snapshot reader. An old `repositoryId` stays valid and
keeps its meaning. A non-repository project must work without a checkout,
scanner, coding-client skill or fabricated `repo_` identity.

### Core and vertical responsibilities

| Core authority                                                                                                                  | Vertical or adapter responsibility                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Project/task/run identity and lifecycle; pinned pipeline definitions and deterministic transitions.                             | Matter, order, lot, party, issue and other domain identities; labels and structured domain state.                |
| Immutable source/artifact version envelope, lineage, actor/run attribution, queryable audit.                                    | Source-location grammar, extraction rules, evidence or claim status vocabulary, artifact schemas and validators. |
| Exact-version review binding and approval checks; separation of governance, stage, artifact, professional and action approvals. | Required reviewer qualifications, independent review rules, domain checkpoint placement and stronger policy.     |
| Deny-by-default capability evaluation, controlled-action authorization, preconditions and at-most-one execution attempt.        | Typed connector operations, domain preconditions, external-system observation and reconciliation.                |
| Trusted tenant/project scope and access decisions.                                                                              | Matter or site/department restrictions that only narrow effective access.                                        |

This establishes reusable semantics for any future vertical packaging. Such
packages may contribute defaults, but neither a package nor a prompt becomes
an authority source.

### Terms used by both probes

| Term                                             | Meaning in this assessment                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project`                                        | Runtime authority root. Its local `projectId` is not a portable identity or a repository identity.                                                                            |
| Source version and source anchor                 | A trusted registration of one external revision/fingerprint, and a typed locator that resolves within that exact revision.                                                    |
| Claim/evidence                                   | A domain-defined assertion and its supporting or contradicting source anchors; a model suggestion is not verification.                                                        |
| Artifact version and review                      | An immutable output fingerprint and findings bound to that exact fingerprint; review alone is not approval.                                                                   |
| Professional approval                            | A domain-required human decision on an exact subject/version. Qualification and authenticated presence require their own evidence; a role label is insufficient.              |
| Controlled-action approval                       | Authorization for one exact protected action after its required checks. It is separate from artifact, pipeline, governance and professional approvals.                        |
| External attempt and observed/reconciled outcome | One controlled execution attempt and the later external-system observation, including an explicit unknown state when the effect is ambiguous.                                 |
| Domain scope and capability/grant                | Matter, site or department restrictions narrow trusted tenant/project scope. A capability grant is separate Runtime authority and cannot be supplied by a domain declaration. |

## Minimum source, evidence and artifact contract

The following is a design contract, not a TypeScript API or storage schema.

| Record              | Minimum facts                                                                                                                                              | Rule                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source version      | Trusted project scope, source-system/connector identity, opaque source ID, immutable revision or content fingerprint, capture time, access classification. | A URL, pathname or model-generated citation alone does not establish source identity. Retain the source system's authority and access rules.                       |
| Source anchor       | Source-version ID, typed locator (page/paragraph, row/key, event ID/sequence, commit/path/line, etc.), selector version.                                   | Locator must resolve against the recorded revision or be marked unresolved. Domains define precision; core stores the typed opaque anchor and validates ownership. |
| Claim/evidence link | Assertion/version, supporting or contradicting source anchors, extraction/transformation ID, producer run or human actor, verification state and reviewer. | Model confidence is advisory metadata. Domain status such as `alleged`, `disputed` or `established` never automatically grants approval.                           |
| Artifact version    | Stable artifact ID and version/fingerprint, producer, input claim/source versions, project/domain type, classification.                                    | A new fingerprint makes prior reviews non-current for that version; historical records remain inspectable.                                                         |
| Decision            | Exact subject/version, policy revision, actor identity, role/qualification evidence when required, verdict, time and reason.                               | A review finding, professional sign-off, pipeline gate and exact action approval retain different subjects and scopes.                                             |
| External outcome    | Exact approved action intent, connector/resource identity and version, preconditions, attempt ID, observed response and reconciliation state.              | An approved artifact never proves that an external side effect happened. Unknown outcomes do not replay automatically.                                             |

Lineage must be queryable in both directions: source revision and anchor →
claim → artifact version → review/approval → action intent → observed outcome.
If a source is superseded or an anchor can no longer be resolved, affected
claims and pending publication are flagged for domain revalidation. Historical
decisions are preserved rather than silently rewritten. Access to lineage is
filtered by the same tenant/project and domain scope as its content; audit
must not leak confidential text through previews, logs or error strings.

Retention, legal hold, redaction and export need explicit project/domain policy
contracts. A projection may omit or mask content, but cannot silently erase
authoritative provenance or claim that a held source was deleted. Export must
separate portable semantic state from credentials, grants, action approvals and
machine-local associations. The exact retention and deletion lifecycle remains
domain- and deployment-specific and is outside this design assessment.

## Compatibility and authority gates

1. Existing repository projects retain their IDs, associations, CLI behavior,
   snapshots and knowledge references. Generalization uses an explicit
   versioned reader/upgrade path, not an in-place semantic rename.
2. Project, task, pipeline, artifact, claim and action references validate
   ownership at the application boundary. Database foreign keys remain a
   backstop. A matter/site scope can narrow access but cannot grant a missing
   capability.
3. A vertical policy may require stronger gates, qualified humans or independent
   actors. The Runtime evaluates stable identities and evidence; a role label,
   LLM output or pack declaration does not prove identity, qualification or
   human presence.
4. Protected effects pass through controlled actions. Artifact or professional
   approval is a prerequisite when policy says so, and remains separate from
   the approval of one exact action. Revalidate current artifact/source version,
   grant, descriptor and external preconditions at execution time.
5. SQLite remains authoritative in Lite. PostgreSQL/Pro must reproduce the same
   contracts before becoming complete authority. Domain stores and external
   systems remain sources for their own facts; project authority does not move
   into those projections.

## Threat and privacy matrix

Each fail-closed behavior below is a requirement for the target design unless
marked current. Existing project ownership, deny-by-default capability checks,
exact filesystem-action approval and at-most-one action attempt are current;
generic source/claim/artifact records, domain scopes and authenticated human
presence are not. “ADR” means a focused decision is required before code or
schema changes, not that the mechanism already exists.

| Protected asset / boundary                  | Threat or privacy failure                                                                                 | Required owner / enforcement layer                                                                                      | Fail-closed behavior                                                                                                      | Decision maturity                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Confidential source → model context         | Unscoped document body reaches a prompt, retrieval result or worker.                                      | Application context assembly plus authorized source adapter; legal/manufacturing access rules narrow the trusted scope. | Omit content and deny the run/context request when scope or classification cannot be verified.                            | Future implementation + domain policy; current Runtime must not be described as matter/site isolated. |
| Audit, log and error output                 | Secret or confidential source text leaks through diagnostics, previews or generated views.                | Runtime serialization/audit policy and adapter error mapping.                                                           | Emit bounded identifiers and sanitized errors; withhold unsafe preview fields.                                            | Current secret-safe boundary; future evidence-specific projection rules.                              |
| Project, matter and site separation         | A principal reads or acts on another project, matter, site or work cell.                                  | Application ownership validation and capability policy; future trusted domain-scope resolver and identity provider.     | Deny cross-scope references and redact result details, including audit views.                                             | Current project checks; future domain policy and ADR for shared identity/scope.                       |
| Source revision and anchor                  | A superseded source or unresolved locator is treated as current evidence.                                 | Future source-version registry and domain verifier at application boundary.                                             | Retain history, flag dependent claims and block pending publish/action until revalidated.                                 | Future implementation; ADR for revision/invalidation contract.                                        |
| Source identity and citation                | A model fabricates a source ID, page or citation that appears authoritative.                              | Trusted connector registration plus application ownership and anchor-resolution checks.                                 | Reject unregistered IDs and unresolved citations; keep model text advisory.                                               | Future implementation + domain locator policy.                                                        |
| Domain-scope constraints                    | A pack, prompt or caller broadens matter/site access or downgrades risk.                                  | Core capability/policy intersection with trusted project and domain scope.                                              | Deny the request or incompatible configuration; no default grant.                                                         | Current deny-by-default principle; future scope composition requires ADR.                             |
| Reviewer and approver identity              | Role-label substitution, forged human presence or same-principal “independent” review.                    | Future authenticated identity/qualification boundary and Runtime separation-of-duties check.                            | Do not accept the decision or advance the gate without verified principal and qualification evidence.                     | Requires security/identity ADR; current same-UID host cannot prove human presence.                    |
| Artifact version                            | Approval for one draft/proposal is reused after the fingerprint changes.                                  | Future artifact-review authority per ADR-0021, enforced by application transitions.                                     | Historical review remains visible but is non-current; require review/approval of the new version.                         | Accepted design direction; future implementation.                                                     |
| Grant versus workflow/professional approval | A signed-off artifact or stage is mistaken for permission to use a connector.                             | Current controlled-action gateway and capability policy; future artifact/professional gate composition.                 | Deny without current scoped grant and exact-action approval where required.                                               | Current action boundary; future cross-domain gate binding.                                            |
| External side effect                        | Timeout or partial response triggers a second filing, send or ERP operation.                              | Controlled-action execution ledger and typed connector reconciliation.                                                  | Record unknown/ambiguous outcome; never replay automatically; require observed external state or explicit reconciliation. | Current one-attempt principle; future domain connector behavior.                                      |
| Retention, redaction and legal hold         | Redaction hides evidence improperly, deletion violates a hold, or retention preserves prohibited content. | Future project/domain policy with authoritative storage and source-system owner; audit projection.                      | Block conflicting deletion/export, preserve minimum provenance, and surface a policy conflict for human resolution.       | Domain policy + focused ADR before storage behavior.                                                  |
| Portable export and backup                  | Credentials, grants, action approvals or machine-local associations travel with semantic state.           | Current portable snapshot exporter; future non-repository identity/export contract.                                     | Exclude non-portable authority and fail on unknown sensitive fields rather than silently copying them.                    | Current exclusion boundary; ADR for generalized project portability.                                  |

## Decision register

“Accepted for M15 assessment” selects design direction only; it does not make
an unimplemented Runtime feature current or accept a storage migration.
[ADR-0027](../adr/ADR-0027-cross-domain-authority-and-evidence.md) settles the
four authority/evidence decisions marked below. The other entries retain their
assessment maturity and may need later decisions.

| Decision                                                                                       | Status                                     | Consequence or next decision                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Keep `Project` as the single Runtime authority root.                                           | Accepted for M15 assessment                | Preserve task/pipeline/audit ownership and existing project IDs.                                                                      |
| Give non-repository projects a portable identity distinct from `projectId` and `repositoryId`. | Accepted by ADR-0027; not implemented      | A tagged portable key preserves legacy repository readers; implementation must specify creation, uniqueness and new snapshot format.  |
| Make repository binding optional and software-specific.                                        | Accepted for M15 assessment                | Keep current install/CLI/checkout behavior; ADR-0027 defines the new identity boundary, while lifecycle implementation follows later. |
| Add a generic `WorkUnit` aggregate now.                                                        | Deferred                                   | Reconsider only if both probes expose an invariant that cannot be owned by Project, Task or a domain record.                          |
| Use a generic source-version, anchor and provenance envelope.                                  | Accepted for M15 assessment                | ADR-0027 accepts the envelope; specify locator resolution and invalidation before schema work.                                        |
| Keep claim/evidence truth states and verification rules domain-owned.                          | Accepted for M15 assessment                | Core stores lineage and enforces declared gates without a universal truth-state machine.                                              |
| Bind artifact review and approval to an exact version/fingerprint.                             | Accepted for M15 assessment                | ADR-0021 provides the conceptual decision; artifact storage and correction-loop implementation remain deferred.                       |
| Treat role labels as proof of qualification or human presence.                                 | Rejected                                   | Require a trusted identity/qualification decision; current trusted-local same-UID routing is insufficient for a legal pilot.          |
| Define qualification, delegation and authenticated human-presence evidence.                    | Accepted by ADR-0027; not implemented      | Keep domain qualification rules outside core; bind verified principal and presence evidence to exact professional decisions.          |
| Route protected external effects through controlled actions.                                   | Accepted for M15 assessment                | Preserve scoped grants, exact-action approval, preconditions, one attempt and explicit reconciliation.                                |
| Generalize AgentKnowledgeStore scope beyond `repositoryId`.                                    | Accepted by ADR-0027; not implemented      | Version the trusted scope while preserving tenant, old repository knowledge keys and provenance.                                      |
| Compose mandatory evidence and domain-scope constraints.                                       | Accepted by ADR-0027; not implemented      | Qualify and conjoin mandatory clauses; intersect allowed scopes; reject unknown or incomparable rules.                                |
| Define retention, redaction, legal hold and confidential export policy.                        | Requires focused ADR before implementation | Domain rules may strengthen restrictions; storage/export semantics and conflicts need explicit treatment.                             |
| Change storage schemas or portable snapshots in this assessment.                               | Deferred                                   | Use forward migrations, representative upgrades, SQLite/PG contract parity and versioned snapshot readers in later tasks.             |
| Give a matter/order a synthetic repository identity as a compatibility shortcut.               | Rejected                                   | Avoid misleading source-code semantics and knowledge scope.                                                                           |

## Input to GP-01, GP-02 and proposed ADR-0026

GP-01 should classify repository association/scanning and coding-client files
as software entry paths; Project/Task/Pipeline and capability/action authority
as core; source/artifact envelopes as future core contracts; and claim states,
matter/order/site vocabulary and source locators as domain definitions or
adapters. It must review the current knowledge `repositoryId` dependency and
not classify a desired future envelope as implemented code.

GP-02 must compare the proposed ADR-0026 pack contract with the four decisions
in ADR-0027 before accepting or revising it. The earlier assessment found no
direct contradiction with project-owned configuration, immutable pack defaults,
pinned runs, deny-by-default grants or legacy repository compatibility. It did
leave portable identity, knowledge scope, mandatory evidence/domain-scope
composition and trusted professional principals open; ADR-0027 now defines
their architectural contracts. This assessment does not accept ADR-0026 or
start pack implementation.

## Alternatives and decision sequence

- **Rename `Project` to `Workspace` now:** rejected for this assessment. It
  changes vocabulary without removing repository coupling in creation,
  portability and knowledge, and risks misreading old state.
- **A second generic work-container aggregate beside `Project`:** defer. It
  duplicates ownership and creates two roots for tasks, policy and audit before
  either probe demonstrates a needed second invariant.
- **A facade that gives every matter/order a synthetic repository identity:**
  rejected. It conflates portability with source-code binding and makes legacy
  contracts misleading.
- **Keep the current top-level `Project` and split optional repository binding:**
  preferred. It preserves authority and lets non-repository work enter through
  explicit new contracts.

ADR-0027 accepts the shared authority/evidence boundary after the
[legal](m15-legal-design-probe.md) and
[manufacturing](m15-manufacturing-exception-management-probe.md) probes. Later
implementation slices must sequence portable identity, creation and knowledge
scope; generic source and artifact contracts; domain policy hooks; and
connector implementations, each with its own compatibility and security tests.
Any later vertical-pack design must consume that decision without assuming
this assessment changed the Runtime.

## Probe acceptance

The same project/task/run, review, capability, action and audit contracts must
explain both probes without legal or manufacturing branches inside the core.
Each probe must show one success path and fail-closed paths for stale source or
artifact versions, insufficient authority, and ambiguous external outcomes.
The software repository path and old snapshot/knowledge identities must remain
valid. These are design checks; executable contract and upgrade tests belong to
the later implementation slices.

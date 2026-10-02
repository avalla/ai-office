# M15-1 — Shared professional model boundary

Status: design assessment, 2026-10-02. This document defines the proposed
compatibility boundary for M15. It does not change the Runtime, persistence,
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

Before production implementation, accept or revise this boundary in a focused
ADR after the [legal](m15-legal-design-probe.md) and
[manufacturing](m15-manufacturing-exception-management-probe.md) probes. Then
sequence portable identity, creation and knowledge scope; generic source and
artifact contracts; domain policy hooks; and connector implementations as
separate slices. Any later vertical-pack design must consume the accepted
decision, not assume that this assessment already changed the Runtime.

## Probe acceptance

The same project/task/run, review, capability, action and audit contracts must
explain both probes without legal or manufacturing branches inside the core.
Each probe must show one success path and fail-closed paths for stale source or
artifact versions, insufficient authority, and ambiguous external outcomes.
The software repository path and old snapshot/knowledge identities must remain
valid. These are design checks; executable contract and upgrade tests belong to
the later implementation slices.

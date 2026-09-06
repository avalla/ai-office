# Professional-work verticals

## Status and purpose

This document describes a future product direction owned by roadmap M15. It is
not current implementation truth and does not redefine the existing `Project`
aggregate, repository lifecycle, software governance model, or supported
integrations.

AI Office is software-development-first today. The purpose of the vertical model
is to preserve that investment while testing whether the orchestration,
capability, approval, provenance, artifact, and audit foundations can become a
reusable professional-work kernel.

The target shape is:

```text
AI Office core
  |-- organization and roles
  |-- work orchestration
  |-- policy and capabilities
  |-- provenance and evidence
  |-- artifacts
  |-- reviews and approvals
  |-- controlled actions
  `-- audit
        |
        +-- software-development vertical
        `-- future professional verticals
              `-- legal reference vertical
```

The core must not become a bag of the union of every vertical's concepts. A
vertical contributes domain vocabulary, schemas, templates, integrations, and
stronger policy while reusing core authority.

## Boundary with the current software model

The software-development direction includes implemented concepts and future
delivery work that should remain explicit:

- repository-local project identity and checkout binding;
- repository scan and handover;
- ADRs, requirements, tasks, reviews, and the sequential pipeline enforcement
  foundation; complete software delivery pipelines remain future M14 work;
- coding-client integration;
- GitHub as the planned external delivery connector;
- code intelligence and context assembly on the roadmap.

Generalization must not make these concepts vague merely to look generic.
Instead, future design should identify which current concepts are:

1. genuinely core;
2. reusable through a domain-neutral interface;
3. software-vertical extensions;
4. compatibility surfaces that must remain stable even if a more general model
   is introduced.

No schema rename should occur solely to make terminology appear neutral.

Compatibility must preserve the distinction between portable `repositoryId`,
runtime-local `projectId`, and canonical checkout associations established by
[ADR-0008](../adr/ADR-0008-repository-local-project-binding.md). Existing
non-Git directory support does not make `Project` a generic matter model.
Existing snapshots must remain readable under their versioned contracts;
generalization must not transfer grants, action approvals, or audit authority
through portable state. See
[Project portability and synchronization](project-portability-and-sync.md).

## Candidate generic concepts

The following vocabulary is intentionally provisional:

| Generic concern | Current software example | Legal reference example |
| --- | --- | --- |
| work container | project | matter / case file |
| work item | task | legal activity |
| obligation / acceptance | requirement | issue, obligation, element to establish |
| event / checkpoint | milestone | hearing, filing date, procedural phase |
| source | repository/documentation | contract, email, filing, authority |
| evidence / claim | repository fact / finding | fact, allegation, cited proposition |
| artifact | patch/review result | draft, memo, chronology, filing package |
| role | architect/developer/reviewer | researcher/drafter/reviewer |
| pipeline | feature/release workflow | research/draft/review/filing workflow |
| external action | push/PR/merge | send, file, disclose, calendar action |

These mappings are product-analysis aids, not declarations that the entities are
semantically identical. A legal fact is not a software requirement wearing a
different label, and an ADR is not a universal decision record merely because
both contain text and timestamps.

## Provenance and evidence

Professional verticals need provenance stronger than "the model said so".
The generic design should be able to answer, for an important assertion:

```text
claim
  |-- source identity and revision
  |-- source location
  |-- extraction / transformation provenance
  |-- producing agent and stage run
  |-- model / runtime metadata where applicable
  |-- verification status
  |-- reviewer
  `-- approval state
```

Verticals may define their own evidence states. A legal vertical might need
`alleged`, `supported`, `disputed`, and `established`; another domain may use a
different vocabulary. The core should provide versioning, provenance,
relationships, policy hooks, and audit without pretending every domain shares
one truth-state machine.

Confidence scores are never a substitute for source verification or approval.

## Human authority

Human approval is a first-class workflow concept, not a prompt instruction.
Vertical policy must be able to distinguish at least:

```text
generated
  -> reviewed
  -> approved
  -> externally communicated / executed
```

Not every domain needs every state, but a vertical must be able to prohibit
unsafe shortcuts. The core pipeline engine enforces the declared gate; the
vertical decides where the gate is required; the model does neither.

The design must preserve the separate meanings of:

- M5 governance review;
- M6 controlled-action approval;
- pipeline-stage approval;
- domain-specific professional approval.

A future design may compose these approvals, but must preserve each approval's
subject, artifact revision, approver identity, scope, and invalidation rules.
Review or professional approval never grants a capability or substitutes for
approval of one exact controlled action.

## Vertical plugins and profiles

A future plugin/profile boundary may provide:

- domain vocabulary and presentation;
- structured artifact schemas;
- pipeline templates;
- role templates;
- domain-specific validation;
- connector descriptors and adapters;
- stronger policy presets;
- retention and redaction requirements;
- import/export projections.

It must not provide an alternate:

- pipeline state machine;
- capability engine;
- action-approval engine;
- audit ledger;
- hidden credential store;
- source of authority for core lifecycle state.

The M9 plugin SDK should therefore be assessed as part of M15 rather than
inventing a legal-only extension mechanism.

Profile policy can narrow effective authority, never grant capabilities or
weaken operator or connector restrictions. Provenance and audit remain owned by
the Runtime; vertical schemas extend their records through explicit contracts.

## Legal reference vertical

### Why legal is a useful reference

Legal work is deliberately demanding. It combines confidential source
materials, contested facts, external authorities, deadlines, independent
review, irreversible communications, and human professional responsibility.
If the generic boundary survives that pressure without becoming legal-specific,
it is probably becoming useful rather than merely generic-looking.

The legal reference vertical is a design probe, not a claim of legal readiness.

### Illustrative matter model

```text
Matter
  |-- parties
  |-- tasks
  |-- deadlines / events
  |-- source documents
  |-- facts / claims
  |-- evidence links
  |-- legal issues
  |-- research authorities
  |-- drafts / artifacts
  |-- reviews
  |-- approvals
  `-- audit trail
```

An assertion should be able to preserve a source relationship such as:

```text
Fact / proposition
  |-- status
  |-- supporting sources[]
  |-- contradicting sources[]
  |-- source locations[]
  |-- extracted_by run
  |-- reviewed_by
  `-- supersedes / superseded_by
```

Exact entities and lifecycles require a legal-domain assessment before
implementation.

### Illustrative roles

- **Legal researcher:** finds authorized primary/secondary sources and returns
  source-linked research artifacts.
- **Document analyst:** extracts entities, dates, obligations, and candidate
  facts without promoting them to established truth.
- **Evidence analyst:** builds chronology and evidence relationships and exposes
  contradictions.
- **Drafting agent:** creates a draft from authorized matter context.
- **Adversarial reviewer:** attacks the draft, identifies unsupported
  propositions, missing counterarguments, and evidentiary gaps.
- **Citation verifier:** resolves every material citation and source anchor.
- **Human lawyer:** owns professional judgment and any approval required by
  matter policy.

Roles are defaults, not authority. Capabilities and separation-of-duties policy
remain decisive.

### Illustrative pipeline

```text
intake
  -> source registration
  -> classification
  -> facts / chronology extraction
  -> legal issues
  -> authorized legal research
  -> draft
  -> adversarial review
  -> source / citation verification
  -> human lawyer review
  -> human approval
  -> controlled external action
```

The pipeline should support bounded remediation:

```text
draft
  -> adversarial review
  -> changes requested
  -> revise
  -> adversarial review
  -> citation verification
  -> human review
```

The engine owns deterministic loop bounds and state transitions. The legal
vertical supplies the artifact schemas and policy that make those stages
meaningful.

### Example controlled actions

Read-oriented integrations may include:

- document-management search/read;
- case-law or legislation search;
- docket/court-calendar read;
- matter-calendar read;
- approved client/matter data lookup.

Mutating or externally visible operations may include:

- sending a client communication;
- sharing a document externally;
- creating or changing a deadline;
- filing or submitting a document;
- disclosing evidence;
- deleting or redacting a source document.

These operations require connector descriptors, capability checks,
execution-time revalidation, audit, and domain-appropriate approval. An LLM tool
call is an intent, not authority.

### Candidate legal plugins

Legal-specific functionality belongs behind the vertical boundary, for example:

```text
legal/
  |-- conflict-check
  |-- case-law-search
  |-- citation-verification
  |-- contract-analysis
  |-- evidence-timeline
  |-- document-redaction
  |-- legal-hold
  `-- court-deadlines
```

Whether these become plugins, built-in profiles, or connector packages is an
M15/M9 design decision.

## Security, privacy, and professional responsibility

The current trusted-local security model is not automatically sufficient for a
law firm or another regulated professional environment. Production deployment
may require stronger guarantees around:

- tenant and matter isolation;
- identity and authenticated human presence;
- encryption and key management;
- least-privilege access and ethical walls;
- tamper evidence and external audit anchoring;
- retention, deletion, legal hold, and backup policy;
- data residency and processor/provider controls;
- redaction and confidential-data handling;
- external connector credential delegation;
- incident response and forensic audit.

M10 owns the generic hardening direction. A legal implementation must additionally
assess jurisdiction-specific professional, privacy, procedural, and contractual
requirements. AI Office must not represent generated output as legal advice or
professional approval merely because it was produced by a role named
`lawyer`.

## Design questions for M15 assessment

Before implementation, answer at least:

1. Does generic professional work need a new aggregate, a semantic facade over
   `Project`, or a separate work-container hierarchy?
2. Which current repository/project invariants must remain software-only?
3. What is the minimum generic source/evidence/provenance contract?
4. How are source revisions and stable locations represented across filesystem,
   document-management, database, and remote sources?
5. Which artifact types belong in the core versus a vertical?
6. How do vertical-specific truth/evidence states compose with generic review
   and approval without one universal state machine?
7. How do vertical policy presets make restrictions stronger without granting
   capabilities or weakening operator policy?
8. How are confidentiality scopes represented without building a parallel ACL
   system beside capabilities?
9. Which parts of portable project state generalize to a non-repository work
   container?
10. What compatibility contract allows existing software projects and snapshots
    to remain valid through any generalization?
11. Which security and human-authentication requirements are mandatory before a
    legal pilot?
12. What evidence demonstrates that a second vertical reuses the core instead
    of merely duplicating it under different names?

Durable answers should graduate into focused ADRs. This document remains
direction and assessment input; it does not select an implementation or
authorize M15 work.

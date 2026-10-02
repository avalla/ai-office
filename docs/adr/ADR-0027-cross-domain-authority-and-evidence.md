# ADR-0027: Cross-domain project authority and evidence

- Status: Accepted architectural boundary; implementation deferred
- Date: 2026-10-02
- Scope: M15-4 decision required before GP-02 reviews ADR-0026

## Context

The [M15 assessment](../development/m15-shared-professional-model.md) and its
[legal](../development/m15-legal-design-probe.md) and
[manufacturing](../development/m15-manufacturing-exception-management-probe.md)
probes need one Project, Task, pipeline, policy and audit authority for work
without a source-code repository. The completed
[GP-01 audit](../development/generic-core-domain-packs.md) found reusable
state machines alongside repository-specific creation, portable backup and
knowledge scope. [ADR-0026](ADR-0026-core-domain-pack-boundary.md) is still a
proposed Domain Pack contract; this ADR supplies its missing M15 authority
constraints, not acceptance of that proposal.

Today `Project.id` is a Runtime-local row ID. `CreateProject` also associates
`repo_<projectId>`; repository install and portable snapshot formats 1–4 use
`repositoryId` as their portable anchor. `KnowledgeScope` requires trusted
`tenantId` and `repositoryId`. Office manifests remain schema 1; PipelineRun
pins their exact revision and definition, and AgentRun pins execution facts.
Governance reviews do not bind an artifact version. [ADR-0021](ADR-0021-artifact-review-and-approval-workflow.md)
accepts exact-version artifact review conceptually, but typed source,
artifact, evidence and professional-decision authorities are not implemented.
The current trusted-local daemon cannot authenticate human presence from a
same-UID CLI call. SQLite is complete project authority; PostgreSQL is partial
under [ADR-0022](ADR-0022-project-storage-adapters.md). No Domain Pack Runtime
or generic non-repository creation path exists.

## Decision 1: Project authority and portable identity — Accepted

`Project` remains the single AI Office authority root for project-owned tasks,
roles, agents, runs, governance, configuration, capability grants, actions and
audit. `projectId` remains its Runtime-local identifier. A matter, production
order or site may group or scope work through a domain reference, but does not
own a second Task, pipeline, grant or audit engine.

The portable identity contract is a **tagged project key**:

```text
PortableProjectKey =
  { kind: "repository", repositoryId: existing opaque repository ID }
  | { kind: "project", projectUid: new opaque non-repository project ID }
```

The `repository` variant preserves the exact meaning of
[ADR-0008](ADR-0008-repository-local-project-binding.md). It remains the
portable key for existing repository projects and current repository install,
backup and restore. A new, explicitly created non-repository project receives a
Runtime-generated, collision-resistant `projectUid` in the separate `project`
namespace. Implementations must use a high-entropy generator and enforce
uniqueness in authoritative storage, retrying a collision without adopting the
existing project. That UID is immutable portable reconciliation metadata, not another
mutable authority root or a credential. Its exact wire encoding and generation
algorithm are later implementation details. Neither a domain record nor a Git
remote, path, title, pack, model or caller-provided value can mint the UID or a
`repositoryId`.

Within each trusted tenant boundary, one portable key maps to exactly one local
`projectId`, and each project has exactly one primary portable key. The same
key cannot designate two projects in a tenant, even after restore; a verified
repository association is a separate, explicitly unique relation.
The mapping and optional repository associations are authoritative
`ProjectStorage` state; a repository binding file remains a portable
participation signal, not a project database. A project may have no repository.
Attaching a verified repository later is an explicit, audited association; it
does not change a `project` key into a `repository` key, select a pack, or
change the project authority. Conflicting key, project, tenant or checkout
associations fail closed. The trusted deployment/request boundary supplies a
PostgreSQL tenant; a portable key never chooses tenant membership.

Creation of a non-repository project must use a separate Runtime command that
atomically persists Project and key, with no checkout, scanner, coding client or
fabricated `repo_` identity. Existing repository commands and
`CreateProject` retain their current semantics until explicitly versioned
replacements exist. Existing portable snapshot formats 1–4 remain strict and
readable as `{kind:"repository", repositoryId: manifest.projectIdentity}`;
their bytes and `projectIdentity` meaning do not change. A later format
version carries the tagged key for new projects. Restore validates key kind,
identity, project ownership and tenant context before creating or associating
a local row; a matching key permits only the existing explicit
import/reconciliation path and conflicting content fails closed. Restore never
guesses an identity from content or silently rewrites a different project.
Historical runtime-local `projectId` values are not made
portable. Converting a repository-keyed project to a project UID, if ever
needed, requires an explicit, audited compatibility operation retaining the
legacy alias and knowledge provenance. It is not a side effect of install,
restore, repository discovery or pack adoption.

## Decision 2: AgentKnowledgeStore scope — Accepted

The application port evolves through a versioned `KnowledgeScopeV2` carrying
a trusted tenant identity and the tagged `PortableProjectKey`. The Runtime
resolves the key from ProjectStorage for the current `projectId`; in shared
deployments the authenticated request/deployment boundary supplies tenant
authority. A model, caller-supplied path, pack or knowledge record cannot
select either value. [ADR-0025](ADR-0025-native-agent-knowledge-store.md)
continues to govern the secondary, non-operational knowledge store.

For `kind:"repository"`, the adapter maps to the **same**
`tenantId + repositoryId` namespace and historical keys used by the current
port. Existing records, imported legacy provenance, source links and query
semantics remain accessible without rekeying or inventing new origin. For
`kind:"project"`, the adapter uses a disjoint namespace keyed by
`tenantId + projectUid`; equal text in different key kinds never joins
records. An explicit future conversion may retain a validated legacy alias or
perform a reviewed migration; no implicit dual read, merge or provenance
rewrite is allowed.

An optional matter, site or other domain reference can only **narrow** a
trusted project scope. The Runtime resolves a project-owned, versioned scope
reference and applies its authorized policy; the adapter enforces the same
tenant, project key and narrowing filter on reads and writes and rejects
unresolved or cross-project references. A pack may declare knowledge
categories, schemas, seed references and retrieval guidance. It may not choose
tenant, project key, domain-scope identity, visibility or operational status.
Knowledge results remain advisory: unavailable optional retrieval may be
omitted with bounded diagnostic provenance, as today. A workflow requiring a
particular knowledge-backed source as **mandatory evidence** fails its gate
when the source or scope cannot be verified. It never broadens a query to keep
the run moving.

## Decision 3: Evidence and constraint composition — Accepted

Core owns a generic, project-bound and versioned envelope for source
registration, source revision/fingerprint and typed anchor, artifact version
and producer lineage, evidence references, exact-version review, policy
evaluation, decision and audit. A trusted adapter establishes external source
identity, revision, locator resolution and observed outcome; the external
system remains authoritative for its own content and effect. Core checks
ownership, immutable version links and currentness at required gates. Domains
own claim truth vocabulary, source-locator precision, verification algorithms,
artifact schemas and risk thresholds. There is no universal
`alleged → established` state machine. Model output can propose a claim or
artifact but cannot register a trusted source, verify evidence or approve it.
ADR-0021's exact fingerprint and stale-review rules apply to future artifacts;
M5 governance and pipeline approvals keep their distinct subjects.

Mandatory requirements are versioned, qualified policy clauses with stable
source identity: core invariant, selected pack ID/version/digest, or
project-owned policy revision. Each clause declares a known kind, subject,
scope and evaluator contract. For every selected configuration, the Runtime
normalizes clauses, validates all references and computes a deterministic
**conjunction** of all mandatory clauses. A project may strengthen them or
override documented optional defaults; it cannot disable a core invariant or
a mandatory clause of a selected pack. A pack may supply requirements but
cannot supply a grant, verified fact, trusted principal or approval. A project
may select no packs and declare its own domain policy.

Core-defined composition rules are narrow and explicit:

- Required evidence and approval predicates accumulate: every distinct
  qualified requirement must pass on the exact subject and source/artifact
  versions. A repeated stable requirement ID with incompatible meaning is a
  conflict, not a last-writer-wins override.
- Allowed tenant/project/domain scopes intersect; explicit denials accumulate.
  An empty intersection is invalid configuration.
- Numeric safety bounds compose only when the registered clause kind defines
  its order (for example the lower maximum age or upper minimum count). Unknown
  or incomparable bounds do not get an invented permissive order.
- A required capability provider is checked at configuration time, while a
  current project-scoped grant and exact protected-action approval are checked
  separately at execution. A declaration never creates either.

Unknown mandatory clause kinds, missing evaluators, unresolved source anchors,
conflicting semantics, inaccessible evidence or incomparable constraints fail
closed with sanitized, source-qualified diagnostics before a run/decision. The
effective policy and source revisions are deterministic derived evidence,
pinned to the relevant run or decision, not another mutable project store.
Before a protected effect, Runtime rechecks current evidence, grant, connector
descriptor, scope, required professional/artifact approvals and preconditions.
Historical decisions remain immutable; changed fingerprints make them
non-current rather than rewriting them.

## Decision 4: Professional decision principals — Accepted

Agent ID, AgentRun ID and project role assignment describe Runtime work and
permissions. They are not an authenticated human principal. A professional
decision that requires a person must bind a stable, authenticated principal
from a trusted identity boundary to the project, exact subject/version,
policy revision, verdict, decision time and a fresh **decision-bound**
human-presence assertion. The Runtime verifies the assertion's issuer, subject,
audience, scope, expiry and revocation status; neither the local OS UID, CLI
actor text, role name, prompt nor model output proves presence.

Where policy requires a qualification, the Runtime also verifies a trusted
attestation reference with issuer, principal, domain/role scope, applicable
jurisdiction or site, validity interval and revocation status. The domain
defines which qualification and reviewer independence are required; core
checks the declared rule against trusted evidence. Delegation is a separate
explicit, scoped, time-bounded and auditable authorization, permitted only
when the domain policy allows it. It never silently transfers qualification or
human presence. Independent review compares stable principal identities and
producer/approver links, not role labels; unknown identity or an unavailable
trust provider blocks the gate.

Current M5 review records and local CLI actor strings retain their historical
governance meaning. They are not automatically promoted to professional
decisions. The trusted-local same-UID daemon and current PostgreSQL tenant
membership/RLS do not authenticate a human decision. Until a trusted
principal, presence and qualification adapter plus Runtime verifier exist, a
workflow requiring these attestations cannot complete its professional gate.
This ADR does not select or implement an identity provider.

## Cross-cutting authority

| Subject                           | Authority and boundary                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project and portable key          | ProjectStorage owns the local Project and one mapping from a tagged portable key; the key reconciles state across runtimes but is not a second authority. |
| Repository or domain association  | ProjectStorage owns verified repository associations; a domain system owns its matter/order/site facts, with scoped references in project state.          |
| Task, PipelineRun and AgentRun    | Existing ProjectStorage-backed lifecycle and pinned execution records remain authoritative. Domain records never replace their transitions.               |
| Source version and anchor         | External source owns content; trusted adapter verifies identity/revision/locator; project authority records immutable reference and provenance.           |
| Artifact and evidence             | Future ProjectStorage-backed exact versions, lineage, review and gate outcomes; domain verifier owns truth semantics, not the model or a projection.      |
| Professional decision             | Future Runtime-validated exact-subject decision using trusted principal, presence and qualification evidence; independent of M5/stage/action approval.    |
| Capability grant and exact action | Existing deny-by-default policy and controlled-action gateway own grants, simulation, approval, one attempt and audit.                                    |
| External outcome                  | External system owns the effect; AI Office records observed or explicitly unknown outcome and reconciles without automatic replay.                        |
| Knowledge                         | AgentKnowledgeStore owns secondary advisory content under Runtime-supplied trusted scope; it never changes operational authority.                         |

Resolved pack/project configuration, read models, domain projections and
generated Markdown are derived views. None can create a project, grant,
evidence fact, approval or external result by being refreshed.

## Compatibility and security guarantees

Existing repository projects, schema-1 office manifests, local `projectId`
references, pinned runs, task/governance transitions, binding files and
snapshot formats 1–4 retain their current readers and meaning. Old knowledge
keys and provenance remain accessible under the repository scope. New identity,
scope, evidence and principal contracts require forward migrations, a new
snapshot version and representative SQLite upgrades; PostgreSQL must reproduce
the same application contracts and tenant/RLS isolation before it can host
complete Runtime authority. No migration, installation, import, repository
discovery or client detection implicitly selects a pack.

Tenant/project isolation, deny-by-default policy, controlled-action gateway,
exact-action approval, fencing, at-most-one attempt, immutable run evidence,
audit and sanitized errors remain core rules. Domain constraints may narrow
access and strengthen gates, never bypass them. Unknown or stale identity,
source, evidence, qualification or constraint inputs fail the relevant gate
closed. A failure of optional advisory knowledge alone does not erase
operational state. The trusted-local host is not a same-UID human
authentication boundary.

## Decision maturity and implementation handoff

| Decision                                                                                                                        | Maturity                                 | Consequence                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| One Project authority with tagged portable key and optional repository association                                              | **Accepted**                             | New non-repository projects use a distinct project UID; legacy repository keys retain their exact meaning. |
| Versioned knowledge scope with legacy repository namespace mapping                                                              | **Accepted**                             | Tenant and project key come from trusted Runtime state; optional domain scope only narrows.                |
| Generic versioned evidence envelope and conjunctive mandatory clauses                                                           | **Accepted**                             | Registered, deterministic composition and fail-closed validation precede any pack policy use.              |
| Trusted principal, decision-bound human presence, qualification and independence evidence                                       | **Accepted**                             | Professional gates remain unavailable until verifiable evidence reaches Runtime.                           |
| Synthetic repository IDs, a second generic work authority, model/pack authorization and role labels as qualification            | **Rejected**                             | They conflate identity, duplicate authority or weaken review.                                              |
| Universal claim truth machine, full identity provider, domain-specific locator/validator schemas and connector implementations  | **Deferred**                             | Domain owners and later focused slices select them without core branches.                                  |
| UID encoding, snapshot v5 schema, port/migration shapes, principal attestation protocol, clause registry and persistence tables | **Requires later implementation detail** | Contract, fresh/upgrade, parity and security tests are required before shipping.                           |

The architectural decisions above are accepted without claiming that the
target Runtime capabilities exist. M15-4 review and integration of this ADR
remain a project-planning prerequisite; GP-02 must subsequently compare
ADR-0026 against these decisions and accept or revise **that separate ADR**.
GP-02 stays blocked during this draft PR, and ADR-0026 remains Proposed.

## References

- [M15 assessment and decision register](../development/m15-shared-professional-model.md)
- [Legal](../development/m15-legal-design-probe.md) and [manufacturing](../development/m15-manufacturing-exception-management-probe.md) probes
- [GP-01 source audit](../development/generic-core-domain-packs.md)
- [ADR-0008 repository identity](ADR-0008-repository-local-project-binding.md)
- [ADR-0021 artifact review](ADR-0021-artifact-review-and-approval-workflow.md)
- [ADR-0022 ProjectStorage](ADR-0022-project-storage-adapters.md)
- [ADR-0023 tenant authority](ADR-0023-postgres-tenant-authority.md) and [ADR-0024 RLS](ADR-0024-postgres-tenant-authorization-rls.md)
- [ADR-0025 AgentKnowledgeStore](ADR-0025-native-agent-knowledge-store.md)
- [Proposed ADR-0026 Domain Pack boundary](ADR-0026-core-domain-pack-boundary.md)

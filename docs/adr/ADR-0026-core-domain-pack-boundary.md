# ADR-0026: AI Office Core / Domain Pack Boundary

- Status: Proposed — GP-01 reviewed; acceptance requires the M15 work/evidence decision
- Date: 2026-10-02
- Tags: domain-packs, architecture, compatibility, governance

## Context

The current Runtime already owns reusable tasks, AgentRuns, pipeline execution,
capability decisions, governance, audit, and storage ports. Its office manifest
still fixes software task kinds; onboarding assumes a repository; default roles,
pipelines, instructions, and some knowledge scopes assume software development.
M15 assesses cross-domain work, evidence, artifact, and authority primitives.
M16 must make domain semantics installable while existing installations continue
operating. See the [M16 audit and plan](../development/generic-core-domain-packs.md).

This ADR is a **reviewable GP-02 contract proposal**, not a statement that pack
APIs or storage exist today. The merged [M15 assessment](../development/m15-shared-professional-model.md)
chooses `Project` as the likely authority root and gives source/evidence rules,
but still labels that boundary proposed and calls for a focused accepted ADR.
GP-02 therefore cannot be marked accepted until that decision exists and this
contract is checked against it. [GP-01](../development/generic-core-domain-packs.md#gp-01-source-verification-and-compatibility-risks)
records the source audit behind this proposal.

## Proposed decision

### Core, pack, and project ownership

The core owns stable identities, project authority, runtime agents and runs,
generic task and pipeline state machines, policy evaluation, approvals,
controlled actions, audit, provenance, version binding, and storage/knowledge
ports. A pack supplies domain vocabulary and versioned **defaults**: role and
agent archetypes, task/artifact/evidence types, workflow templates, policy and
approval presets, knowledge categories and retrieval guidance, capability
requirements, validators, and prompts. An adapter supplies access to an
external system through a public application port or controlled connector.

The project owns instantiated roles, agents, pipelines, policy choices, prompts,
and all project overrides. A project may replace, extend, disable, or omit pack
defaults where the definition is semantically optional, and may add definitions
that no pack supplied. No official pack is mandatory. Effective security is
always bounded by core invariants: an override cannot grant a capability,
remove a required core approval, bypass tenant isolation, relax fencing, or
change audit/provenance and lifecycle rules.

Each resolved definition records five distinct ownership/provenance concepts:

| Ownership          | Meaning                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `core_owned`       | Runtime identity, lifecycle and enforcement contracts; never replaced by a pack or project.                                 |
| `pack_owned`       | Immutable template/default identified by pack ID, version, kind and definition ID.                                          |
| `project_owned`    | A definition created by the project independently of a pack.                                                                |
| `project_override` | Project-authored change to, replacement of, or disablement of a pack definition, tied to its source identity/version.       |
| `runtime_resolved` | Validated, deterministic effective view consumed by Runtime; carries source/provenance but is not an independent authority. |

The `ResolvedProjectConfiguration` name is provisional. GP-06 must check
whether an evolved, versioned office manifest and current pinned pipeline
definition already provide the right representation. Resolution must not create
a second mutable project store. The Runtime should consume generic effective
definitions and need no domain-specific role, task, or pipeline identity checks.

### Pack contract and extension mechanism

A pack has a canonical unique ID, immutable version, manifest/schema version,
core contract compatibility range, human-readable name and description,
declared dependencies, and typed declarative contribution sections. The
contract is compositional: independent role, workflow, artifact, policy,
knowledge, capability, prompt, and validator contributions share only the
identity/compatibility envelope. A giant central registry of all domain
behavior is not required.

The proposed public `DomainPackManifest` is strict UTF-8 JSON, schema version
`1`. IDs use lower-case reverse-DNS segments (`org.ai-office.development`),
versions are exact `MAJOR.MINOR.PATCH` values with no range or build metadata,
and digests are `sha256:<64 lowercase hex>` over canonical JSON with the
`digest` field omitted. Canonicalization sorts object keys and unordered
definition/dependency collections by qualified ID; workflow stages keep their
declared order. A pack cannot redefine an existing `(id, version)` with a
different digest. `coreContract` is an integer compatibility interval
`[minInclusive, maxExclusive)`, separate from product and manifest versions;
unknown schema versions and unsupported intervals fail validation.

```json
{
  "schemaVersion": 1,
  "id": "org.ai-office.development",
  "version": "1.0.0",
  "digest": "sha256:<64 lowercase hexadecimal characters>",
  "coreContract": { "minInclusive": 1, "maxExclusive": 2 },
  "metadata": {
    "name": "Development",
    "description": "Software delivery defaults"
  },
  "dependencies": [],
  "contributions": {
    "roles": [{ "id": "reviewer", "title": "Reviewer" }],
    "taskTypes": [{ "id": "feature" }],
    "workflows": [
      {
        "id": "delivery",
        "taskType": "feature",
        "stages": [{ "id": "review", "role": "reviewer" }]
      }
    ],
    "agents": [],
    "artifactTypes": [],
    "evidenceTypes": [],
    "policies": [],
    "knowledge": [],
    "capabilities": [],
    "prompts": [],
    "validators": []
  }
}
```

The example shows the envelope and qualified references; its digest is an
illustrative placeholder, not an installable manifest or a frozen schema for
the later GP-11–GP-16 sections. Each section gets its own strict validator
and documented project override rules. A dependency records exact pack ID,
version and digest; ranges and transitive implicit selection are excluded from
the first contract. A project may select zero, one or several versions, but at
most one version of a given pack ID. Definitions are addressed as
`pack ID / kind / local ID`; project-facing aliases are separate and must be
unique. Missing or conflicting references fail before scheduling.

Public manifest types, parsers and fixtures belong in a small
`packages/domain-pack-contracts` workspace package. The first official pack
can live in `packages/domain-pack-development` and import only that public
contract. `packages/domain` and `packages/application` retain the existing
dependency direction and cannot import an official pack package. Runtime
composition registers trusted installed packages through an explicit catalog;
there is no `require`, script path or executable entry in pack JSON.

Initial pack delivery is local and declarative. Packs do not download or run
arbitrary code. A future validator or integration requiring executable behavior
must be a separately installed, trusted adapter registered through an explicit
core extension point, with its identity/version, allowed operations, resource
scope, output contract, and failures checked by Runtime. Pack metadata can
_refer_ to such an adapter; it cannot smuggle code into policy evaluation or
receive direct storage or credentials. Official packs use the same public
contracts as external packs. Runtime composition may depend on trusted pack
packages, but `packages/domain` and `packages/application` cannot import them.

### Installation, binding, and deterministic resolution

The Runtime records a locally installed pack inventory (ID, version, digest,
schema/core compatibility and trusted package provenance) and project pack
bindings through `ProjectStorage` with forward migrations. Installed bytes
must match their registered digest at bootstrap; the inventory is an
availability allowlist, while the project binding is the authority to use a
pack. Filesystem/package presence alone does not change a project. An
operator previews and applies install, upgrade, detach, and reconciliation
through the Runtime; repeated application of the same intent is idempotent and
audited. Validation fails before a run for missing pack, incompatible core or
manifest schema, unmet dependency, unresolved identifier conflict, missing
required capability provider, or invalid project override. No new installation
path may infer a domain from Git, a coding client, or a tool list.

Resolution has fixed inputs: core contract version, selected pack IDs and
versions, pack digests, project-owned definitions and overrides, explicit
compatibility rules, and registered capability providers. It yields a stable
digest, origin map, and effective project configuration for identical inputs.
Running pipeline and AgentRun inputs remain pinned; a pack update cannot change
their in-flight semantics. Persist only authoritative inputs and the minimum
pinned execution evidence needed for recovery; a derived resolved view may be
recomputed and compared by digest.

The binding records exact `(id, version, digest)` tuples and the project
configuration revision. A new run records the effective digest and source
tuples alongside its existing immutable manifest/definition pins in one
authoritative transaction. This is a forward-only extension; schema-1 office
rows and older snapshots keep their current reader and meaning. Resolution
sorts pack tuples before merging definitions, rejects duplicate or unknown
qualified IDs and aliases, and never uses package discovery order as priority.
An empty selection resolves only project-owned definitions and core rules.

For example, a development project may bind only
`(org.ai-office.development, 1.0.0, sha256:<digest>)` and override its
`workflow/delivery` stage list; the override is tied to that source tuple and
survives an upgrade preview. A custom legal team may bind `packs: []` and use
only project-authored roles and workflows. If two selected packs both claim the
project alias `reviewer`, resolution reports both qualified sources and blocks
scheduling until the project chooses an explicit alias mapping. None of these
cases changes the task, run, approval or action state machines.

Each contributed identifier is qualified by pack ID, definition kind, and
local ID. Two versions of one pack, duplicate qualified IDs, incompatible
dependencies, or a collision in a requested project-facing alias fail with an
explainable conflict. There is no import-order winner. Multi-pack projects may
be staged, but the schema and resolver must allow explicit ordered-independent
composition. Project override precedence applies only to documented fields.
Governance and security constraints combine by intersection or an explicit
core-defined composition rule; incomparable constraints fail
closed. A pack cannot silently weaken another pack's or the project's gate.

Removal is previewed and blocked while active pinned runs or project-owned
references need that pack, unless an explicit migration maps those references
and passes validation. Retain audit, historical version identity, and
provenance after removal. Never delete project-owned definitions as an implied
side effect of pack removal.

### Pack upgrades and project customization

Upgrade reconciliation compares old pack template, new template, and project
definition/override for each stable definition ID:

| Case                                           | Required behavior                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Template changes, project never customized it  | Preview new default; apply only through an explicit, audited upgrade.                                                    |
| Template changes, project customized it        | Preserve project value; report the upstream change and any validation conflict for review.                               |
| Template removed, project did not customize it | Preview removal; block if an active or project definition still refers to it.                                            |
| Template removed, project customized it        | Retain the project-owned material as an explicit local definition or block pending a reviewed mapping; never discard it. |
| Project references an old definition/version   | Preserve pinned historical runs; require an explicit mapping or retained compatible definition for future runs.          |
| Two packs provide a conflicting ID/alias       | Fail validation until the project qualifies or explicitly resolves the conflict.                                         |

Every pack-sourced role, agent archetype, pipeline and stage, task/artifact
type, approval policy, prompt, validator, capability declaration, and knowledge
configuration needs documented project-level replacement, extension,
disablement, or override behavior where that operation is meaningful. A
project may create wholly new roles, agents, pipelines, and domain definitions.
Project changes are never rewritten by pack reconciliation. Changes to
effective security or mandatory evidence receive explicit validation and
audit rather than a permissive merge.

### Existing projects and empty/custom domains

Migration is additive:

1. Introduce public pack contracts without changing version-1 office behavior.
2. Add deterministic resolution alongside the existing manifest and pinned
   pipeline path.
3. Represent current development projects with a visible, versioned implicit
   development compatibility profile, preserving their stored manifests,
   agents, roles, pipelines, and authority.
4. Extract development defaults behind pack contracts, checking legacy and
   resolved configuration for semantic equivalence before removing coupling.
5. Offer an explicit, previewed migration to a development-pack binding; keep
   a compatibility reader for pre-pack state.
6. Consider explicit pack selection for newly created projects only once a
   pack-free project can create a complete office.

The development pack first reproduces current behavior. It receives no
privileged branch in task, pipeline, worker, knowledge, model-routing, queue,
approval, or storage logic. A project with zero packs can define custom roles,
agents, pipelines, artifacts, policies, and knowledge configuration through the
same public contracts. Existing repository bindings remain valid for legacy
projects; a generic non-repository project identity requires the M15 decision
and a versioned compatibility path, not a rename of `repositoryId` in place.

### Governance, knowledge, capabilities, and purity

Packs declare stricter approval and evidence requirements. Core enforces them
with existing governance, pipeline, artifact review, controlled-action and
audit mechanisms. Workflow approval, professional artifact approval, and exact
action approval remain distinct. Pack prompts and validators cannot authorize
an action. Artifact types extend the generic version/provenance contract from
M11.6; development commits and PRs remain domain evidence, never task-status
authority.

Pack knowledge categories, schemas, retrieval guidance, and seed references
use `AgentKnowledgeStore`; no second knowledge subsystem or pack-owned
operational authority is introduced. GP-15 must reconcile its current trusted
tenant plus portable `repositoryId` scope with non-repository projects without
breaking existing records or allowing a pack to choose tenant scope. Pack
capabilities name required or optional abstract operations. Registered
connectors/adapters satisfy those contracts; installation checks availability,
while actual use still requires project-scoped grants, constraints,
preconditions, approval, and controlled execution.

Validators in pack JSON are references to separately installed trusted adapter
IDs and exact versions, with an input schema, bounded output schema and
failure policy. Runtime registration checks identity, version, supported
artifact/evidence type, size and time limits before use; unknown, unavailable,
malformed or timed-out mandatory validation fails closed. An adapter receives
only the scoped input granted by its application port. It cannot decide a
professional approval, create a capability grant, or directly mutate
`ProjectStorage`. Protected effects still cross the controlled-action gateway.

Mechanical architecture tests reject core imports of official or third-party
packs and packs importing core implementation internals. Compatibility fixtures
cover old development projects; development, legal, manufacturing, and
empty/custom fixtures exercise the same Runtime contracts. Tenant/RLS checks,
fencing, pipeline guards, immutable AgentRuns, task transitions, and audit
provenance remain mandatory across all fixtures.

## Consequences and open decisions

- Pack specification and resolution become versioned public contracts with
  upgrade and compatibility obligations.
- Project customization and empty-pack operation are required product paths,
  not exceptions to a development default.
- The existing office manifest, repository identity, and knowledge scope need
  staged adapters or extensions; none is renamed or migrated by this ADR.
- GP-02 proposes exact manifest syntax, package layout, inventory/binding
  storage, validator adapter rules, compatibility versions and pinned evidence
  above. These remain reviewable choices until the M15 authority/evidence ADR
  is accepted. GP-03/GP-04 may refine field-level section schemas without
  changing these boundaries.
- A remote marketplace, dynamic downloads, untrusted code execution, new
  pipeline engine, ProjectStorage replacement, or new knowledge database is
  outside M16.

## References

- [M16 roadmap and plan](../development/roadmap.md)
- [Generic Core & Domain Packs audit and tasks](../development/generic-core-domain-packs.md)
- [Professional-work verticals](../development/professional-work-verticals.md)
- [Artifact review boundary](ADR-0021-artifact-review-and-approval-workflow.md)
- [ProjectStorage boundary](ADR-0022-project-storage-adapters.md)
- [AgentKnowledgeStore boundary](ADR-0025-native-agent-knowledge-store.md)

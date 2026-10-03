# M16 — Generic Core & Domain Packs: boundary audit and delivery plan

Status: M16 in progress. The GP-01 source audit was performed against `main` at
`7886519` and passed final repository review on 2026-10-02 against PR #80 at
`90c51cf`. [ADR-0027](../adr/ADR-0027-cross-domain-authority-and-evidence.md)
defines the four M15 authority/evidence prerequisites and was integrated in
PR #81. GP-02 completed their alignment review against
[ADR-0026](../adr/ADR-0026-core-domain-pack-boundary.md). GP-03 introduces
only the public [Domain Pack contract package](../../packages/domain-pack-contracts/README.md):
manifest types, strict parsing, canonicalization, digest verification and
contract fixtures. GP-04 adds a host-local installed-pack catalog and exact
dependency resolver, but does not activate packs for Runtime projects.
GP-05 adds explicit authoritative project selection, reviewable through
`project:pack:show`, `project:pack:preview` and `project:pack:apply`. It does not
activate pack definitions for Runtime execution.
The [roadmap](roadmap.md) owns milestone status; ADR-0026 is an accepted
architectural contract, not current Runtime behavior.

## GP-03 additive migration and compatibility plan

GP-03 adds a workspace contract package and no application, Runtime, storage,
CLI, migration or snapshot-reader integration. No SQLite or PostgreSQL data
migration is required. Existing OfficeManifest schema-1 rows, Project, Task,
PipelineRun and AgentRun states, repository bindings, and AgentKnowledgeStore
keys retain their current representation. Portable snapshots retain their
current readers and serialized bytes. No existing project acquires a Domain
Pack selection, and there is no installed-pack catalog or change in Runtime
semantics from loading the contract package alone.

This is the reusable primitive selected for GP-03 by ADR-0026: exact pack,
dependency and contribution identities, compatibility range, declarative
envelope and content digest. ADR-0027 accepts later generic project and
evidence boundaries but defers their storage and professional enforcement.
Adding task, artifact or evidence fields to current state machines here would
prematurely choose their GP-05/GP-14 semantics, so GP-03 preserves those
models and their schema-1 readers.

The existing schema-1 fixture and representative SQLite upgrade test cover
this additive boundary. GP-04 will define the installed-pack catalog and its
host-local availability state. GP-05 is the first task that persists
authoritative **project** Domain Pack selection; it owns the forward SQLite
and PostgreSQL migrations and upgrade tests for those bindings. GP-09 owns
later legacy-development compatibility when pack resolution reaches Runtime.

## GP-04 installed-pack catalog and availability resolution

GP-04 adds the public `InstalledDomainPackCatalog` read port and
`resolveInstalledPacks` application service. An in-memory Runtime-host adapter
registers exact UTF-8 manifest bytes supplied by a trusted local installer.
It checks the declared `artifactDigest` against those bytes, verifies the GP-03
schema-1 manifest and `manifestDigest`, checks the current integer core
contract, and requires an installer ID on the host's explicit trust list plus
an opaque nonempty installation reference. Runtime-host composition supplies
the trusted installer-ID set; manifest content cannot add an installer or make
the caller trusted. The reference is provenance and audit metadata, not proof
by itself. A valid digest does not establish trust. This trusted-local adapter
does not implement signatures, PKI or remote-registry trust. It copies the
installer-ID set and snapshots bytes and descriptors, so caller mutation cannot
alter trusted availability after registration.

The catalog records one immutable local artifact for each `(id, version)`.
Repeating the same bytes, digest and provenance is idempotent. A different
manifest digest, artifact digest, bytes or provenance for the same `(id,
version)` is a typed conflict. There is no discovery-order winner, version
range, latest-version choice, download, or automatic selection. In particular,
two byte-different manifests may canonicalize to the same `manifestDigest`;
their distinct exact-byte `artifactDigest` values still make them different
installed artifacts and registration conflicts. This preserves ADR-0026's
immutable `(id, version)` identity and GP-04's one-local-artifact rule. Catalog
state is process-local availability state. GP-04 defines the host-local
availability contract; no current Runtime path requires it to survive restart.
`ProjectStorage` is deliberately not used, and portable project snapshots do
not contain the catalog. A future durable deployment-local adapter may
implement the same port. Durable project selection begins in GP-05 and is a
different authority.

The public resolver accepts only caller-supplied exact `(id, version,
manifestDigest)` tuples. It gets the current core-contract version from the
trusted Runtime-composed catalog; project and pack metadata cannot select it.
The version is independent of the product version. It rechecks artifact
bytes, manifest identity, compatibility and trusted provenance on read, walks
exact manifest dependencies recursively, and returns each installed pack once
with its dependencies, artifact digest and local provenance. Output is sorted
lexically by `id`, then `version`, then `manifestDigest`; dependency lists use
the same order. Requests and catalog insertion order do not affect the result.
Typed errors distinguish missing requested packs or dependencies, wrong
digests, unsupported schema, incompatible core contracts, untrusted source,
duplicate registrations, conflicting versions and dependency cycles.
`resolveInstalledPacks` is the only supported production resolution API. Its
internal graph walk accepts already verified entries solely to exercise the
defensive cycle guard in tests. Because schema-1 manifest digests include exact
dependency identities, a naturally valid content-addressed cycle would require
a digest fixed point; the synthetic graph test does not claim such an artifact
exists. The guard remains useful for malformed catalog implementations, future
schema versions and defense in depth.

The port and resolver have no project ID, binding operation, `ProjectStorage`
dependency or scheduling hook. Registration and resolution cannot instantiate
roles, workflows, policies or capabilities and do not change existing
OfficeManifest schema-1 projects or Runtime execution. GP-05 adds durable,
explicit project pack binding. GP-06 owns effective resolved project
configuration. Still deferred: automatic selection, aliases and project
overrides, upgrade reconciliation, Development Pack extraction, install or
download marketplace, remote registry, executable validators,
KnowledgeScopeV2, and portable project UID persistence.

## GP-05 explicit project pack binding

`ProjectStorage.packBindings` records each project's exact selected `(id,
version, manifestDigest)` tuples and a checked `configurationRevision`. A
revision-zero empty selection is valid for existing and new projects. The
SQLite `0041` and PostgreSQL `20261002000100` migrations add separate binding
heads and tuple rows; PostgreSQL ties them to tenant/project ownership and RLS.
Neither schema stores artifact bytes, `artifactDigest`, installer provenance,
resolved dependency closure, or a default Development Pack. Historical
OfficeManifest rows and run pins are left unchanged.

The application service previews the current and proposed selection, added,
removed and changed tuples, and any GP-04 availability or dependency error.
Preview is read-only. Apply checks the expected revision, validates the exact
proposed tuples against the public GP-04 resolver, replaces the selection in
one transaction and appends a project audit event with previous/new revisions,
exact tuples, local operator actor and timestamp. A stale revision fails; an
identical selection at the current revision is a no-op even if its artifact is
now unavailable locally: it does not increment the revision or add an audit
event. A changed selection still requires fresh GP-04 validation. This keeps
persisted selection valid when host-local availability changes. Preview reports
valid selection conflicts and availability failures as issues; structurally
malformed tuples fail with a typed request error before a preview is returned.

GP-05 introduced portable archive format version 5, including
only the exact binding tuples and configuration revision. Readers for versions
1–4 remain; importing one yields revision zero and an empty selection. No
catalog entry, `artifactDigest`, provenance or credential is exported. The
current Runtime composes an empty installed catalog unless a trusted host
composition supplies registered artifacts, so a nonempty apply requires that
host to make the exact artifacts available. Removal only changes selection;
GP-08 owns reconciliation of later pack-owned definitions and references.

Effective resolved project configuration, aliases, pack
upgrade reconciliation, Development Pack compatibility/extraction, automatic
selection, remote marketplace/download, executable validators,
KnowledgeScopeV2 and portable project UID persistence remain deferred.

## GP-07 authoritative definition ownership and overrides

`ProjectStorage.definitions` is separate project semantic authority with a
checked revision. Project-authored entries are `project_owned` or
`project_override`; `core_owned` stays with core enforcement, `pack_owned`
names immutable pack source material, and `runtime_resolved` is a future
derived GP-06 view. Existing schema-1 OfficeManifest, role, agent, pipeline
and run-pin rows are untouched. No legacy row is classified as pack-owned and
no Development Pack is inferred.

An override source is exactly `(pack ID, version, manifestDigest, kind, local
ID)`. It must match the explicit binding and a verified installed definition
when authored. `project:definition:show` reports unresolved entries after a
binding or availability change; it never retargets or removes them. `preview`
shows the current entry, intended mutation, exact source, ownership transition
and typed issues without writing. `apply` requires the exact project definition
revision for **every** mutation. `put_owned` and `put_override` additionally
require `expectedEntryRevision` when replacing an existing entry; omitting it
means create only. `remove_owned` and `remove_override` use the exact project
revision as their destructive fence and do not accept an entry revision. A
concurrent project change makes the removal stale, even when it touches a
different entry. Duplicate create intents fail; there is no last-writer-wins
behavior. Mutation and its bounded audit event commit in one transaction.

Installed source bytes, trust and dependency closure are checked before that
transaction. Inside it, GP-07 rechecks the authoritative project revision and
selected pack ID, version and manifest digest. Host artifact availability is
not project authority and no host artifact or installer metadata is persisted.
Inspection keeps distinct, bounded issues for unavailable, untrusted,
incompatible and conflicting sources without exposing artifact contents.

For schema-1 contribution fields, GP-07 accepts project-owned descriptive
`roles`, `taskTypes`, `agents`, `artifactTypes`, `evidenceTypes`, `knowledge`
and `prompts`, plus typed project-owned `workflows` with `taskType` and stage
references. Workflow stage IDs, task type IDs and role IDs are checked for
syntax and duplicate stages now; whether the referenced definitions exist in
the eventual effective configuration is deferred to GP-06. GP-07 does not
resolve them against the legacy OfficeManifest or selected packs. A workflow
may declare at most 1,000 stages, the same bound portable archive format 6
enforces, so every accepted definition stays exportable. Mutation results and
later reads list entries in the same code-unit order on both storage backends.

Definition titles and descriptions follow one text rule, shared by GP-07
mutation validation and portable archive format 6: at most 16,000 UTF-16 code
units, no lone surrogate and no U+0000. Text is not normalized, and valid
non-BMP characters are accepted. The rule runs before storage, so SQLite and
PostgreSQL accept and reject the same text with the same typed diagnostic.

Previewing or applying a project-owned definition also checks the resolved
pack closure of the current binding, selected packs and their transitive
dependencies alike. A matching kind and local ID, compared exactly by code
unit, is reported as `pack_definition_collision` and nothing is written. The
check reads the closure through the same GP-04 resolution GP-06 uses and runs
before the mutation transaction. When the closure cannot be resolved the check
is skipped. GP-06 remains the authority: it rejects a collision that appears
later, for example after the binding changes or through restore.

| Schema-1 pack contribution                                           | `replace`               | `extend`                      | `disable`   |
| -------------------------------------------------------------------- | ----------------------- | ----------------------------- | ----------- |
| Roles, task types, agents, artifact types, evidence types, knowledge | Descriptive fields only | Absent title/description only | Unsupported |
| Prompts                                                              | Descriptive fields only | Absent title/description only | Supported   |
| Workflows, policies, capabilities, validators                        | Unsupported             | Unsupported                   | Unsupported |

`replace` supplies the complete schema-1 descriptive envelope; `extend` fills
only optional title or description fields missing from the exact source. An
empty extension or a change to identity or an existing source field is invalid.
Unknown fields,
capability grants, evidence/approval removal, scope changes, trusted-principal
claims, controlled-action bypasses and incomparable security merges fail
validation. Removing a project record only removes that record; it does not
change pack definitions, legacy office state, run pins or project pack binding.
The Runtime does not schedule from these entries yet.

SQLite migration `0042` and PostgreSQL migration `20261003000100` add
project-owned and exact-source override tables with project foreign keys,
revision heads and uniqueness. PostgreSQL adds tenant ownership and RLS under
the existing partial ProjectStorage provider rules. Successful changes audit
project, identity, origin, operation, exact source when present, revisions,
actor and timestamp without the definition body. Portable archive format 6
carries authoritative entries, including unresolved pinned overrides; formats
1–5 remain readable with their original meanings. Format 6 excludes installed
artifacts, credentials and resolved configuration.

GP-06 resolves these sources into an effective configuration and defines
its digest. GP-08 will handle pack upgrade reconciliation. Aliases, legacy
Development Pack parity/extraction, automatic selection, downloads, registry,
executable validators, KnowledgeScopeV2, portable project UIDs and Runtime
execution from pack definitions remain deferred.

## GP-06 derived project configuration

`ReadProjectConfiguration` reads the GP-05 binding and GP-07 definition state
inside one short ProjectStorage transaction. It reads both revisions twice; a
change in either interval fails with `stale_resolution`. The overlapping reads
also cover PostgreSQL's read-committed transactions. Installed pack resolution
and digest work run after the transaction. No resolved table, authoritative
cache, portable archive field, or scheduler switch is added.

The resolver takes the project ID, binding revision and exact tuples,
definition-state revision and entries, trusted installed catalog, and core
contract version explicitly. GP-04 checks trust, artifact bytes, manifest
digest, core compatibility, and exact dependency closure. GP-06 captures the
verified artifacts for definition extraction. Missing or changed artifacts
fail resolution without changing the binding or pinned overrides.

Effective IDs are `pack:<id>@<version>#<manifestDigest>/<kind>/<localId>` and
`project:<kind>/<localId>`. Project context is implicit, so a restored local
project row ID cannot affect the digest. Pack sources remain immutable. A
project-owned entry with the same kind and local ID as an entry anywhere in
the resolved pack closure, including transitive dependencies, is rejected;
distinct packs may use the same local ID under different qualified IDs. Every derived list uses one locale-independent order: pack sources in
GP-07's exact source tuple order (pack ID, version, manifest digest, kind,
local ID, compared by code unit), then project-owned entries in GP-07's
kind/ID order. Exact project overrides apply after independent project
definitions, using GP-07's replace, extend and prompt-disable matrix. No
import or registration order wins.

The resolver treats stored definition state as untrusted input. Each owned
entry and override is re-checked against GP-07's mutation contract (kind,
local ID, payload fields, workflow stage bound, entry revision) before it can
appear in the view; a violation fails with `configuration_invariant` or
`unresolved_override` and a diagnostic that names only the violated contract
code. As in GP-07, an override source must be an explicitly selected pack
tuple: a pack present only as a transitive dependency of the closure is not an
override source, and a duplicate selected tuple is rejected.

Schema-1 pack workflow references resolve only within the originating pack.
Project-owned schema-1 workflow references resolve only project-owned task
types and roles. Schema-1 workflow fields use bare local IDs and cannot encode
explicit cross-pack references; an ambiguous bare reference fails closed and
a single pack match is not inferred. Qualified cross-pack workflow syntax and
project-facing aliases remain deferred. Stage array order is preserved.
Missing or disabled required definitions fail resolution. The read view also
exposes the qualified task-type and ordered stage-role targets for each enabled
workflow.

The version-1 `configurationDigest` is SHA-256 of the UTF-8 string
`ai-office-project-configuration-v1\n` followed by RFC 8785 canonical JSON of
the derived material. It covers format and core contract version, binding and
definition revisions, sorted selected and resolved tuples, effective and
project-owned definitions, applied override IDs and revisions, origins,
disabled IDs, and qualified workflow targets. It excludes Runtime-local
project row ID, actor and edit timestamps, installer provenance, and artifact
bytes. Exact bytes and trust
establish validity; manifest digests and effective content establish
configuration identity. `pin` returns the digest, revisions, and exact tuples
for later run persistence.

The version-1 empty input vector (core contract 1, both revisions 0, no packs
or definitions) is
`sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19`.

Schema-1 policy contributions have descriptive fields but no typed mandatory
clause or evaluator. A nonempty policy section yields
`unsupported_security_composition` rather than an overrideable policy.
Evidence and capability names are descriptive declarations; they create no
verified fact, grant, or approval. ADR-0027's conjunctive gates, scope
intersection, accumulating denials, and ordered bounds need a typed policy
contract before they can govern execution.

`project:configuration:show --project <id> [--json]` returns the derived view
or a sanitized typed diagnostic through the Runtime socket. An unknown project
is reported as not found, like the other project commands. Empty bindings and
definitions resolve to a valid empty view. Existing OfficeManifest scheduling,
roles, agents, pipelines and run pins retain their current behavior.

## Objective and decision boundary

AI Office should operate governed teams in arbitrary domains. The core owns
identities, project authority, agents and runs, tasks, pipeline execution,
policy, controlled actions, approvals, audit, provenance, and storage/knowledge
ports. A Domain Pack supplies versioned **defaults and templates**, never the
effective configuration or a second authority. A project owns its role, agent,
pipeline, policy and knowledge choices; it may adopt several packs, one pack,
or no pack. Resolution produces a deterministic, validated project view for the
existing Runtime. Official packs receive no special core behavior.

This milestone follows the M11/M11.6 generic execution and artifact contracts,
M14's software-delivery behavior as extraction input, and M15's cross-domain
work/evidence and project-identity assessment. It uses the existing
`ProjectStorage` and `AgentKnowledgeStore` boundaries. M9's broad plugin SDK,
Pro/Supabase completion, and a remote pack marketplace are not prerequisites.

## Repository boundary audit

Classification is by _responsibility_, not by whether a file currently sits in
`packages/domain`. A file can contain both reusable mechanics and a
development-specific definition. The rows below record the GP-01 audit; the
source anchors and extraction order following the matrix make each boundary
independently reviewable.

| Classification                 | Current evidence                                                                                                                                                                                                                                                                                                                                         | Decision for M16                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CORE**                       | `packages/domain/src/project/project.ts` gives a named project ID; `task/task.ts` owns generic task states and transitions; `agent/agent.ts`, `agent/agent-run.ts`, `agent/agent-execution.ts` own runtime identity and run facts.                                                                                                                       | Keep identity, task and run lifecycle authority. M15 decides whether non-repository work needs a new container; do not rename `Project` to disguise semantics.                                       |
| **CORE**                       | `packages/domain/src/pipeline/pipeline-run.ts` pins manifest revision and definition, stage assignment, approvals, overrides and status; `packages/application/src/pipeline/*` orchestrates them.                                                                                                                                                        | Preserve one pipeline engine, pinning, guards, separation of duties, outbox/fencing and audit. Generalize only the definition source and task-type routing.                                          |
| **CORE**                       | `packages/domain/src/governance/governance.ts`, `packages/application/src/commands/manage-governance.ts`, and SQLite/PG governance schema own milestones, requirements, reviews and approvals.                                                                                                                                                           | Keep governance authority and separate its approvals from stage, artifact and controlled-action approvals. ADR records are software-flavored governance content; do not assume every pack uses them. |
| **CORE**                       | `packages/domain/src/capability/policy-engine.ts`, `packages/application/src/capability/*`, connector descriptors, and `packages/runtime-host/src/commands/capability.ts` enforce scoped grants and controlled actions.                                                                                                                                  | Keep deny-by-default decisions, exact-action approval, revalidation, and audit independent of pack metadata.                                                                                         |
| **CORE**                       | `packages/application/src/ports/project-storage.port.ts`, transaction runner, `packages/storage-sqlite`, `packages/storage-postgres`, `packages/storage-bootstrap`, daemon/Runtime host own authority; `AgentKnowledgeStore` remains secondary.                                                                                                          | Add pack binding only through versioned authoritative storage, with SQLite and eventual PG parity, tenant/RLS ownership, and unchanged transaction boundaries.                                       |
| **GENERIC ABSTRACTION NEEDED** | `packages/domain/src/office/office-manifest.ts` fixes `OfficeTaskKind` to `feature`, `bugfix`, `maintenance`, `research`, `release`; `defaultFor` and `packages/application/src/office/office-manifest-schema.ts` validate that closed list.                                                                                                             | Introduce versioned task-type and definition resolution while preserving schema-1 manifest reads and current routing. No mechanical rename of all task kinds.                                        |
| **GENERIC ABSTRACTION NEEDED** | The same office manifest embeds mutable project roles/pipelines, while `PipelineRun` pins a manifest revision. `packages/application/src/commands/apply-office-manifest.ts` stores immutable revisions.                                                                                                                                                  | Distinguish pack template, project definition/override, and effective pinned configuration without a second mutable authority.                                                                       |
| **GENERIC ABSTRACTION NEEDED** | `packages/domain/src/agent/role.ts` has project-owned role data and `sourcePath`; `packages/application/src/commands/sync-agent-definitions.ts` synchronizes role files; global role memory is separate.                                                                                                                                                 | Add origin/ownership and archetype instantiation semantics; keep runtime Agent/Role identities project-owned and configurable. Do not silently overwrite role or agent customizations.               |
| **GENERIC ABSTRACTION NEEDED** | `packages/application/src/ports/agent-knowledge-store.port.ts` scopes every record by trusted tenant and portable `repositoryId`; `packages/application/src/context/run-context-assembler.ts` injects bounded advisory results.                                                                                                                          | Retain the port and trust boundary. M15/M16 need a compatible stable scope for projects with no repository, preserving old keys and provenance.                                                      |
| **GENERIC ABSTRACTION NEEDED** | `packages/domain/src/capability/capability.ts` includes `github_repository` among closed resource types; connector descriptors already model operations, risks, constraints.                                                                                                                                                                             | Keep provider-specific resources in adapters; expose abstract required/optional capability contracts at pack validation, without granting them.                                                      |
| **GENERIC ABSTRACTION NEEDED** | M11 worker output in `packages/application/src/ports/worker-runtime.port.ts` is normalized text; `packages/application/src/commands/worker-agent-executor.ts` currently records an empty `artifacts` list. M11.6/ADR-0021 plans generic versioned artifacts and exact-review binding.                                                                    | Build pack artifact/evidence type and validator metadata on the accepted generic artifact contract; do not pretend the aggregate already ships.                                                      |
| **DEVELOPMENT PACK**           | `.agents/skills/ai-office/assets/default-office-manifest.json` supplies Software Architect, Developer, Reviewer, QA and feature/bugfix/release workflows with software checks.                                                                                                                                                                           | Move defaults into the development pack after preserving equivalent legacy manifest resolution. They remain replaceable by project definitions.                                                      |
| **DEVELOPMENT PACK**           | `packages/domain/src/project/project-profile.ts` lists `run_tests`, `create_branches`, `create_commits` as permission preferences; `packages/domain/src/agent/project-instruction-contract.ts` requires `repositoryMap`, testing and `codeChanges`; `packages/application/src/project-lifecycle/build-project-instructions.ts` writes software guidance. | Separate generic permission/configuration from software preferences and prompts. Existing contract and generated guides remain readable during migration.                                            |
| **DEVELOPMENT PACK**           | `packages/runtime-host/src/commands/requirement.ts` prompts an LLM to assess a “software requirement”; repository-local skill, `AI-OFFICE.md` projection, and documentation use software roles and tests.                                                                                                                                                | Pack-sourced assessment guidance and terminology; preserve M5 requirement state and advisory validation boundary.                                                                                    |
| **DEVELOPMENT PACK**           | `docs/development/roadmap.md` M13/M14 plans GitHub, commit/PR evidence, code review, CI and software-delivery pipelines; M15 already identifies these as vertical concepts.                                                                                                                                                                              | Extract through a development reference pack as those planned features arrive. A commit or PR remains domain evidence, never task-status authority.                                                  |
| **ADAPTER / INTEGRATION**      | `packages/application/src/commands/import-project.ts`, `packages/runtime-host/src/local-project-scanner.ts`, repository identity/binding ports, and `packages/application/src/project-lifecycle/*` treat checkout scanning and handover as the normal project lifecycle.                                                                                 | Keep repository install and scanner as the software/repository entry path. Add a non-repository project path only after M15 identity decision; never infer a pack from detected tools.               |
| **ADAPTER / INTEGRATION**      | `apps/cli/src/daemon-cli.ts`, `packages/runtime-host/src/commands/lifecycle.ts`, `apps/cli/src/offline-project-status.ts` expose repository-root `install/status/next/uninstall`; `packages/application/src/agent-client/*` detects Codex/Claude and projects repository skills.                                                                         | Preserve these compatibility commands and generated files; introduce pack operations as Runtime clients and keep client detection separate from domain selection.                                    |
| **ADAPTER / INTEGRATION**      | `packages/application/src/ports/worker-runtime.port.ts` is tool-free and generic; present adapters are coding-client oriented (`--worker claude`, gateway), with software onboarding guidance in the skill.                                                                                                                                              | Keep worker execution and model routing behind ports. Pack prompts/context may configure behavior but cannot acquire tools or credentials directly.                                                  |
| **ADAPTER / INTEGRATION**      | `migrations/project/*` and `supabase/migrations/*` store manifest JSON with schema version 1, task/requirement links, pinned pipeline definitions and tenant constraints; PG remains partial per ADR-0022.                                                                                                                                               | Use forward migrations and fresh/upgrade tests for pack binding. Preserve PG tenant/RLS policy and fail closed while parity is incomplete; do not create sidecar authority.                          |
| **ADAPTER / INTEGRATION**      | Root `package.json` uses `apps/*` and `packages/*` workspaces; `packages/runtime-host` and `apps/daemon` compose application ports and adapters. No Domain Pack package exists.                                                                                                                                                                          | Put public pack contracts below composition roots; a future reference pack imports those contracts, while core packages never import the pack.                                                       |
| **GENERIC ABSTRACTION NEEDED** | `tests/contracts/office-manifest-repository.contract.ts`, `tests/helpers/run-runtime.ts`, `tests/e2e/task-lifecycle-cli.test.ts` and capability/pipeline end-to-end tests use software-oriented fixtures and the current agent directory.                                                                                                                | Retain pre-pack fixtures as regressions; add development, legal, manufacturing and empty/custom fixtures over the same contracts and backend upgrade paths.                                          |
| **DOCUMENTATION ONLY**         | `README.md`, `AGENTS.md`, `docs/architecture/overview.md`, `docs/development/professional-work-verticals.md` and ADR-0021/0022/0025 describe current software-first behavior or future verticals.                                                                                                                                                        | Update current guidance only as implementation slices land. Keep M15 research historical and the accepted M16 ADR distinct from shipped Runtime behavior.                                            |

The audit distinguishes capability declaration from capability grants, role
names from core role identity, pack workflow templates from the pipeline
engine, repository binding from project authority, and knowledge advice from
operational state. The planning model has explicit typed task dependency edges
([SQLite migration](../../migrations/project/0037_task_dependencies.sql)),
but `task` has no `milestone_id`, `task_requirement` is many-to-many, and
delivery slices are not native relations. Each GP task links to one GP
requirement under M16; dependency edges record task prerequisites, while
descriptions retain external milestones and slice acceptance criteria.

### GP-01 source verification and compatibility risks

| Seam                          | Verified source and current behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Classification and migration risk                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project and work              | [`Project`](../../packages/domain/src/project/project.ts) is a named Runtime-local ID; [`CreateProject`](../../packages/application/src/commands/create-project.ts) also creates `repo_<projectId>`. [`Task`](../../packages/domain/src/task/task.ts) owns project-scoped transitions.                                                                                                                                                                                                                                                                                                      | **CORE** project/task authority; **ADAPTER / INTEGRATION** repository association. Non-repository creation needs a separate portable identity and legacy association reader; a synthetic `repo_` is not a neutral identity.           |
| Agent and role                | [`Role`](../../packages/domain/src/agent/role.ts) contains project identity, version, policy, limits, `sourcePath` and guidance; [`SyncAgentDefinitions`](../../packages/application/src/commands/sync-agent-definitions.ts) derives stable IDs from YAML. [`AgentRun`](../../packages/domain/src/agent/agent-run.ts) pins run facts.                                                                                                                                                                                                                                                       | **CORE** run/role identity; **GENERIC ABSTRACTION NEEDED** definition origin; **ADAPTER / INTEGRATION** YAML sync. Pack upgrades cannot overwrite project roles or alter pinned run guidance.                                         |
| Office and pipeline           | [`OfficeManifest`](../../packages/domain/src/office/office-manifest.ts) is schema 1 with five closed software task kinds; [validation](../../packages/application/src/office/office-manifest-schema.ts) requires a default kind and existing role for each stage. [`ApplyOfficeManifest`](../../packages/application/src/commands/apply-office-manifest.ts) appends a revision and audit in one transaction. [`PipelineRun`](../../packages/domain/src/pipeline/pipeline-run.ts) pins the revision and definition.                                                                          | **GENERIC ABSTRACTION NEEDED** task-type and definition resolution; **CORE** pipeline transitions and pinning. New pack contracts must leave schema-1 readers, revisions and active stages intact.                                    |
| Governance and effects        | [Governance](../../packages/domain/src/governance/governance.ts) records M5 reviews/approvals; [capability policy](../../packages/domain/src/capability/policy-engine.ts) evaluates grants. [`ResourceType`](../../packages/domain/src/capability/capability.ts) includes GitHub and other connector types.                                                                                                                                                                                                                                                                                 | **CORE** governance, policy and exact-action approval; **GENERIC ABSTRACTION NEEDED** resource-type extension; **ADAPTER / INTEGRATION** connector operations. A pack declaration is never a grant, qualification or action approval. |
| Worker and artifacts          | [`WorkerRuntime`](../../packages/application/src/ports/worker-runtime.port.ts) receives bounded, tool-free context and returns text. [`WorkerAgentExecutor`](../../packages/application/src/commands/worker-agent-executor.ts) still returns `artifacts: []`; [ADR-0021](../adr/ADR-0021-artifact-review-and-approval-workflow.md) is a conceptual accepted contract.                                                                                                                                                                                                                       | **CORE** dispatch/fencing; **GENERIC ABSTRACTION NEEDED** versioned artifact/evidence envelope. Pack validators cannot rely on artifact review being implemented yet.                                                                 |
| Knowledge                     | [`KnowledgeScope`](../../packages/application/src/ports/agent-knowledge-store.port.ts) requires trusted tenant plus portable `repositoryId`; [`RunContextAssembler`](../../packages/application/src/context/run-context-assembler.ts) injects bounded advisory hits.                                                                                                                                                                                                                                                                                                                        | **CORE** knowledge port and trusted scope; **GENERIC ABSTRACTION NEEDED** non-repository scope. Preserve old keys and provenance; pack content cannot choose tenant or operational state.                                             |
| Repository and clients        | [Project import](../../packages/application/src/commands/import-project.ts), [scanner](../../packages/runtime-host/src/local-project-scanner.ts), [lifecycle](../../packages/runtime-host/src/commands/lifecycle.ts), [CLI](../../apps/cli/src/daemon-cli.ts) and [offline status](../../apps/cli/src/offline-project-status.ts) treat a checkout as the entry path.                                                                                                                                                                                                                        | **ADAPTER / INTEGRATION** software project entry. Preserve `install/status/next`, local path semantics, binding and snapshot compatibility while a non-repository path is added separately.                                           |
| Software defaults and prompts | The [default manifest](../../.agents/skills/ai-office/assets/default-office-manifest.json) defines software roles and workflows. [Permission preferences](../../packages/domain/src/project/project-profile.ts) include tests/commits; the [instruction contract](../../packages/domain/src/agent/project-instruction-contract.ts) and [compiler input](../../packages/application/src/project-lifecycle/build-project-instructions.ts) require repository/testing concepts. [Requirement validation](../../packages/runtime-host/src/commands/requirement.ts) says “software requirement.” | **DEVELOPMENT PACK** defaults, terminology and guidance; **DOCUMENTATION ONLY** user-facing examples. Existing generated guidance and approvals remain valid until a versioned reader and parity fixture exist.                       |
| Authoritative schema          | SQLite [office revision](../../migrations/project/0017_skill_first_office.sql) and PostgreSQL [office revision](../../supabase/migrations/20260922020000_office_manifest_pipeline_authority.sql) both constrain `schema_version = 1`; SQLite [pipeline pinning](../../migrations/project/0020_pipeline_enforcement.sql) fixes exact definition and project ownership. [Task–requirement links](../../migrations/project/0026_task_requirement_linkage.sql) are explicit and many-to-many.                                                                                                   | **CORE** authoritative persistence; **GENERIC ABSTRACTION NEEDED** forward schema evolution. No in-place migration rewrite, sidecar authority, or semantic inference from task titles.                                                |
| Regression surface            | [Manifest validation tests](../../tests/unit/office-manifest-schema.test.ts), [storage contracts](../../tests/contracts/office-manifest-repository.contract.ts) and [daemon task lifecycle tests](../../tests/e2e/task-lifecycle-cli.test.ts) exercise current behavior. [Architecture overview](../architecture/overview.md) and [README](../../README.md) describe current software-first operation.                                                                                                                                                                                      | **CORE** regression contract; **DOCUMENTATION ONLY** current-product claims. Retain old fixtures and add upgrade, zero-pack and cross-domain fixtures in later GP slices.                                                             |

Verified dependency path (arrows indicate data or authority flow, not a new
implementation):

```text
host-local installed catalog --trusted availability check--+
                                                     |
ProjectStorage binding + project-owned definitions/overrides
  --deterministic resolution, using both inputs--> effective project configuration
  --pin--> PipelineRun / AgentRun --dispatch--> WorkerRuntime
                                   |                  |
                                   |                  +--> advisory AgentKnowledgeStore
                                   +--> core policy / approval / audit
                                             +--> controlled connector action
```

Extraction order: (1) preserve schema-1 and repository fixtures; (2) review and
integrate M15-4, then compare and accept or revise the GP-02 contract; (3) introduce generic
types and catalog without changing stored behavior; (4) persist explicit
bindings and resolve project overrides; (5) verify an implicit development
compatibility profile against old state; (6) extract software defaults and
prompts; (7) exercise legal, manufacturing and zero-pack fixtures; (8) enforce
core-purity and upgrade gates. GP-03 onward owns implementation and migrations.

## Target contract and acceptance scenarios

The target `DomainPackManifest` is an accepted architectural contract, not a
shipped TypeScript API. ADR-0026 defines its envelope after checking the
current versioned office manifest, ports, package layout and ADR-0027.
At minimum it identifies pack ID, immutable version, `manifestDigest`,
manifest schema and core compatibility, metadata, dependencies, and
independently validated declarations. A project selects
pack versions explicitly where it has migrated. Project definitions and
overrides determine the effective roles, agents, pipelines, prompts, policies,
artifacts, validators and knowledge behavior. Required capabilities resolve
to registered adapter contracts at validation/bootstrap; grants remain separate.
The host-local catalog checks an independent `artifactDigest` for its installed
file; it is availability state, not `ProjectStorage` authority or portable
project state. A binding never arises from package discovery.

Four fixtures must ultimately use the **same** Runtime, task and agent
lifecycle, pipeline engine, approval/audit/provenance model, authoritative
storage, and AgentKnowledgeStore boundary:

| Project           | Domain definitions and scenario                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A — development   | CTO/Architect/Developer/QA; requirement → implementation → review → hardening → complete; project may replace roles or insert security, QA and human approval stages.    |
| B — legal         | Counsel/Researcher/Reviewer; matter intake → research → draft → review → approval, with source/citation evidence and human authority. No production legal service claim. |
| C — manufacturing | Planner/Operator/Quality Engineer/Supervisor; production order → execution → inspection → deviation review → release. No MES/PLC mutation.                               |
| D — empty/custom  | No official pack; project-created roles, agents, pipeline, artifact types and policies. It runs and audits through the same contracts without modifying core source.     |

## Compatibility stages

1. **Contracts:** add pack manifest validation and public contracts beside
   schema-1 office definitions; current behavior and persisted bytes still load.
2. **Resolution:** introduce deterministic pack/project/override resolution and
   inspectable origin/digest; current manifest remains an input, not a duplicate
   project store.
3. **Implicit legacy development:** recognize existing project state through a
   versioned compatibility profile without rewriting office, role, agent,
   pipeline, binding, knowledge or snapshots. Compare old and resolved behavior.
4. **Extraction:** move development defaults and integration metadata in small
   slices, proving parity before each old coupling is removed.
5. **Opt-in adoption:** preview and audit an explicit development-pack binding;
   preserve project edits and in-flight pinned runs. Support old snapshots.
6. **New projects:** decide separately whether explicit pack selection is the
   default, after pack-free custom projects are proven. Legacy projects never
   acquire a mandatory rewrite solely because this option exists.

At every stage tenant isolation, RLS, fencing, runtime ownership, exact
approval/action boundaries, project authority, task lifecycle, AgentRun
immutability, pinned pipeline guards, audit and provenance remain in force.

## Task graph

```text
GP-01 audit + M15-4 authority/evidence ADR → GP-02 boundary ADR → GP-03 minimum primitives → GP-04 catalog/resolution
                                                        GP-04 → GP-05 project binding
                                                        GP-05 → GP-07 ownership/overrides
                                         GP-04 + GP-05 + GP-07 → GP-06 resolved config
                                                   GP-06 + GP-07 → GP-08 upgrades
                                                   GP-06 + GP-08 → GP-09 legacy compatibility
GP-06 + GP-07 → GP-11 roles → GP-12 agents → GP-13 workflows
GP-03 + GP-06 → GP-14 artifacts/validators
GP-06 → GP-15 knowledge; GP-06 → GP-16 capabilities
GP-09 + GP-11..GP-12 → GP-10A roles/agents/task defaults
GP-10A + GP-13 → GP-10B workflows/prompts
GP-10B + GP-14..GP-16 → GP-10C evidence/integrations/adoption
GP-11..GP-16 → GP-17 legal, GP-18 manufacturing, GP-19 empty/custom
GP-10C + GP-17..GP-19 → GP-20 purity and regression → GP-21 authoring guide
```

The M11.6 artifact contract is a prerequisite to production GP-14 work.
M15-4 integration and the ADR-0026 comparison satisfied GP-02's decision gate.
Tasks may be reviewed as individual PRs; no task is permission to implement
another roadmap milestone.

## Delivery tasks

Every GP key is also a project requirement key. Each row gives the task's
objective, smallest delivery slice, acceptance, artifact/verification, and
explicit exclusion. The linked AI Office task and requirement descriptions
carry the same fields. GP-01 through GP-05 and GP-07 have passed review and
merged. GP-06 is implemented in a review branch on top of the merged GP-07
state; it remains incomplete until its separate final review.

| ID and title                                       | Depends on                      | Slice and acceptance                                                                                                                                                                                                     | Artifact / verification                                                                                              | Non-goal                                                  |
| -------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| GP-01 — Core/domain boundary audit                 | M15 assessment input            | Classify all current domain, application, runtime, worker, lifecycle, schema, CLI, prompt, test and docs seams; record exact core/pack/adapter split and compatibility risks.                                            | Updated evidence matrix and dependency map; review every cited source and compare current behavior.                  | Production changes.                                       |
| GP-02 — Domain Pack contract ADR                   | GP-01; M15-4 review/integration | Accept or revise ADR-0026 against ADR-0027: manifest, version/schema compatibility, lifecycle, execution boundary, conflicts, ownership, governance, knowledge, capability and purity.                                   | Accepted ADR plus contract examples; architecture review against M11.6, ADR-0022/0025/0027.                          | Arbitrary plugin execution.                               |
| GP-03 — Minimum generic primitives                 | GP-02                           | Add only genuinely reusable type/artifact/evidence/task metadata selected by ADR; preserve existing state machines and schema-1 readers.                                                                                 | Contract and migration plan; unit and representative upgrade tests.                                                  | Renaming development entities for appearance.             |
| GP-04 — Pack catalog and deterministic resolution  | GP-03                           | Validate locally installed IDs, versions, digests, dependencies and compatibility; duplicate/missing/incompatible/conflicting definitions fail clearly and independent of import order.                                  | Public catalog/resolver contract; deterministic positive/negative tests.                                             | Remote registry or downloads.                             |
| GP-05 — Project pack binding                       | GP-04                           | Persist explicit project selection through ProjectStorage; expose preview/read and compatibility failures, with SQLite and PG parity as its provider permits.                                                            | Forward migrations, repository contracts, tenant/RLS and upgrade tests; CLI/IPC coverage.                            | Pack selection from tools or client detection.            |
| GP-06 — Resolved project configuration             | GP-04, GP-05, GP-07             | Resolve packs + project definitions/overrides into stable effective roles, agents, pipelines, policies and capability needs with origin/digest; reuse manifest revisions where sound.                                    | Inspectable resolved view; equality, pinning and invalid-input tests.                                                | Second mutable project authority.                         |
| GP-07 — Definition ownership and project overrides | GP-05                           | Record core/pack/project/override/resolved origin; allow replacement, extension, disablement and custom definitions where safe; security gates cannot be weakened.                                                       | Ownership/override contract and tests for customized, removed and conflicting definitions.                           | Fixed pack workflow.                                      |
| GP-08 — Pack upgrade/reconciliation                | GP-06, GP-07                    | Preview/apply upgrades idempotently; preserve customized definitions, handle deleted/old references and active pins, audit changes, block unresolved conflicts.                                                          | Migration/reconciliation report; repeat, rollback/failure and compatibility tests.                                   | Silent overwrite or automatic pack download.              |
| GP-09 — Legacy development compatibility           | GP-06, GP-08                    | Versioned implicit development profile loads old offices, agents, roles, pipelines, binding and snapshots unchanged; verify effective parity.                                                                            | Legacy fixture and semantic comparison tests including tasks, approvals, knowledge, persistence and audit.           | Forcing existing users to adopt packs.                    |
| GP-10A — Development roles and task defaults       | GP-09, GP-11, GP-12             | Move Software Architect/Developer/Reviewer/QA defaults and software task kinds into the development pack; legacy and adopted projects resolve equivalent effective definitions.                                          | Reference pack definitions; old/new manifest, role and agent parity tests.                                           | Runtime identity or task lifecycle redesign.              |
| GP-10B — Development workflows and prompts         | GP-10A, GP-13                   | Move feature/bugfix/research/release templates and software assessment/instruction prompts behind pack defaults; project pipelines remain editable.                                                                      | Workflow and prompt templates; stage/approval and project-customization parity tests.                                | New pipeline engine or forced workflow.                   |
| GP-10C — Development evidence and adoption         | GP-10B, GP-14–GP-16             | Put repository/GitHub/commit/PR/CI evidence types, knowledge guidance and capability declarations behind pack contracts; offer previewed explicit adoption while preserving old bindings.                                | Development pack completion and migration report; legacy snapshot, approval, action and provenance regression tests. | Redesign of worker, queue, model routing or governance.   |
| GP-11 — Pack role archetypes                       | GP-06, GP-07                    | Instantiate, rename, replace, omit and add roles; preserve role identity, permissions and project changes on upgrade.                                                                                                    | Role contracts and customization/upgrade tests.                                                                      | Hard-coded official role names.                           |
| GP-12 — Pack agent archetypes                      | GP-11                           | Instantiate, replace, disable or add agents; project config controls name, role, model, guidance/prompts, knowledge, tools, capability requests, pipeline participation and approval eligibility within existing limits. | Agent configuration contracts and upgrade/authority tests.                                                           | Pack-owned Runtime identities or model-routing rewrite.   |
| GP-13 — Pack workflow templates                    | GP-11, GP-12                    | Instantiate, reorder, extend, replace or disable pipelines and stages; preserve generic engine, pinning, approvals and guards.                                                                                           | Pipeline template and project customization tests, including in-flight version changes.                              | Domain-specific pipeline engine.                          |
| GP-14 — Artifacts, evidence and validators         | GP-03, GP-06; M11.6             | Declare domain types and trusted validator references atop generic version/provenance/review contracts; stale evidence and invalid validator output fail closed.                                                         | Typed fixture schemas and version-bound review/validator tests.                                                      | Running arbitrary pack code.                              |
| GP-15 — Pack knowledge guidance                    | GP-06                           | Contribute categories, schemas, seed references, retrieval guidance and agent settings through AgentKnowledgeStore with trusted tenant/project scope.                                                                    | Scope compatibility plan and old/new knowledge fixtures; outage and provenance tests.                                | New vector/graph store or authority.                      |
| GP-16 — Pack capability contracts                  | GP-06                           | Declare required/optional abstract operations; bind registered providers at bootstrap; reject missing required provider before runs; grants still separately authorize use.                                              | Capability contract and fail-closed/controlled-action tests.                                                         | Pack-granted authority or direct credentials.             |
| GP-17 — Legal reference fixture                    | GP-11–GP-16                     | Matter intake, research, draft, citation/evidence review and human approval use public contracts and no software defaults.                                                                                               | Minimal legal pack/fixture and scenario tests for roles, workflow, artifact, knowledge and governance.               | Production legal service or filing adapter.               |
| GP-18 — Manufacturing reference fixture            | GP-11–GP-16                     | Production order, execution, inspection, deviation and supervisor approval use public contracts and no software defaults.                                                                                                | Minimal manufacturing pack/fixture and scenario tests for provenance, policy and controlled-action boundary.         | MES, ERP, OPC-UA or PLC writes.                           |
| GP-19 — Empty/custom domain fixture                | GP-11–GP-16                     | Zero official packs; project-defined roles, agents, workflow, artifacts, policy and knowledge work without core edits.                                                                                                   | Custom-domain fixture and end-to-end configuration/upgrade tests.                                                    | Making `custom` a privileged official pack.               |
| GP-20 — Core purity and legacy regression gate     | GP-10C, GP-17–GP-19             | Enforce `pack → public core contracts`, no core import of official packs, and run four-domain plus pre-pack fixtures against lifecycle, approval, storage, knowledge, audit and fencing.                                 | Architecture rule and integration suite; `bun run check` plus DB upgrade/RLS checks as applicable.                   | Broad refactor outside M16.                               |
| GP-21 — Pack authoring and operations guide        | GP-20                           | Document manifest, lifecycle, project ownership/customization, conflicts, upgrades, local install/validate and custom/three reference examples using actual commands.                                                    | Authoring guide and tested examples; docs/CLI parity review.                                                         | Marketplace, remote registry or speculative CLI commands. |

## Milestone exit and exclusions

M16 completes only when old development projects remain operational at each
stage; a pack cannot silently overwrite project-owned configuration; roles,
agents, pipelines and other pack defaults can be replaced or omitted; projects
can add their own definitions; Runtime execution consumes generic resolved
configuration; official packs have no privileged core import or branch;
upgrade conflicts are deterministic and auditable; and the empty/custom
fixture succeeds beside development, legal and manufacturing. Existing tenant,
RLS, fencing, approval, audit, provenance, task, run, pipeline and storage
guarantees must still pass. An accepted ADR or a fixture alone does not satisfy
the eventual end-to-end exit.

Out of scope: complete legal software, MES, ERP or industrial integrations;
third-party marketplace/distribution; remote registry and dynamic downloading;
untrusted executable plugins or runtime-generated packs; replacing the
pipeline engine, governance, `ProjectStorage`, `AgentKnowledgeStore`, model
routing or worker queue. Future Pro deployment work remains in M15/M9 tracks.

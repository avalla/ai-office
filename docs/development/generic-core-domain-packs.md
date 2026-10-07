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
GP-08 adds reviewed upgrade and override reconciliation through
`project:pack:upgrade`.
GP-11 defines pack role archetypes: stable role identity, declarative role
capabilities, project rename, replace, omit and add, and their upgrade merge
rules. It is a definition layer and creates no Runtime role.
GP-12 does the same for pack agents, and GP-13 lets a project replace, extend
or disable a pack workflow. Both are definition layers: no Runtime agent or
pipeline is created from them.
GP-22 makes binding preview/apply and portable restore reject a selection
whose resolved closure collides with a project-owned definition.
GP-23 records that U+0000 stays allowed in pack manifest text by design.
GP-09 adds a versioned, read-only legacy development profile and proves
legacy-state parity; it is not execution parity.
GP-10A defines the development pack as a committed reference artifact and
proves expressible-subset parity with the legacy development defaults. The
pack is not registered, not adopted and not read by the Runtime.
GP-10B-1 adds the four development workflows to that reference pack and
proves expressible-subset parity for workflows; nothing was removed from the
legacy path.
The [roadmap](roadmap.md) owns milestone status; ADR-0026 is an accepted
architectural contract, not current Runtime behavior.

On 2026-10-06 the owner re-scoped the M16 exit to the definition and contract
layer plus reference fixtures. After M16, packs are a definition,
customization and upgrade layer; the Runtime does not yet execute from a
pack. Runtime activation and the tasks that need it are planned for the
successor milestone M16.5. See
[M16 exit re-scope](#m16-exit-re-scope-owner-decision-2026-10-06).

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
and PostgreSQL migrations and upgrade tests for those bindings. GP-09
describes legacy state through a versioned read-only profile (legacy-state
parity). Compatibility once pack resolution reaches the Runtime is the
follow-up Runtime task named in the GP-09 section.

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
Since GP-11 the preview also reports role capability changes, and preview and
apply refuse (`role_capability_change_requires_upgrade`) a change to an
existing role's capability set and, while the currently selected artifacts are
not installed, every change other than a pure removal; see the GP-11 section.
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
Since GP-22 preview and apply also reject (`pack_definition_collision`) a
selection whose resolved closure contains the kind and local ID of a
project-owned definition; see the GP-22 section for the check and the order of
issues.

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
is skipped. Since GP-22 the inverse paths run the same comparison: a binding
change and a portable restore whose closure resolves are rejected with the same
code before they commit. GP-06 remains the authority and the backstop: it
rejects a collision in state that reached storage without either preflight, for
example a restore onto a host where the packs were not yet installed.

| Schema-1 pack contribution                            | `replace`                                         | `extend`                      | `disable`   |
| ----------------------------------------------------- | ------------------------------------------------- | ----------------------------- | ----------- |
| Task types, artifact types, evidence types, knowledge | Descriptive fields only                           | Absent title/description only | Unsupported |
| Roles (`disable` since GP-11), prompts                | Descriptive fields only                           | Absent title/description only | Supported   |
| Agents (reference fields and `disable` since GP-12)   | Descriptive fields and the GP-12 reference fields | Absent title/description only | Supported   |
| Workflows (all three since GP-13)                     | The complete typed workflow envelope              | Absent title/description only | Supported   |
| Policies, capabilities, validators                    | Unsupported                                       | Unsupported                   | Unsupported |

`replace` supplies the complete schema-1 descriptive envelope, for an agent
the reference fields of GP-12 and for a workflow the `taskType` and ordered
`stages` of GP-13; `extend` fills
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
artifacts, credentials and resolved configuration. GP-11 adds format 7 for a
state that omits a role; format 6 keeps its prompt-only `disable` rule. GP-12
adds format 8 for a state that disables an agent or stores agent reference
fields; format 7 rejects both. GP-13 adds format 9 for a state that overrides
a workflow; format 8 rejects that.

GP-06 resolves these sources into an effective configuration and defines
its digest. GP-08 handles pack upgrade reconciliation. GP-10A delivers the
first legacy Development Pack parity slice: expressible-subset parity for
roles, agents and task types. Aliases, the remaining Development Pack
parity and extraction, automatic selection, downloads, registry, executable
validators, KnowledgeScopeV2, portable project UIDs and Runtime execution
from pack definitions remain deferred.

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
definitions, using GP-07's replace, extend and disable matrix. No
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
Since GP-25 this holds for a policy without `workflow` only; a pack whose
policies are all typed resolves (see the GP-25 section).
Evidence and capability names are descriptive declarations; they create no
verified fact, grant, or approval. ADR-0027's conjunctive gates, scope
intersection, accumulating denials, and ordered bounds need a typed policy
contract before they can govern execution.

`project:configuration:show --project <id> [--json]` returns the derived view
or a sanitized typed diagnostic through the Runtime socket. An unknown project
is reported as not found, like the other project commands. Empty bindings and
definitions resolve to a valid empty view. Existing OfficeManifest scheduling,
roles, agents, pipelines and run pins retain their current behavior.

## GP-08 pack upgrade and reconciliation

`project:pack:upgrade --project <id> --packs <exact-tuples-json>
[--resolutions <json>] [--approve <plan-digest>] [--json]` takes the complete
desired selection, like `project:pack:apply`. It covers a version change, an
added or detached pack, and overrides left on an old tuple by an earlier
selection change. Without `--approve` it is read-only and prints the
reconciliation report. With `--approve` it writes the selection and the
reconciled project definitions in one transaction with one
`project.pack_upgrade_applied` audit event. No migration, storage port or
portable archive format changes: the operation rewrites only GP-05 binding
tuples and GP-07 override sources through their existing repositories.

The report is a pure function of the binding, the definition state, the desired
tuples, the supplied resolutions and the installed catalog. Its `planDigest` is
SHA-256 of `ai-office-pack-upgrade-plan-v1\n` followed by RFC 8785 canonical
JSON of every other report field, including both authoritative revisions.
Apply recomputes the report and refuses a digest that does not match
(`plan_not_approved`), so any change to the project or to the installed
artifacts since the preview needs a new review. Inside the write transaction
both revisions are checked again and both streams are written through their
repositories' revision fences, so every applied upgrade advances the binding
revision when the selection changes and always advances the definition
revision. A concurrent selection or definition change therefore fails stale
and writes nothing on SQLite and on read-committed PostgreSQL alike.
`project:pack:apply` keeps its GP-05 meaning and does not reconcile.

Each project override is classified against the pack it names:

| Override source in the desired selection                        | Outcome                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Exact tuple still selected                                      | `unchanged`.                                                                                 |
| Pack selected at another tuple, definition still provided       | `retargeted` to the new tuple. The entry is carried over whole; only its pack tuple changes. |
| Same, but an `extend` field is now set by the template          | Conflict `extend_conflict`.                                                                  |
| Same, but another override names or would reach the same target | Conflict `target_override_exists`, for every competing override.                             |
| Pack selected at another tuple, definition no longer provided   | Conflict `source_definition_removed`.                                                        |
| Pack no longer selected                                         | Conflict `source_pack_removed`.                                                              |

A conflict blocks the upgrade (`unresolved_override_conflict`) until the
operator supplies a resolution for that exact source:
`retain_as_project_owned` or `remove_override`. GP-11 adds
`convert_to_replace` for an `extend_conflict` only. Retaining turns a `replace`
override whose template is gone into a project-owned definition with the same
kind, local ID and payload. It is refused (`invalid_resolution`) for `extend`
and `disable`, which do not carry a complete definition, while the pack still
provides the definition, and when a project-owned definition already uses the
identity. Nothing is retained, moved or removed without a resolution, and a
project value is never rewritten. A resolution that matches no conflict is
listed under `ignoredResolutions` and changes nothing.

Overrides on different old tuples that would land on one target definition all
conflict: no version or storage order chooses the surviving project value.
Removing all but one lets the remaining override follow the upgrade. An
override already on the target tuple stays; one that would join it conflicts.
A retargeted override keeps its operation, payload, entry revision, author and
edit time; the audit event records the move and the operator.

The report also lists pack template changes over the old and new resolved
closures, transitive dependencies included, by pack ID, kind and local ID:
`added`, `removed` or `changed`, each marked `customized` when a project
override names it. `upstream` on each override says whether its template is
`unchanged`, `changed`, `removed` or `unknown`. The old template is
information only: when the previous artifacts are no longer installed the
template list is `unavailable` and `upstream` is `unknown`, and the upgrade is
not blocked, because nothing is derived from the old template. The template
list describes this selection change only: when the selection is unchanged and
only overrides left on an old tuple are reconciled it is empty, while
`upstream` still compares each override's old template with the current one.

Before a plan is approvable the reconciled selection and definitions are
resolved through the GP-06 resolver. A failure blocks the upgrade as
`prospective_configuration_invalid` with the GP-06 code, for example
`duplicate_effective_definition` when a new version starts to provide a
definition the project already owns. An unresolvable desired closure blocks
as `target_closure_unresolved` with the GP-04 code. A clean plan carries
`prospectiveConfigurationDigest`, the digest `project:configuration:show`
returns after apply.

A selection and overrides that already agree are a no-op: no revision change
and no audit event, whatever digest is passed and even when the artifacts are
no longer installed, as in GP-05. The audit event records the plan digest,
previous and new revisions and tuples, every changed override with its source,
outcome and target, template change counts and the prospective digest. It
never contains a definition body.

Runs do not pin pack configuration yet: GP-06 exposes `pin` and nothing
persists it, and the Runtime does not schedule from pack definitions. The
report states this as `activePins: unavailable`
(`pack_configuration_run_pins_not_modelled`). Existing OfficeManifest, role,
agent, pipeline, task and run-pin rows are not read or written. Blocking a
removal on active pack-pinned runs belongs to the task that persists those
pins. Policies, capabilities and validators have no override operation in
schema 1, so no project customization of them can exist to reconcile; the
template list still reports their changes. Workflow overrides exist since
GP-13 and are reconciled by the rules of its section.

Aliases, explicit old-to-new definition mappings beyond the listed resolutions,
automatic selection or download of a newer version, Development Pack
compatibility/extraction and Runtime execution from pack definitions remain
deferred.

## GP-09 legacy development compatibility

Status: implemented. The owner reworded criterion 12 on 2026-10-06, after the
implementation showed that re-export cannot keep a legacy archive's format;
the rest of the contract below is unchanged. "Implementation record" at the
end of this section records what the code does where the contract left a
choice, and where it stops short.

GP-09 describes, deterministically, what the legacy Runtime uses today. It
derives a versioned, read-only **legacy development profile** from a project's
legacy state: the latest OfficeManifest revision and the project's Runtime
roles and agents. The property it proves is **legacy-state parity**: the
profile equals the office, routing and agent eligibility that the Runtime's
own readers return for the same project.

It is not execution parity. The profile is not a Domain Pack, not a resolved
configuration and not executable. GP-09 does not claim that a pack-based
resolved configuration is semantically equivalent to a legacy office or would
execute the same way; that is the separate follow-up Runtime task
"Runtime resolved-configuration execution parity"
(`a45ddb12-3159-4b60-9b8b-c26516720834`). No pack is inferred, bound or
installed, nothing is migrated, nothing is scheduled from the profile and no
project is mutated. `project:configuration:show`, its key set and its digest
are unchanged.

### Decisions

1. "Effective parity" in the task row means that the view equals the legacy
   state the Runtime reads today. It is named legacy-state parity and never
   execution parity.
2. The profile has its own read-only command. It is not a block in
   `project:configuration:show`.
3. The profile is available for every project with an office. It reports
   whether a pack binding also exists.
4. A project with no office returns a valid empty view.
5. Runtime roles and agents outside the manifest are included in a distinct
   `runtimeOnly` section with explicit provenance. They are never
   reinterpreted as pack content.
6. Prompts and instruction-contract defaults are excluded (GP-10B).
7. Role guidance appears as digest and version only, never as text.
8. SQLite carries the complete suite. At least one representative end-to-end
   case covers derivation and digest on real PostgreSQL.
9. Profile version 1 is frozen with a test vector. Any change to the mapping
   or to the digest material is a new profile version.

### Profile

The profile is a pure function of the legacy state. It reads no clock and no
storage, and its output carries no Runtime-local project ID, row ID, actor
name or timestamp, so two projects with identical legacy state have identical
profiles. The output states, in every form, that it is a legacy-state profile
and not an executable resolved configuration.

- Office, manifest roles, pipelines and stages keep their legacy field names
  and values. Nothing is renamed into pack vocabulary, so no mapping table
  exists to drift.
- A manifest role is joined to the Runtime role whose key equals its ID, the
  join the pipeline orchestrator and stage authorization already use.
- Each of the five task kinds lists the pipeline `office:pipeline` returns for
  it, or none.
- Each stage lists the agents the pipeline orchestrator would consider for it:
  the enabled agents whose role key equals the stage role.
- Runtime roles whose key is not a manifest role ID, and their agents, are
  listed only under `runtimeOnly`.
- Manifest roles without a Runtime role, Runtime roles outside the manifest,
  task kinds without a pipeline, and the legacy state that the schema-1 pack
  vocabulary cannot express are listed as diagnostics. They never fail the
  view.

The profile has a digest over a canonical serialization of its content. The
binding metadata is reported beside the profile and is not part of the digest.

### Acceptance

1. A pure function derives legacy profile version 1 from an office manifest
   revision and the project's Runtime agents and roles; the same inputs in any
   order give the same canonical bytes and digest. It fails if the output
   depends on input order or the clock.
2. The profile digest for the committed default-office fixture equals a
   pinned test vector. It fails if a mapping or canonicalization change is not
   accompanied by a version bump.
3. The digest and view contain no Runtime-local project ID, row IDs, actor
   names or timestamps. It fails if two projects with identical legacy state
   give different digests.
4. Every manifest role, pipeline, stage and stage field appears in the view
   with an equal value. It fails if a legacy field is dropped or renamed
   without a recorded mapping.
5. For each of the five task kinds, the view's routed workflow equals
   `office:pipeline` output, including "no pipeline". It fails on any routing
   difference.
6. For each stage, the view's eligible agent set equals the set the pipeline
   orchestrator would consider. It fails if an enabled agent with the matching
   role key is missing or an extra one appears.
7. Manifest roles without a Runtime role, Runtime roles outside the manifest,
   and unrouted kinds are listed as diagnostics and do not fail the view. It
   fails if such a project errors or the mismatch is silent.
8. A project with no office manifest returns a valid empty legacy view. It
   fails if the command errors.
9. `project:configuration:show` output and the empty digest vector are
   byte-identical for a legacy project before and after this change. It fails
   if the key set or digest moves.
10. The command is strictly read-only: running it leaves every row of the
    project database byte-identical and writes no domain audit event. It fails
    on any row or revision change.
11. A committed pre-pack fixture migrated to head keeps office, role, agent,
    pipeline run, stage run, override, agent run, task, approval, audit and
    repository-identity rows byte-identical. It fails on any difference.
12. Restoring a committed frozen format-1 to format-4 archive preserves the
    state represented by that archive and yields the expected pinned legacy
    development profile. Re-export format identity is not required. It fails
    if a legacy archive is rejected, restores a different state, or yields a
    different profile.
13. After restore, the legacy project's knowledge scope is still tenant plus
    repository ID and existing records are retrievable. It fails if the scope
    key changes.
14. An existing active pipeline run on the fixture can still be advanced and
    approved after migration, with its pinned definition unchanged. It fails
    if the pin or a guard changes.
15. A fixture with one stage role or approval flag altered makes the parity
    comparison fail, so the comparison is not vacuous.
16. No scheduling, pipeline, run or storage module imports the profile module,
    and no storage port or archive schema names its type. It fails
    mechanically in the architecture test.
17. The command works through the Unix-socket protocol and reports an unknown
    project as not found. It fails without end-to-end coverage.
18. The same legacy state gives the same digest; every semantically relevant
    change (a role, pipeline, stage, stage field, routing, agent eligibility,
    `runtimeOnly` entry, guidance content) gives a different digest.
19. The presence of a pack binding does not alter the legacy profile or its
    digest, except for the binding metadata field.
20. `runtimeOnly` is a section distinct from the office-derived roles and
    agents, each entry carries visible provenance, and nothing in it is
    presented as pack content.
21. The output states explicitly, in both text and JSON forms, that it is a
    legacy-state profile and not an executable resolved configuration.
22. Role guidance appears as digest and version only; the guidance digest and
    the profile digest change when the guidance's semantically relevant
    content changes; the guidance text never appears in output.
23. At least one representative case yields the same normalized profile and
    digest on SQLite and on real PostgreSQL, end to end over derivation and
    digest.
24. The documentation names legacy-state parity, records the non-goals below,
    and links the follow-up task for Runtime resolved-configuration execution
    parity by its task ID.

### Non-goals

- No pack is inferred, bound or installed.
- No migration, archive format or audit event type.
- No change to OfficeManifest, role and agent sync, pipelines, pins, approvals
  or scheduling.
- No development pack contents, prompt extraction or task-kind generalization
  (GP-10A, GP-10B).
- No adoption or migration command (GP-10C).
- No change to `project:configuration:show`.

### Unmet relative to the original wording

The task row, the compatibility stages and ADR-0026 were written before pack
resolution was known to stop short of the Runtime. Three things they name are
deliberately not delivered by GP-09.

- **Execution-level compatibility.** The plan said GP-09 owns legacy
  compatibility "when pack resolution reaches Runtime", and stage 3 says
  "compare old and resolved behavior". Resolution has not reached the Runtime:
  nothing is scheduled from a resolved configuration, and for a legacy project
  that configuration is empty by design. GP-09 compares the profile with the
  Runtime's legacy readers. Comparing execution from a resolved configuration
  with legacy execution belongs to task
  `a45ddb12-3159-4b60-9b8b-c26516720834`.
- **Equivalence with a real development pack.** ADR-0026 step 4 asks for
  legacy and resolved configuration to be checked for semantic equivalence. No
  development pack exists yet, and the schema-1 pack vocabulary cannot express
  a legacy office in full: a workflow has one task type where a pipeline routes
  several kinds, a stage is an ID and a role where a legacy stage also has a
  name, objective, checks, approval flags, capabilities and separation
  constraints, and a pack role has no tools, model policy, limits or guidance.
  The profile lists these gaps for the project at hand. The equivalence check
  belongs to GP-10A and GP-10B, which define the pack.
- **An audit trace of the derived profile.** The roadmap says legacy
  compatibility is "versioned and auditable". The profile is versioned and
  reproducible by digest. It is derived on demand, never stored, never pinned
  to a run, and reading it records no domain audit event.

### Implementation record

- One derivation. `deriveLegacyDevelopmentProfile` in
  `packages/application/src/domain-pack/legacy-development-profile.ts` is the
  pure function. `ReadLegacyDevelopmentProfile` reads the project, its latest
  office manifest, its Runtime roles and agents and its pack binding in one
  short transaction through existing ports and derives outside it. Only that
  reader and the command import the derivation; an architecture test pins
  this.
- Command. `project:configuration:legacy --project <id> [--json]` is a
  separate read-only Runtime command. `--json` prints
  `{ "ok": true, "profile": … }` with every field; without it the command
  prints an operator summary. An unknown project is `Project <id> not found`
  on stderr with exit code 1. A project with no office prints the empty view
  with exit code 0.
- Marker. The view carries `source: "legacy_state"`, `executable: false` and
  a fixed `statement` sentence; the text form prints all three.
- Shape. `profileId` (`ai-office.legacy-development`), `profileVersion` (1),
  `profileDigest`, `metadata`, `office`, `roles`, `agents`, `taskKinds`,
  `pipelines`, `runtimeOnly`, `diagnostics`, `vocabularyGaps`. A role is the
  manifest role plus `runtime`, the Runtime role of the same key or null. A
  stage is the manifest stage plus `eligibleAgents`. Agents are named by
  their project-unique name.
- Order. Manifest roles, pipelines, Runtime roles and agents are sorted by ID,
  key or name in UTF-16 code-unit order. Stage order and every authored list
  (`responsibilities`, `checks`, `defaultFor`, `capabilities`, `tools`) are
  kept as given; reordering one of them is a content change. Routing takes
  the first pipeline, in manifest order, that names the kind, as
  `office:pipeline` does. The manifest schema lets at most one pipeline name
  a kind, so for a valid manifest pipeline order changes nothing; only for
  unvalidated input with two pipelines naming one kind does it decide the
  route.
- Digest. `profileDigest` is `sha256:` over the UTF-8 bytes of
  `ai-office-legacy-development-profile-v1\n` followed by the RFC 8785
  serialization of `profileId`, `profileVersion`, `source`, `office`, `roles`,
  `agents`, `taskKinds`, `pipelines` and `runtimeOnly`. A guidance digest is
  `sha256:` over `ai-office-legacy-role-guidance-v1\n` followed by the exact
  guidance text, without normalization. A role limit `maxCostMicros` is a
  decimal string.
- Outside the digest. `metadata` holds `packBinding.present`, true when the
  project currently selects at least one pack, and `officeManifestRevision`.
  Neither is digest material, which is how a binding leaves the digest
  unchanged (criterion 19) and why two projects with the same office at
  different revision numbers share a digest. `diagnostics` and
  `vocabularyGaps` are determined by the digested sections and are not
  digest material either.
- Not carried. The manifest's `project` model and `provenance`, a role's
  `sourcePath`, every row ID and timestamp, and guidance text. A role whose
  stored guidance text is empty has `guidance: null`.
- Roles are enumerated directly. `AgentRuntimeRepository` gained a read-only
  `listRoles(projectId)`, implemented for SQLite and PostgreSQL with the
  tenant scoping of `findRole`, so a role that no agent uses is still listed.
  Both backends return the roles by key in code-point order; PostgreSQL
  orders the key with the `"C"` collation for that. The derivation sorts its
  input itself and does not depend on it. No schema changed.
- Eligibility is the static rule: enabled agents whose role key equals the
  stage role. A stage's `requiresDifferentAgentFrom` is carried as a field;
  the exclusion it causes depends on earlier assignments of one run and is not
  applied to the list.
- Diagnostics: `manifest_role_without_runtime_role`,
  `runtime_role_outside_manifest`, `runtime_role_without_agent`,
  `task_kind_unrouted`, `stage_without_eligible_agent`. Vocabulary gaps:
  `pipeline_routes_several_task_kinds`, `pipeline_fields_not_expressible`,
  `stage_fields_not_expressible`, `role_fields_not_expressible`,
  `runtime_role_fields_not_expressible`, each naming the subject and the
  fields. A stage capability name that is not a valid pack local ID is not
  reported separately.
- Typed refusal. State that storage cannot hold (two Runtime roles with one
  key, two agents with one name, an agent naming an absent role) raises
  `legacy_state_invariant`; text that cannot be canonicalized raises
  `profile_not_canonical`. The command prints the code and exits 1.
- One consistent state, or a retryable refusal. A PostgreSQL transaction is
  read committed, so an `office:apply` or `agent:sync` that commits between
  the reader's statements could otherwise yield a profile of a state that
  never existed, or a false `legacy_state_invariant`. As
  `ReadProjectConfiguration` does, the reader reads every source twice in the
  same order inside the transaction: office manifest, roles, agents, binding,
  then the four again. If no confirming read differs from its first read,
  every source held its value between the last first read and the first
  confirming read, and the profile is of the state at that moment. Otherwise
  the read fails with `stale_legacy_state`. The command prints "Legacy
  development profile unavailable: stale_legacy_state: Legacy state changed
  during the read; run the command again" (with `--json`,
  `{ "ok": false, "diagnostics": [{ "code": "stale_legacy_state", … }] }`)
  and exits 1. Nothing was written; running the command again is the remedy,
  and the command does not retry by itself. The office manifest and the
  binding are compared by revision. Roles and agents have no revision and are
  compared row for row, timestamps included, so a change that is undone again
  inside the read window and leaves every row equal, `updated_at` included,
  is not detected. The check is conservative: a commit during the confirming
  reads fails the read even where the first reads were consistent. SQLite
  serializes the transaction and never raises the code. The transaction
  runner and its isolation level are unchanged.
- Read-only, and the host's envelope. The reader writes no row. Over the
  socket the Runtime host appends its `command.received` and
  `command.completed` audit rows, as it does for every command including
  `project:configuration:show`. They carry the command name, exit code and
  duration, no project and nothing of the profile. No domain audit event is
  written and every other row is byte-identical.
- Fixtures. `tests/fixtures/legacy-development/` holds the inputs
  (`office-manifest.json`, a copy of the default office, and
  `runtime-definitions.json`) and the frozen files. `pre-pack-project.sql`
  is a complete replayable dump of a project database at migration `0040`,
  the last one before any pack table, written by the services as they were
  when the fixture was created.
- Frozen means the committed bytes. The dump, the four archives and both
  `expected-*.json` are the source of truth. Tests read them as they are; a
  test pins the checksum of the dump and of each archive, and the profile
  digests are literals in the tests. No test requires current code to
  reproduce them: the builders run current services, so an unrelated change
  there moves their output, and that must not turn the legacy files into
  files of newer code. A test only checks that two builds in one run agree.
  `bun tests/fixtures/legacy-development/regenerate.ts` writes nothing and
  reports whether current code still builds the frozen bytes; a difference
  is information, not a failure. Re-creating a file needs a flag.
  `--recreate-frozen-legacy-state` rewrites the dump and the archives; it is
  legitimate only when the fixture has to hold something new, and the pinned
  checksums change with it in the same reviewed commit.
  `--recreate-frozen-expected-profiles` rewrites the expected profiles; a
  different result there means the mapping or the digest material changed,
  which is a new profile version and never a refresh of the version 1 files.
  Either flag needs a profile version review: the pinned digests still hold,
  or the version is bumped.
- Frozen archives. `format-1.aioffice` to `format-4.aioffice` are one quiescent
  legacy project projected onto each format by
  `portableStateAtFormatVersion` and written, when the fixture was created,
  by the archive writer under that format's frozen schema. They are not
  files produced by the releases that wrote those formats: the current
  exporter cannot write below format 6, and no historical archive is kept in
  the repository.
- Criterion 12 first required re-export to select the archive's own format.
  That cannot hold: since GP-07 the exporter writes format 6 or later for
  every project, because the binding and definition sections are always
  present, and existing tests pin that. Writing a legacy project back at
  format 1 to 4 would change the exporter's format selection, which this task
  excludes. The owner therefore reworded the criterion to what the task can
  guarantee. Each archive restores, its state at its own format equals the
  archive with the same checksum, a second restore reports `unchanged`, and
  the restored project has its pinned profile. The test also records that
  re-export is at format 6 with equal state at the archive's format.
- Guidance does not survive an archive. Portable role rows carry no guidance,
  so a restored project's roles have `guidance: null` and its profile digest
  differs from the source project's. The expected restored profile is pinned
  separately.
- PostgreSQL. The provider is partial and cannot host the daemon, so the
  PostgreSQL case runs the application services and the reader on PostgreSQL
  repositories and compares the canonical profile and digest with SQLite and
  with the pinned vector. It is part of the `postgres-storage` CI job.
- Knowledge. The restore test resolves the scope through
  `ManageKnowledgeAdmission.search` with SQLite repositories and a stub store;
  no SurrealDB instance is involved.
- No migration, archive format, audit event type, dependency or scheduling
  change was added.

## GP-11 pack role archetypes

GP-11 defines pack roles as declarative archetypes that a project resolves
into its own configuration. It is a definition layer only. It creates no
Runtime `Role` record, activates no tool, enforces or grants no capability and
binds no agent or run. Existing OfficeManifest, role, agent, pipeline and
run-pin rows are neither read nor written, and nothing is scheduled from a
resolved role.

### Identity

Every resolved role has a stable `roleId`:

- `pack:<packId>/roles/<localId>` for a pack role;
- `project:roles/<localId>` for a project-added role.

The `roleId` contains no pack version, manifest digest, title or description.
The pack ID and the role local ID are the identity-bearing keys: a pack upgrade
that keeps both keeps the `roleId`, and changing either is a removal and an
addition, not a rename. The GP-06 `effectiveId` still carries the exact pack
tuple and therefore changes with every pack version; it identifies exact
content, the `roleId` identifies the logical slot. Pack workflow stages name a
role by its local ID inside the same pack, so a stage keeps resolving to the
same slot across a rename, a replacement and an upgrade.

`project:configuration:show` exposes a derived role contract view next to the
GP-06 lists:

- `roles`: one entry for every enabled role, in the GP-06 definition order,
  with `roleId`, `effectiveId`, `origin` (`pack_owned` or `project_owned`),
  the effective `title` and `description` when present, `capabilities` and
  `customization` (`none`, `replace` or `extend`);
- `omittedRoles`: the `roleId` of every role that is disabled, in the same
  order.

The view is derived from the effective definitions and is not part of the
version-1 `configurationDigest` material. The digest format and the documented
empty-input vector are unchanged. A pack role's declared capabilities are part
of its pack payload in `effectiveDefinitions`, so the digest of a configuration
that uses them reflects them through that existing field.

### Project customization

| Intent  | Mechanism                                                 | Effect                                                                                               |
| ------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Rename  | `replace` or `extend` override setting `title`            | Presentation only. `roleId`, capabilities and workflow references are unchanged.                     |
| Replace | `replace` override with the complete descriptive envelope | The project's title and description substitute the pack's. The slot, `roleId` and capabilities stay. |
| Omit    | `disable` override                                        | The role leaves `roles` and is listed in `omittedRoles`.                                             |
| Add     | project-owned `roles` definition                          | A `project:roles/<localId>` role with no capabilities.                                               |

Omitting fails closed: when an enabled resolved workflow has a stage that
names the omitted role, resolution fails with `disabled_required_definition`
and no view is returned. Workflow validation is not weakened. A role that an
enabled pack workflow uses can therefore be omitted only after the project
disables that workflow or replaces it with a stage list that no longer names
the role, which GP-13 makes possible. A project-owned role with
`enabled: false` is listed in `omittedRoles` in the same way.

A project-added role cannot reuse the kind and local ID of a role anywhere in
the resolved pack closure, as in GP-07 and GP-06. Substituting a pack role is
a `replace` override, not an omission followed by a same-named project role.

GP-11 widens the GP-07 override matrix by one cell: `disable` is supported for
roles as well as prompts. The mutation contract, the GP-06 re-check of stored
state, both storage schemas and the portable archive apply the same rule.

### Declarative capabilities

A schema-1 pack role may carry an optional `capabilities` list of local IDs.
Each entry names a capability declared in the same manifest's
`contributions.capabilities`. The contract package rejects, with a typed
`DomainPackManifestError` (`invalid_contribution`) and the path of the
offending member: a non-array value, an empty array, a malformed local ID, a
duplicate, a list of more than 1,000 entries, a reference to a capability the
manifest does not declare, and the field on any other contribution kind, where
it remains an unknown field. The bound of 1,000 entries is the one GP-12
introduced for every reference list of the contract package
(`maximumContributionReferences`); it applies to a role's `capabilities` as a
uniformity rule.
Schema-1 references are bare local IDs, so a cross-pack reference cannot be
expressed: a capability declared only in a dependency pack is an unknown
reference. "No capabilities" has exactly one encoding, the absent field.

Capabilities are a set. The validated manifest holds them in ascending
code-unit order, so `manifestDigest` does not depend on the written order.
A manifest that omits the field keeps its canonical form and digest; the four
golden fixture digests are unchanged. This is an additive section-schema
extension within manifest schema 1 and core contract version 1. A Runtime
built before GP-11 rejects a manifest that uses the field as an unknown field;
it never ignores it.

These are declarative associations. They grant nothing, authorize nothing and
are not checked against registered providers or capability policy. GP-16 owns
capability contracts and provider binding; controlled-action authorization is
unchanged.

The capability set of a pack role is owned by the selected pack version:

- `replace`, `extend` and `disable` overrides never change it. The resolver
  takes the set from the pack source under every operation; a `replace`
  payload substitutes only the descriptive fields.
- Project payloads cannot carry a `capabilities` key. `put_override` and
  `put_owned` reject it (`protected_security_invariant`), the GP-06 resolver
  rejects it in stored state, and the portable archive schema rejects it.
- Project-added roles have no capabilities in GP-11.

A capability is written in two forms. The role view of
`project:configuration:show` reports it by its stable ID,
`pack:<packId>/capabilities/<localId>`, in ascending local-ID order. The
upgrade plan, the `project:pack:preview` report and the upgrade audit event
list bare capability local IDs under a `roleId`; the pack is the one named in
that `roleId`, because a role can only reference capabilities of its own pack.

### Upgrade and merge semantics

`project:pack:upgrade` (GP-08) carries role customizations across a pack
version change. Stable `roleId` values are identical before and after.

| Project state of the role  | New pack version                                  | Outcome                                                                                                                             |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Not customized             | Changed                                           | The new template applies. Reported as a template change.                                                                            |
| `replace` (rename/replace) | Changed                                           | `retargeted`. The project's title and description win, `upstream: changed` is reported, and the capabilities are the new version's. |
| `extend`                   | Changed, extended fields still absent upstream    | `retargeted`. The project's fields still fill the gaps.                                                                             |
| `extend`                   | Now sets a field the project extends              | Blocks as `extend_conflict` until resolved with `convert_to_replace` or `remove_override`.                                          |
| `disable` (omitted)        | Changed                                           | `retargeted`. The role stays omitted and `upstream: changed` is reported.                                                           |
| Any override               | Role removed                                      | Blocks as `source_definition_removed`. `retain_as_project_owned` is accepted for `replace` only; otherwise `remove_override`.       |
| Any override               | Pack removed                                      | Blocks as `source_pack_removed`, resolved the same way.                                                                             |
| Omitted                    | An enabled pack workflow now requires the role    | Blocks as `prospective_configuration_invalid` (`disabled_required_definition`).                                                     |
| Project-added role         | Pack starts to provide the same kind and local ID | Blocks as `prospective_configuration_invalid` (`duplicate_effective_definition`). The project role is never discarded.              |
| Project-added role         | Anything else                                     | Untouched.                                                                                                                          |

`convert_to_replace` is a third explicit resolution, valid only for an
`extend_conflict`. It turns the extension into a `replace` override on the new
tuple. The new payload keeps the fields the project set and takes every other
descriptive field from the new template, so both sides' information is kept
and the project's presentation wins where they overlap. The outcome is
`converted_to_replace`. Because the entry changes, its entry revision is
incremented and the approving operator and time are recorded on it. For any
other conflict it is an `invalid_resolution` and blocks; like every
resolution, one that matches no conflict is listed under `ignoredResolutions`
and changes nothing. The copied template fields become project values from
then on: a later upstream change to them is only reported as
`upstream: changed` and does not replace them. The converted payload is a
definition body, so it is not in the plan; approval binds it through
`prospectiveConfigurationDigest`. A retained role
(`retain_as_project_owned`) becomes a project-added role, has a new
`project:roles/<localId>` identity and no capabilities; the plan lists the
removal of its pack capabilities.

No upgrade silently recreates an omitted role, discards a project-added role,
resets an override or drops an upstream change: every upstream change under a
customization is reported on the override, and every case that cannot keep
both sides blocks until an operator resolves it.

A change to the capability set of an existing role is never incidental:
`project:pack:upgrade` is the only command that carries one out, under an
approved plan. `project:pack:apply` refuses it. Its preview
(`project:pack:preview`) reports `roleCapabilityChanges` between the current
and proposed resolved closures, computed by the same function as the upgrade
plan and without the `customized` mark, and adds the issue
`role_capability_change_requires_upgrade` in these cases:

- The current closure resolves, and a role present in both closures (same
  `roleId`) would have a different capability set.
- The current closure cannot be resolved because its artifacts are no longer
  installed, and the change is anything but a pure removal. A pure removal
  proposes only exact tuples the project already selects, with nothing added
  and no tuple changed. Without the previous manifests neither an added nor a
  removed role capability can be ruled out: a role may have had a set that the
  proposed version no longer declares, and a newly selected pack may have been
  a dependency at another version. `roleCapabilityChanges` is then
  `unavailable` (`previous_closure_unresolved`). This holds for packs without
  role capabilities too, so it narrows GP-05: a version change or an addition
  while the currently selected artifacts are not installed goes through
  `project:pack:upgrade`, which approves the target capability sets.
  GP-04 availability is checked first and is unchanged: a proposed selection
  that keeps or names a tuple whose artifact is not installed fails with the
  GP-04 code, for example `missing_pack`, and the preview then reports no
  capability change. So a pure removal is applied only when every tuple that
  remains still resolves.
- The proposed closure resolves but its manifests cannot be read back.
  `roleCapabilityChanges` is then `unavailable`
  (`proposed_closure_unreadable`).

The code is carried by the preview issue and by the typed application error
`project:pack:apply` raises. The CLI prints the error message, which names
`project:pack:upgrade`, on stderr and exits 1, as for other known errors.
No selection or definition state is written and no
`project.pack_binding_applied` event is added; the Runtime's generic command
journal records the command as for any other.

While the current closure resolves, `project:pack:apply` still applies, as an
explicit selection change, the addition of a pack that was not selected, the
removal of a pack, and a version change that only adds or removes roles or
leaves every existing role's set unchanged; a selection without role
capabilities behaves as in GP-05. Applying an identical selection remains a
no-op that reads no artifact, and a stale revision fails first; previewing it
still reports GP-04 availability.

Removing a pack in one `project:pack:apply` and selecting another version of
it in a later one is, under the current contract, two explicit and audited
selection changes. Each preview shows the full removal or addition of that
pack's role capability sets, and neither is treated as a capability change of
an existing role. The same holds for a version that drops a role followed by
a later version that provides it again: each step only removes or adds a
role, and each preview lists its full capability set as removed or added.

The upgrade report adds two fields, both covered by `planDigest`:

- `roleCapabilityChanges`: for every role whose capability set differs between
  the old and new resolved closures, including added and removed roles that
  declare capabilities, the `roleId`, the `added` and `removed` capability
  local IDs and whether a project override names the role (`customized`). It
  has the same availability rule as the template list: `unavailable` when the
  previous artifacts are no longer installed, and empty when the selection
  itself does not change.
- `targetRoleCapabilities`: the `roleId` and capability local IDs of every
  role in the target closure that declares capabilities. Approval therefore
  binds the resulting capability sets even when the previous closure cannot be
  read.

A no-op plan reads no artifact and carries both fields empty. The
`project.pack_upgrade_applied` audit event records both fields. They contain
identities only, never a definition body.

### Persistence

SQLite migration `0044` and PostgreSQL migration `20261005000100` widen the
`project_definition_override` operation constraint from "`disable` on prompts"
to "`disable` on prompts or roles". SQLite rebuilds the table and copies every
row; PostgreSQL replaces the one constraint and leaves tenant ownership, keys
and RLS policies untouched. `0042` and `20261003000100` are not edited.
Existing rows keep their values; a `disable` on any other kind is still
rejected by the constraint.

Portable archive format 7 has the format-6 contents and additionally accepts a
`disable` override on a role. Formats 1–6 keep their readers and meanings, and
format 6 still rejects a role omission. A backup is written as format 7 only
when the project state contains a role `disable` override; every other state
with definitions is still written as format 6, byte for byte as before.

### Limitations and non-goals

- Project-added roles cannot declare capabilities. This is a GP-11 limitation,
  not the final role model.
- Capabilities are local to one manifest. Qualified cross-pack capability
  references are not expressible in schema 1.
- A role required by an enabled pack workflow cannot be omitted while that
  workflow names it. Since GP-13 the project can first disable the workflow or
  replace it without the stage, and then omit the role.
- No Runtime `Role` record, tool activation, capability enforcement or grant,
  agent or runtime binding, aliases, or official role names. GP-12 owns agent
  archetypes, GP-13 workflow templates and GP-16 capability contracts.

## GP-12 pack agent archetypes

GP-12 defines pack agents as declarative archetypes that a project resolves
into its own configuration, as GP-11 did for roles and with the same
mechanisms. It is a definition layer only. It creates no Runtime agent,
selects no model, activates no tool, adds no agent to a pipeline, makes no
agent eligible to approve anything and grants or enforces no capability.
Existing OfficeManifest, role, agent, pipeline and run-pin rows are neither
read nor written, agent sync and model routing are unchanged, and nothing is
scheduled from a resolved agent.

Model, tools, pipeline participation and approval eligibility are deliberately
not part of this contract. They belong to a later activation task that turns a
resolved archetype into a Runtime agent. GP-12 is therefore not the final agent
model: it fixes identity, the declarative references and their customization
and upgrade rules, and nothing else.

### Identity

Every resolved agent has a stable `agentId`:

- `pack:<packId>/agents/<localId>` for a pack agent;
- `project:agents/<localId>` for a project-added agent.

The `agentId` contains no pack version, manifest digest, title or description.
The pack ID and the agent local ID are the identity-bearing keys: a pack upgrade
that keeps both keeps the `agentId`, and changing either is a removal and an
addition, not a rename. The GP-06 `effectiveId` still carries the exact pack
tuple and changes with every pack version.

### Declarative references

A schema-1 pack agent may carry four optional fields. Each is a bare local ID,
or a list of bare local IDs, of a definition declared in the same manifest:

| Field          | Shape             | Names                                                         |
| -------------- | ----------------- | ------------------------------------------------------------- |
| `role`         | one local ID      | an item of `contributions.roles`                              |
| `prompts`      | list of local IDs | items of `contributions.prompts`                              |
| `knowledge`    | list of local IDs | items of `contributions.knowledge`                            |
| `capabilities` | list of local IDs | requested capabilities: items of `contributions.capabilities` |

The lists follow the GP-11 rules for a role's `capabilities`: every entry is a
valid, unique local ID; an empty array is rejected, because "none" has exactly
one encoding, the absent field; a list holds at most 1,000 entries; and the
validated manifest holds each list in
ascending code-unit order, so `manifestDigest` does not depend on the written
order. The bound is one constant of the contract package, shared with the
project mutation contract and the portable archive; it applies to a role's
`capabilities` as well. The contract package rejects, with a typed `DomainPackManifestError`
(`invalid_contribution`) and the path of the offending member: a malformed
`role`, a non-array list, an empty list, a list over the bound, a malformed or
duplicate entry, a
reference to a definition the manifest does not declare, and any of the four
fields on a contribution kind other than agents, where it remains an unknown
field (a role's own `capabilities` is the GP-11 field). References are bare
local IDs, so a cross-pack reference cannot be expressed: a definition declared
only in a dependency pack is an unknown reference.

The limit: an agent can request only capabilities its role declares.
`capabilities` requires `role`, and every entry must be in that role's
`capabilities` list. A request without a role, and a request for a capability
the role does not declare, fail with `invalid_contribution` at
`contributions.agents[i].capabilities` and
`contributions.agents[i].capabilities[j]`.

A requested capability is a declarative request inside the role's declared
set. It grants nothing, authorizes nothing and is not checked against
registered providers or capability policy; GP-16 owns capability contracts and
controlled-action authorization is unchanged.

This is an additive section-schema extension within manifest schema 1 and core
contract version 1. A manifest that omits the four fields keeps its canonical
form and digest; the four golden fixture digests are unchanged. A Runtime built
before GP-12 rejects a manifest that uses any of the fields as an unknown
field; it never ignores them.

### Project customization

| Intent  | Mechanism                         | Effect                                                                                              |
| ------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Rename  | `extend` override setting `title` | Presentation only. `agentId` and the pack's references are unchanged.                               |
| Replace | `replace` override                | The project's complete agent envelope substitutes the pack's. The slot and `agentId` stay.          |
| Disable | `disable` override                | The agent leaves `agents` and is listed in `disabledAgents`. Its references are not resolved.       |
| Add     | project-owned `agents` definition | A `project:agents/<localId>` agent that references project-owned definitions, without capabilities. |

Unlike a role's capability set, which stays pack-owned (GP-11), the reference
fields of an agent are project-controlled. A `replace` payload on a pack agent
is the complete envelope `id`, optional `title`, `description`, `role`,
`prompts`, `knowledge` and `capabilities`, with the list rules above. A field
the payload omits is absent from the resolved agent: a replacement without
`role` yields an agent with no role, and a replacement is never merged with
the pack's references. Every reference in an override is a bare local ID that
resolves in the namespace of the override's own pack tuple. Schema 1 has no
cross-pack and no pack-to-project reference, so a replaced pack agent cannot
name a project-owned role, prompt or knowledge entry.

`extend` stays descriptive: it fills only an absent `title` or `description`
and keeps every pack reference. A reference field in an extension, and on any
kind other than agents, is rejected (`protected_security_invariant`).

A project-owned agent (`put_owned`, kind `agents`) may carry `role`, `prompts`
and `knowledge`. They are bare local IDs that resolve to project-owned
definitions only. `capabilities` on a project-owned agent is rejected
(`protected_security_invariant`): project-added roles have no capabilities in
GP-11, so there is no set a request could stay within.

GP-12 widens the GP-07 override matrix: `disable` is supported for agents as
well as prompts and roles, and `replace` on an agent accepts the reference
fields. The mutation contract, the GP-06 re-check of stored state, both
storage schemas and the portable archive apply the same rule.

Validation happens in three places:

- **Mutation contract.** `put_owned` and `put_override` check shape before
  anything else: an entry that is not a local ID, a non-array or empty list, a
  list of more than 1,000 entries (`malformed_origin_reference`), a duplicate
  entry
  (`conflicting_ownership_metadata`), and `capabilities` without `role`
  (`agent_capability_exceeds_role`: with no role there is no set to request
  from). The stored lists are in ascending code-unit order.
- **Preview and apply of an override on a pack agent**, when the exact source
  manifest can be read, as GP-07 reads it for every override. A `role`,
  prompt, knowledge entry or capability the source manifest does not declare is
  reported as `source_definition_missing`; a requested capability outside the
  named role's declared set is reported as `agent_capability_exceeds_role`.
  Nothing is written while an issue is reported. `project:definition:show`
  reports the same issues for a stored replacement that arrived without this
  check, for example through restore.
- **GP-06 resolution**, which is the authority and fails closed, also for
  state that arrived by restore or changed under a binding change.

Only a `replace` on a pack agent or, since GP-13, on a pack workflow has its
references checked before it is stored. Every other mutation still passes the
GP-07 checks that are not about references: the entry and project revisions,
the pack closure collision of a project-owned definition, the source binding
and source existence of an override, and the field overlap of an `extend`.
Its references to other definitions, and its effect on definitions that
reference it, are not checked. In particular the references of a
project-owned agent and of a project-owned workflow are not checked at
mutation time. `project:definition:apply` therefore stores:

- omitting a role, or disabling a prompt, that an enabled agent names;
- adding a project agent that names a project role, prompt or knowledge entry
  that does not exist, or is disabled.

The configuration then fails closed at resolution
(`disabled_required_definition` or `missing_agent_reference`) and
`project:configuration:show` returns the diagnostic until the project corrects
it, by disabling or replacing the agent, restoring the definition or adding
the missing one. Nothing else is written or scheduled from the unresolved
state.

### Resolution

For every enabled agent the resolver resolves each reference inside the
agent's own namespace: the exact originating pack tuple for a pack agent,
replaced or not, and the project-owned definitions for a project-added agent.

| Finding                                                             | Code                            |
| ------------------------------------------------------------------- | ------------------------------- |
| A referenced role, prompt, knowledge entry or capability is missing | `missing_agent_reference`       |
| The bare reference exists only in other namespaces, more than once  | `ambiguous_reference`           |
| A referenced role, prompt or knowledge entry is disabled or omitted | `disabled_required_definition`  |
| A requested capability is outside the effective role's set          | `agent_capability_exceeds_role` |
| A stored override payload violates the mutation contract            | `unresolved_override`           |
| A stored project-owned agent violates the mutation contract         | `configuration_invariant`       |

The effective role's set is the pack-owned set of GP-11, which no override
changes. A disabled agent is not part of the configuration, so its references
are not resolved and cannot fail. No existing validation is weakened: omitting
a role or disabling a prompt that an enabled agent names now fails resolution,
exactly as omitting a role that an enabled workflow names does.

`project:configuration:show` exposes a derived agent contract view next to the
GP-11 role view:

- `agents`: one entry for every enabled agent, in the GP-06 definition order,
  with `agentId`, `effectiveId`, `origin` (`pack_owned` or `project_owned`),
  the effective `title` and `description` when present, `roleId` when the
  agent names a role, `prompts`, `knowledge`, `capabilities` and
  `customization` (`none`, `replace` or `extend`);
- `disabledAgents`: the `agentId` of every agent that is disabled, by a
  `disable` override or as a project-owned agent with `enabled: false`, in the
  same order.

Every reference in the view is a stable ID of the GP-11 form:
`pack:<packId>/<kind>/<localId>` or `project:<kind>/<localId>`, with kinds
`roles`, `prompts`, `knowledge` and `capabilities`. The lists are in ascending
local-ID order. `roleId` is the `roleId` of the GP-11 role view.

The view is derived from the effective definitions and is not part of the
version-1 `configurationDigest` material. The digest format and the documented
empty-input vector are unchanged, and a configuration that uses none of the
four fields keeps its digest. A pack agent's references are part of its pack
payload in `effectiveDefinitions`, and a project's replacement is part of the
overridden payload there, so the digest of a configuration that uses them
reflects them through that existing field.

### Upgrade and merge semantics

`project:pack:upgrade` (GP-08) carries agent customizations across a pack
version change with the GP-08 and GP-11 rules and no new mechanism. Stable
`agentId` values are identical before and after.

| Project state of the agent         | New pack version                                                 | Outcome                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not customized                     | Changed                                                          | The new template applies. Reported as a template change.                                                                                                                                                         |
| `replace`                          | Changed, the project's references still resolve                  | `retargeted`. The project's envelope wins whole and `upstream: changed` is reported.                                                                                                                             |
| `replace`                          | A referenced definition is gone, or the request exceeds the role | Blocks as `prospective_configuration_invalid` with the GP-06 code (`missing_agent_reference`, `disabled_required_definition`, `agent_capability_exceeds_role`).                                                  |
| `replace` without reference fields | The agent gains a role or references                             | `retargeted` with no issue. The replacement stays the complete envelope, so the agent still has no role and no references; the change is visible only as a `customized` template change and `upstream: changed`. |
| `extend`                           | Changed, extended fields still absent upstream                   | `retargeted`. The project's fields fill the gaps and the references are the new version's.                                                                                                                       |
| `extend`                           | Now sets a field the project extends                             | Blocks as `extend_conflict` until resolved with `convert_to_replace` or `remove_override`.                                                                                                                       |
| `disable`                          | Changed                                                          | `retargeted`. The agent stays disabled and `upstream: changed` is reported.                                                                                                                                      |
| Any override                       | Agent removed                                                    | Blocks as `source_definition_removed`. `retain_as_project_owned` is accepted only for a `replace` without reference fields; otherwise `remove_override`.                                                         |
| Any override                       | Pack removed                                                     | Blocks as `source_pack_removed`, resolved the same way.                                                                                                                                                          |
| Role omitted or prompt disabled    | An enabled pack agent now names it                               | Blocks as `prospective_configuration_invalid` (`disabled_required_definition`).                                                                                                                                  |
| Project-added agent                | Pack starts to provide the same kind and local ID                | Blocks as `prospective_configuration_invalid` (`duplicate_effective_definition`). The project agent is never discarded.                                                                                          |
| Project-added agent                | Anything else                                                    | Untouched.                                                                                                                                                                                                       |

A `prospective_configuration_invalid` issue carries the GP-06 code as its
`detail`, and its message ends with the GP-06 diagnostic, which names the
agent by effective ID and the reference or capability that failed. It is not
an override conflict, so no `--resolutions` entry answers it. The operator
resolves it explicitly before the upgrade, with `project:definition:apply`: by
changing the replacement so that it is valid against both versions (a
replacement can always drop the reference), or by removing the override, the
role omission or the prompt disable that causes it. Nothing is rewritten on the
project's behalf.

One sequence needs several steps. When the new version adds a new agent that
names a role the project omits or a prompt it disables, the upgrade blocks as
`prospective_configuration_invalid` (`disabled_required_definition`). The
agent cannot be disabled beforehand, because it does not exist in the current
version and an override must name a definition of the selected tuple. The
operator removes the omission, upgrades, disables the new agent and omits the
role again; each step is an explicit, audited change.

Appending the GP-06 diagnostic changed the message of every
`prospective_configuration_invalid` issue, including the cases that existed
before GP-12, and therefore the `planDigest` of such blocked plans. This is
harmless: a blocked plan cannot be approved, and `code` and `detail` are
unchanged.

`convert_to_replace` on an agent `extend_conflict` builds the replacement from
both sides: the project's `title` and `description` win where it set them, and
every other field, including `role`, `prompts`, `knowledge` and
`capabilities`, is taken from the new template. As in GP-11 the copied fields
become project values from then on.

`retain_as_project_owned` turns a `replace` override whose template is gone
into a project-owned agent. A project-owned agent can reference only project
definitions, and every reference of an override names a pack definition, so
retaining is valid only when the payload carries none of the four reference
fields. Otherwise it is an `invalid_resolution` and blocks; the operator
removes the override, or first replaces the agent without references. A
retained agent has a new `project:agents/<localId>` identity.

No upgrade silently recreates a disabled agent, discards a project-added
agent, resets an override or drops an upstream change. Conflict outcomes are a
pure function of the snapshot, the desired tuples, the resolutions and the
installed catalog, as in GP-08.

Capability review is deliberately not duplicated for agents. GP-11's
`roleCapabilityChanges`, `targetRoleCapabilities` and the `project:pack:apply`
guard stay keyed on role capability sets, and GP-12 adds no second report or
guard for agent requests. The role set is the approved bound: an agent request
is a declarative request inside it, the resolver rejects any request outside
it, and a version that widens a role's set is already refused by
`project:pack:apply` and approved through the upgrade plan. A change to a pack
agent, including its requested capabilities, is reported in the existing
template change list (`kind: agents`, `changed`, with `customized`), and
`project:pack:apply` applies it as it applies any other template change.

### Persistence

SQLite migration `0045` and PostgreSQL migration `20261006000100` widen the
`project_definition_override` operation constraint from "`disable` on prompts
or roles" to "`disable` on prompts, roles or agents". SQLite rebuilds the
table and copies every row; PostgreSQL drops the GP-11 constraint
`project_definition_override_operation_kind_payload_check` by name and adds it
back widened under the same name, leaving tenant ownership, keys and RLS
policies untouched. `0042`, `0044`, `20261003000100` and `20261005000100` are
not edited. Existing rows keep their values; a `disable` on any other kind is
still rejected by the constraint. The agent reference fields need no schema
change: both backends store a definition payload as JSON without a key
constraint.

Portable archive format 8 has the format-7 contents and additionally accepts a
`disable` override on an agent and the four reference fields in an agent
payload (three in a project-owned agent, which cannot carry `capabilities`).
A list in a format-8 payload must be in the order the mutation contract
stores: at most 1,000 valid local IDs, strictly ascending by code unit, so
also free of duplicates. Every Runtime path that stores a list writes that
order, so every state the Runtime wrote is exportable. A database edited by
hand to hold a list in another order still resolves, because the resolver
re-parses and orders stored lists, but it cannot be exported. An archive with
another order is rejected like any other malformed payload. Format 8 was
finalized before any release: its ordering and bound rules were added during
GP-12 hardening.
Formats 1–7 keep their readers and meanings, and format 7 still rejects both.
A backup is written as format 8 only when the project state contains an agent
`disable` override or an agent payload with a reference field; every other
state is written as before, byte for byte.

### Limitations and non-goals

- No Runtime agent or pack-owned Runtime identity is created, synced or
  activated. Model selection and model routing, tools, pipeline participation
  and approval eligibility are left to a later activation task.
- Requested capabilities are declarations within a role's declared set. No
  capability is granted or enforced.
- Project-added agents cannot request capabilities, because project-added
  roles cannot declare any (GP-11).
- References are local to one manifest or to the project. A replaced pack
  agent cannot name a project-owned role, prompt or knowledge entry, and a
  project-added agent cannot name a pack definition. Qualified cross-namespace
  references are not expressible in schema 1.
- Omitting a role or disabling a prompt that an enabled agent still names is
  accepted and stored, and the configuration then does not resolve. To keep it
  resolving, the project disables or replaces the agent first. A new agent of
  a later pack version can only be disabled after the upgrade.
- Local IDs have no length limit, for any definition kind. This predates GP-12;
  only the number of references in a list is bounded.
- An upgrade blocked by a customization that no longer resolves is resolved by
  editing or removing that customization, not by an upgrade resolution.

## GP-13 pack workflow templates

GP-13 lets a project customize a pack workflow, as GP-11 did for roles and
GP-12 for agents and with the same mechanisms. It is a definition layer only.
A pack workflow was already a schema-1 contribution (`id`, optional `title`
and `description`, `taskType` and ordered `stages` of `{ id, role }`) that
GP-06 resolves, and a project could already own workflows (GP-07). GP-13 adds
the missing part: `replace`, `extend` and `disable` on a pack workflow. The
manifest contract for workflows is unchanged.

Nothing here reaches the Runtime pipeline engine. No pipeline, run, run pin,
approval or guard is created, read or written, the OfficeManifest is not
touched, and nothing is scheduled from a resolved workflow.

### Identity

Every resolved workflow has a stable `workflowId`:

- `pack:<packId>/workflows/<localId>` for a pack workflow;
- `project:workflows/<localId>` for a project-owned workflow.

The `workflowId` contains no pack version, manifest digest, title or
description. The pack ID and the workflow local ID are the identity-bearing
keys: a pack upgrade that keeps both keeps the `workflowId`, and changing
either is a removal and an addition, not a rename. The GP-06 `effectiveId`
still carries the exact pack tuple and changes with every pack version.

A stage is identified by its `id` inside its workflow. Stage IDs are unique in
one workflow and carry no position: reordering stages keeps every stage ID,
and a replacement that keeps a stage ID keeps that stage. No upgrade renames a
stage; a new pack version that drops or renames one is a change of the
template's stage list.

### Project customization

| Intent                       | Mechanism                                    | Effect                                                                                                 |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Rename                       | `extend` override setting an absent `title`  | Presentation only. `workflowId`, task type and stages are the pack's.                                  |
| Replace                      | `replace` override                           | The project's complete workflow envelope substitutes the pack's. The slot and `workflowId` stay.       |
| Reorder, add, remove a stage | `replace` override with another stage list   | The resolved stages are exactly the list given, in the order given.                                    |
| Disable                      | `disable` override                           | The workflow leaves `workflows` and is listed in `disabledWorkflows`. Its references are not resolved. |
| Add                          | project-owned `workflows` definition (GP-07) | A `project:workflows/<localId>` workflow that references project-owned definitions.                    |

A `replace` payload on a pack workflow is the complete envelope `id`, optional
`title` and `description`, `taskType` and `stages`, with the shape and rules of
a project-owned workflow payload: `id` equals the source local ID, `taskType`
is a local ID, `stages` is an array of `{ id, role }` objects with local IDs,
unique stage IDs and at most 1,000 stages, and no other key is accepted. An
empty stage list is accepted, as it is for a pack and for a project-owned
workflow. A replacement is never merged with the pack's workflow: a field the
payload omits is absent, and the stage list is the payload's whole list.

Stage order is significant. It is stored, exported, restored and resolved
exactly as given and is never sorted, unlike the reference sets of an agent.

`extend` stays descriptive: it fills only an absent `title` or `description`
and keeps the pack's task type and stages. `taskType` or `stages` in an
extension is rejected (`protected_security_invariant`). There is no partial
stage edit: a stage change is a `replace` that carries the complete list.

`disable` carries no payload. A disabled workflow is not part of the
configuration, so its task type and stage roles are not required. This is what
lets a project omit a role (GP-11) that only that workflow used: disable the
workflow, or replace it with a stage list that no longer names the role, and
then omit the role.

Every reference in an override is a bare local ID that resolves in the
namespace of the override's own pack tuple. A stage of a customized pack
workflow can therefore name only a task type and roles of the same pack.
Schema 1 has no cross-pack and no pack-to-project reference, so a replaced
pack workflow cannot name a project-owned role or task type, nor one of
another pack, including a dependency.

GP-13 widens the GP-07 override matrix: `replace`, `extend` and `disable` are
supported for workflows. The mutation contract, the GP-06 re-check of stored
state, both storage schemas and the portable archive apply the same rule.
Policies, capabilities and validators still have no override operation.

Validation happens in three places, as in GP-12:

- **Mutation contract.** `put_override` checks shape before anything else: a
  payload that is not the typed envelope, an unknown key or a missing stage
  list (`protected_security_invariant`), a task type, stage ID or role that is
  not a local ID, a stage with other keys than `id` and `role`, more than
  1,000 stages (`malformed_origin_reference`), a duplicate stage ID
  (`conflicting_ownership_metadata`), and a payload on a `disable`
  (`malformed_origin_reference`).
- **Preview and apply of a `replace` on a pack workflow**, when the exact
  source manifest can be read, as GP-07 reads it for every override. A task
  type or a stage role the source manifest does not declare is reported as
  `source_definition_missing`, through the path GP-12 uses for an agent
  replacement, once per missing reference even when several stages name it.
  Nothing is written while an issue is reported.
  `project:definition:show` reports the same issues for a stored replacement
  that arrived without this check, for example through restore. It first
  re-checks every stored override against the mutation contract: an entry
  that violates it, for example a workflow or agent replacement edited by
  hand, is reported with the contract's own code and a message that says the
  stored override violates the override contract, not as an unavailable pack.
- **GP-06 resolution**, which is the authority and fails closed, also for
  state that arrived by restore or changed under a binding change.

Whether a referenced role is currently omitted is not checked when a mutation
is stored; it is a resolution-time check, as in GP-11 and GP-12. Omitting a
role that an enabled workflow names, or replacing a workflow so that it names
an omitted role, is accepted and stored, and the configuration then fails
closed at resolution until the project corrects it.

### Resolution

For every enabled workflow the resolver resolves the task type and every stage
role inside the workflow's own namespace: the exact originating pack tuple for
a pack workflow, customized or not, and the project-owned definitions for a
project-owned workflow. The codes are the GP-06 codes; none is added.

| Finding                                                            | Code                           |
| ------------------------------------------------------------------ | ------------------------------ |
| The task type or a stage role is missing from the namespace        | `missing_workflow_reference`   |
| The bare reference exists only in other namespaces, more than once | `ambiguous_reference`          |
| The task type or a stage role is disabled or omitted               | `disabled_required_definition` |
| A stored override payload violates the mutation contract           | `unresolved_override`          |
| A stored project-owned workflow violates the mutation contract     | `configuration_invariant`      |

This holds for a customized and for an uncustomized workflow alike. A disabled
workflow is not resolved, so its references cannot fail. No existing
validation is weakened.

`project:configuration:show` exposes a derived workflow contract view next to
the GP-11 role view and the GP-12 agent view:

- `workflows`: one entry for every enabled workflow, in the GP-06 definition
  order, with `workflowId`, `effectiveId`, `origin` (`pack_owned` or
  `project_owned`), the effective `title` and `description` when present,
  `taskTypeId`, `stages` (each `{ id, roleId }`, in the workflow's stage order)
  and `customization` (`none`, `replace` or `extend`);
- `disabledWorkflows`: the `workflowId` of every workflow that is disabled, by
  a `disable` override or as a project-owned workflow with `enabled: false`,
  in the same order.

Every reference in the view is a stable ID: `taskTypeId` is
`pack:<packId>/taskTypes/<localId>` or `project:taskTypes/<localId>`, and
`roleId` is the `roleId` of the GP-11 role view.

The view is derived from the effective definitions and is not part of the
version-1 `configurationDigest` material. The digest format and the documented
empty-input vector are unchanged, and a configuration without a workflow
override keeps its digest. A workflow customization is reflected by the
existing digest fields: the overridden payload in `effectiveDefinitions`, the
entry in `appliedOverrides` and `origins`, a disabled workflow in
`disabledDefinitions`, and the exact targets in `resolvedWorkflowReferences`,
which keeps its GP-06 form with effective IDs.

### Upgrade and merge semantics

`project:pack:upgrade` (GP-08) carries workflow customizations across a pack
version change with the GP-08, GP-11 and GP-12 rules and no new mechanism.
Stable `workflowId` values are identical before and after.

| Project state of the workflow | New pack version                                     | Outcome                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not customized                | Changed                                              | The new template applies. Reported as a template change.                                                                                                   |
| `replace`                     | Changed, the project's references still resolve      | `retargeted`. The project's envelope wins whole, including its stage order, and `upstream: changed` is reported.                                           |
| `replace`                     | Its task type or a stage role is gone, or is omitted | Blocks as `prospective_configuration_invalid` with the GP-06 code (`missing_workflow_reference`, `ambiguous_reference` or `disabled_required_definition`). |
| `extend`                      | Changed, extended fields still absent upstream       | `retargeted`. The project's fields fill the gaps and the task type and stages are the new version's.                                                       |
| `extend`                      | Now sets a field the project extends                 | Blocks as `extend_conflict` until resolved with `convert_to_replace` or `remove_override`.                                                                 |
| `disable`                     | Changed                                              | `retargeted`. The workflow stays disabled and `upstream: changed` is reported.                                                                             |
| Any override                  | Workflow removed                                     | Blocks as `source_definition_removed` until resolved with `remove_override`. `retain_as_project_owned` is refused.                                         |
| Any override                  | Pack removed                                         | Blocks as `source_pack_removed`, resolved the same way.                                                                                                    |
| Role omitted                  | An enabled pack workflow now names it                | Blocks as `prospective_configuration_invalid` (`disabled_required_definition`).                                                                            |
| Project-owned workflow        | Pack starts to provide the same kind and local ID    | Blocks as `prospective_configuration_invalid` (`duplicate_effective_definition`). The project workflow is never discarded.                                 |
| Project-owned workflow        | Anything else                                        | Untouched.                                                                                                                                                 |

A `prospective_configuration_invalid` issue is not an override conflict, so no
`--resolutions` entry answers it, as in GP-12. The operator resolves it
explicitly before the upgrade with `project:definition:apply`: by changing the
replacement so that it is valid against both versions, by disabling the
workflow, or by removing the override or the role omission that causes it.
Nothing is rewritten on the project's behalf.

`convert_to_replace` on a workflow `extend_conflict` builds the replacement
from both sides: the project's `title` and `description` win where it set
them, and every other field, including `taskType` and `stages` in the
template's order, is taken from the new template. As in GP-11 the copied
fields become project values from then on: a later upstream change to the
stage list is only reported as `upstream: changed`.

`retain_as_project_owned` is refused (`invalid_resolution`) for every workflow
override. A retained workflow would become a project-owned workflow, whose
bare `taskType` and stage roles resolve in the project namespace. The same
local IDs would then silently name different definitions, or none. So when
the template or the pack of a customized workflow is removed upstream, the
only accepted resolution is `remove_override`. Neither the upgrade plan nor
the `project.pack_upgrade_applied` audit event carries a definition body, so
the removed envelope cannot be recovered from them. An operator who wants to
reuse it captures it first, with `project:definition:show` or a backup, and
afterwards adds a project-owned workflow that names project definitions.

No upgrade silently recreates a disabled workflow, discards a project-owned
workflow, resets an override, reorders stages or drops an upstream change.
Outcomes are a pure function of the snapshot, the desired tuples, the
resolutions and the installed catalog, as in GP-08. The template change list
already reports workflow changes (`kind: workflows`, with `customized`); GP-13
adds no other report field.

### Persistence

SQLite migration `0046` and PostgreSQL migration `20261006000200` admit
`workflows` as an override kind and as a kind `disable` applies to. SQLite
rebuilds `project_definition_override` and copies every row. PostgreSQL
replaces two constraints: the column check on `kind`
(`project_definition_override_kind_check`, the name PostgreSQL gave it in
`20261003000100`) and the table check
`project_definition_override_operation_kind_payload_check`. Each is dropped by
name, which fails closed if it is absent, and added back widened under the
same name, which the drop has just freed. Tenant ownership, keys and RLS
policies are untouched. No earlier migration is edited. Existing rows keep
their values; an override on policies, capabilities or validators and a
`disable` on any kind other than prompts, roles, agents and workflows are
still rejected by the constraints. A workflow payload needs no further schema
change: both backends store a definition payload as JSON, and a JSON array
keeps its order on both.

Portable archive format 9 has the format-8 contents and additionally accepts
an override on a workflow: a `replace` with the workflow envelope, a
descriptive `extend` and a `disable`. The stage list of a format-9 payload has
at most 1,000 stages with unique stage IDs and is carried in the order given.
Formats 1–8 keep their readers and meanings, and format 8 still rejects every
workflow override. A backup is written as format 9 only when the project state
contains a workflow override; every other state is written as before, byte for
byte.

### Preservation and in-flight runs

A workflow customization writes the GP-07 definition tables and their audit
events, and an upgrade additionally the GP-05 binding tables. Nothing else is
read or written: OfficeManifest, role, agent, pipeline, pipeline run, run pin,
approval, guard, task and run rows stay byte-identical.

Runs do not pin pack configuration yet (GP-08): GP-06 exposes `pin` and
nothing persists it, and no pipeline run is created from a resolved workflow.
A workflow customization or an upgrade therefore cannot change, and is not
blocked by, a run in flight. Blocking a change on in-flight runs that pin a
pack workflow is deferred to GP-24, the task that persists those pins.

### Limitations and non-goals

- No domain-specific pipeline engine, no Runtime pipeline and no scheduling
  from a pack workflow. No approval or guard is declared or enforced by a
  workflow definition. Since GP-25 a pack may declare them for a workflow in
  a separate policy contribution, which is still not enforced (see the GP-25
  section).
- References are local to one manifest or to the project. A stage of a pack
  workflow, customized or not, cannot name a project-owned role or task type,
  and a project-owned workflow cannot name a pack definition. Qualified
  cross-namespace references are not expressible in schema 1.
- A stage change is a complete replacement. There is no per-stage insert,
  remove or move operation, and a replacement does not follow later upstream
  changes to the stage list; they are reported as `upstream: changed`.
- A workflow override cannot be retained as a project-owned workflow by an
  upgrade resolution.
- Omitting a role that an enabled workflow still names, or replacing a
  workflow so that it names an omitted role, is accepted and stored, and the
  configuration then does not resolve. To keep it resolving, the project
  disables or replaces the workflow first. A new workflow of a later pack
  version can only be disabled after the upgrade.
- A task type cannot be disabled by an override, so a pack workflow's task
  type can only be missing, never disabled; a project-owned task type can be
  disabled and then fails its project-owned workflows.
- The manifest contract does not bound a pack workflow's stage list. A
  `convert_to_replace` of a workflow with more than 1,000 stages yields a
  replacement the mutation contract rejects, so that upgrade blocks as
  `prospective_configuration_invalid` (`unresolved_override`).
- Changes are not blocked on in-flight pinned runs; see above (GP-24).

## GP-16 pack capability contracts

Status: implemented. The contract was approved by the owner on 2026-10-06
(scope option B2, every decision below at its default) and is unchanged;
"Implementation record" at the end of this section records what the code does
where the contract left a choice.

Depends on: GP-06. It reuses the additive schema-1 extension pattern of GP-11
and GP-12, the upgrade plan of GP-08 and the binding preflight of GP-22.

GP-16 is a definition-layer task. A pack capability may declare the operations
it needs, by name and mode, and whether it requires them. The Runtime host
exposes its registered connector descriptors read-only. Resolution, binding
preview and apply, and upgrade fail closed when a required operation has no
registered provider or the provider offers it in another mode. The resolved
view reports each binding. Nothing here grants, schedules or executes
anything: grants, constraints, approval and controlled execution are unchanged
and still separately authorize every use.

### Three meanings of "capability"

Three unrelated things share the word. GP-16 changes only the first.

| Meaning                 | Where                                                                                                 | What it is                                                                                              | Authorization use                                      | Owner             |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| Pack capability         | `contributions.capabilities`, referenced by pack roles (GP-11) and pack agents (GP-12)                | A declarative label; since GP-16 it may also name the operations it needs                               | None. A resolved binding is a report, not a permission | GP-16             |
| Legacy stage capability | `capabilities` of a legacy pipeline stage                                                             | Connector operation names, matched exactly against the requested operation, conjunctive with the policy | Yes, in the pipeline gate                              | GP-25 (pack form) |
| Capability grant        | `CapabilityGrant.actions` on a registered resource, with a Runtime agent or Runtime role as principal | The stored permission the policy engine evaluates, deny by default                                      | Yes, in the policy engine                              | Core (unchanged)  |

A grant principal is a Runtime agent ID or a Runtime role ID. A pack `roleId`
(`pack:<packId>/roles/<localId>`) is neither, so no grant can name a pack role
and a pack capability cannot reach a grant.

### Contract

A capability entry of `contributions.capabilities` gains two optional members.

- `operations`: an array of `{ "operation", "mode" }` objects. `operation` is
  an operation name in the connector registry's syntax, `<connectorId>.<name>`,
  matched exactly; `mode` is `read` or `mutation`. The array holds at least one
  and at most 100 entries (`maximumCapabilityOperations`), and an operation
  name appears once. It is a set: the validated manifest holds it in ascending
  code-unit order of the operation name, and that order is what the digest
  covers.
- `requirement`: `required` or `optional`. It is allowed only together with
  `operations`. When `operations` is present and `requirement` is absent the
  validated manifest holds `required`, so the default and the written default
  have one canonical form and one digest.

An operation name is ASCII: two or more segments separated by `.`, each
segment starting with a letter or digit and continuing with letters, digits,
`_` or `-`, at most 128 characters in all. A wildcard such as `fake.*` is not
a name.

Rejected with `invalid_contribution` and the member's path: a non-array,
empty, over-bound or duplicate `operations` list; a malformed operation name;
an unknown `mode`; an unknown `requirement`; `requirement` without
`operations`; any member of an operation entry other than `operation` and
`mode`; and either field on another contribution kind.

A pack cannot declare risk, approval, constraints, a resource, a grant, a
principal, a credential or a provider version. `riskLevel`,
`requiresApproval`, `constraints`, `resource`, `grant`, `principal`,
`credentialRef`, `version` and every other member are unknown fields.

Compatibility: this is an additive section-schema extension. The manifest
stays schema 1 and the core contract version stays 1. A manifest that uses
neither field has the same canonical form and `manifestDigest` as before, so
the four golden digests and the development pack digest are unchanged. A
capability with only an `id` remains a label and resolves as before. A reader
built before GP-16 rejects a manifest that uses the fields as unknown fields.

### Provider catalog

"Registered provider" means a connector descriptor of the host's composed
connector registry that lists the operation. The application layer reads it
through one read-only port, `OperationProviderCatalog`, which lists for each
provider its ID, its version and its operations with their mode. The port
exposes no connector function, resource type, risk level, approval flag,
grant or credential. The Runtime host builds the catalog at each command
composition from the same registry instance its controlled-action gateway
uses, as a frozen copy. The registry is static host composition, so every
composition of one program builds the same catalog. The resolver imports no
connector package.

"Bind" means: find the provider that lists the operation name, and compare the
mode. A binding is the pair of provider ID and version at the time of the
read. It is not stored.

### Resolution

`project:configuration:show` gains a derived `capabilities` view with one
entry for every capability of the resolved pack closure, selected packs and
transitive dependencies alike:

- `capabilityId`: `pack:<packId>/capabilities/<localId>`;
- `requirement`: `required` or `optional`; absent for a label;
- `operations`: for each declared operation its name, mode and `binding`,
  either `bound` with the provider's ID and version or `unbound_optional`. A
  label has an empty list.

The view is not digest material. The declaration is: it is part of the
capability's effective definition and of the pack's `manifestDigest`. The
provider binding is neither digest nor pin material, so the empty-input
vector and the digest of every configuration that uses no operation are
unchanged.

Resolution fails closed, with no view:

| Code                                   | When                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `missing_required_capability_provider` | A required operation is listed by no registered provider                            |
| `capability_provider_mismatch`         | A declared operation, required or optional, is listed by a provider in another mode |
| `configuration_invariant`              | The provider catalog cannot be read, or lists one operation more than once          |

The diagnostic names the pack, the capability and the operation, and nothing
else. An optional operation that no provider lists resolves and is reported as
`unbound_optional`.

The check covers the whole resolved closure and every declared capability,
whether or not a role or an agent references it. A capability has no override
and no project-owned form, so nothing a project does to a role or an agent,
including disabling it, hides a required operation.

### Binding preflight

`project:pack:preview` reports the same three codes as resolution
(`missing_required_capability_provider`, `capability_provider_mismatch` and
`configuration_invariant`) for the proposed closure, in the `issues` list
after a GP-04 failure and the GP-22 collisions and before the GP-11 refusal.
`project:pack:apply` refuses a changed selection with a typed error carrying
the code, writes nothing and adds no audit event.

The unchanged active selection takes two different paths:

- `project:pack:preview` of the unchanged selection resolves the closure and
  runs the provider check, like the GP-22 comparison. A provider that went
  missing after the binding was applied, or was never present on a host the
  project was restored to, is reported there.
- `project:pack:apply` of the unchanged selection stays the GP-05 no-op. It
  reads no artifact and no provider, raises no provider error, and writes
  nothing, also when preview reports an issue for that selection. It changes
  no authority, so it neither repairs nor refuses; the failure stays visible
  in preview and at resolution.

`project:pack:upgrade` reports the failure through its existing prospective
resolution, as issue `prospective_configuration_invalid` with the code as
`detail`; the approved apply is refused as `upgrade_blocked`, writes nothing
and adds no audit event.

### Upgrade

The upgrade plan gains `capabilityContractChanges`, covered by `planDigest`:
for each capability whose contract differs between the current and the
proposed resolved closure, the `capabilityId`, the added and the removed
operations with their mode, and the requirement before and after. The
requirement is reported for every listed capability, also when only an
operation changed, so the report always shows whether a change concerns a
required or an optional capability; `null` stands for a capability that is
absent or a label on that side. A changed mode is one removed and one added
entry. An added or removed capability is listed when it declares operations.
Like the GP-11 role capability report it is `unavailable` when the current
closure cannot be read.

A change to the contract of a capability present in both closures is never
incidental: `project:pack:apply` refuses it with
`capability_contract_change_requires_upgrade` and names
`project:pack:upgrade`. The `project.pack_upgrade_applied` audit event records
the same report: capability IDs, operation names, modes and requirements,
never a definition body.

### Owner decisions

1. Scope is resolution and binding preflight. There is no scheduler or run
   gate; see "Unmet relative to the original wording".
2. An "abstract operation" is the operation name in the existing registry
   syntax, matched exactly. A separate abstract contract ID that connectors
   declare they provide needs a connector SDK descriptor change and has no
   second provider before M13.
3. A declared `mode` that differs from the provider's descriptor fails closed.
4. A pack cannot pin a provider version or range. The view reports the bound
   version only.
5. Provider binding is not part of `configurationDigest` v1 or of `pin`. It is
   host-local availability, like installed-pack availability. See "ADR-0026
   narrowing".
6. An unbound optional operation resolves and is reported as
   `unbound_optional`.
7. A portable restore proceeds when a required provider is absent on the
   target host, as it does for packs that are not installed yet. Resolution is
   the backstop.
8. A change to an existing capability's operations or requirement is refused
   by `project:pack:apply` and carried only by `project:pack:upgrade`, with
   `capabilityContractChanges` under `planDigest`, mirroring GP-11.
9. A project cannot own or override a capability. Both stay unsupported.
10. The 14 development-pack capability labels gain no operations in GP-16.
    That belongs to GP-10C, and `packages/domain-pack-development` is not
    edited.
11. GP-25 depends on GP-16 for the operation vocabulary. (Superseded by the
    owner-approved GP-25 decision 4: GP-25 stage `operations` are opaque
    names, so GP-25 does not depend on GP-16.)

### ADR-0026 narrowing

ADR-0026 lists "registered capability providers" among the fixed inputs of
resolution that yield a stable `configurationDigest`. GP-16 narrows this on
purpose (decision 5). The text of ADR-0026 is not edited: it still names
registered providers as a fixed resolution input, and this section, by owner
decision, is the record of how far that holds. Registered providers are an
input of resolution: they
decide whether it succeeds and what the `capabilities` view reports. They are
not digest material and not part of `pin`. Two hosts with the same packs and
definitions compute the same `configurationDigest` whether or not they have
the same connectors, and a host that lacks a required provider computes none
because resolution fails.

The reason is the one GP-22 gives for pack availability: what a host has
installed is operational, host-local state, not portable project authority.
Putting a connector ID and version under the digest would make the digest
change when a host upgrades a connector, and would make an archive's recorded
digest unreproducible on another host. The consequence is recorded as a
limitation: the digest does not attest which provider version a host bound.
Pinning a binding on a run belongs to GP-24.

### Boundaries

**GP-25.** GP-16 owns the operation vocabulary a pack needs and whether a
provider exists. GP-25 owns where an operation is permitted or required in a
workflow: stage `capabilities`, `enforcement`, and the approval and separation
flags. GP-16 adds no field to workflows, stages or `policies` and does not
lift `unsupported_security_composition`. GP-25 stage `operations` are opaque
operation names compared exactly, not references to GP-16 capability
operations, so GP-25 does not depend on GP-16 (decision 11 is superseded).

**GP-14.** Validators reference separately installed adapter IDs and exact
versions with their own registration checks. GP-16 does not touch
`contributions.validators` and does not turn the connector registry into a
validator registry. Only the fail-closed availability pattern is shared.

**Controlled actions.** The policy engine, the pipeline gate, the approval
flow, the controlled-action gateway and their storage are not edited. A
request for an operation a bound pack requires is still denied without a
grant, with the same reason and the same audit payload as without the pack.

**PostgreSQL.** The provider catalog is storage-independent, and resolution,
binding preview, apply and upgrade behave the same on both backends. The
controlled-action evidence of criterion 11 is SQLite-only, because PostgreSQL
does not implement the `capabilities` and `controlled` storage ports. No
migration is added on either backend.

### Acceptance

1. A schema-1 capability entry accepts optional `operations` and
   `requirement`. A manifest without them keeps its canonical form; the four
   golden digests and the development pack digest are unchanged; an id-only
   capability remains a label and resolves as before.
2. The contract package rejects with `invalid_contribution` and the member
   path: a non-array, empty, over-bound or duplicate `operations` list; a
   malformed operation name or an unknown `mode`; an unknown `requirement`, or
   `requirement` without `operations`; any member other than `operation` and
   `mode`; either field on another contribution kind.
3. Negative: a capability entry that names `riskLevel`, `requiresApproval`,
   `constraints`, `resource`, `grant`, `principal`, `credentialRef` or a
   connector version is rejected as an unknown field.
4. `operations` is a set in one order; `manifestDigest` does not depend on the
   written order.
5. A read-only provider catalog port exposes, for the host's composed
   registry, each provider's ID, version and operations with mode. It exposes
   no connector function, resource, grant or credential. It is built from the
   host's composed registry at each command composition and frozen; the
   registry is static, so the catalog is the same for every composition of
   one program. The resolver stays free of connector imports. Recorded
   deviation: the proposal said "built once at composition, next to
   `installedPacks`"; the host composes per command, so the catalog is built
   per command composition.
6. `project:configuration:show` exposes the derived `capabilities` view. The
   view is not digest material; the empty-input vector is unchanged.
7. Fail closed at resolution: a required operation with no registered
   provider fails with `missing_required_capability_provider`; a mode mismatch
   fails with `capability_provider_mismatch`; no view is returned, and the
   diagnostic names only pack, capability and operation.
8. The check applies to the whole resolved closure, transitive dependencies
   included, and to every declared capability whether or not a role references
   it. A disabled role or agent does not hide a required operation.
9. Preflight: `project:pack:preview` reports the same issue;
   `project:pack:apply` and `project:pack:upgrade` refuse with a typed error,
   write nothing and add no binding or upgrade audit event. Applying an
   identical selection stays a no-op that reads no artifact; previewing it
   still runs the check (see "Binding preflight").
10. Upgrade: the plan carries `capabilityContractChanges` under `planDigest`;
    `project:pack:apply` refuses such a change to an existing capability with
    a code that names `project:pack:upgrade`; the upgrade audit event records
    identities only.
11. Grants stay separate (SQLite, real controlled-action gateway): with a pack
    bound whose required operation is provided by the fake connector and no
    grant, a request for that operation is denied with "no valid grant permits
    the operation". With a grant it follows the existing policy, approval and
    pipeline gates. Decisions, reasons and audit payloads are identical with
    and without the binding. The evidence is at request time: the policy
    engine, the approval requirement, and the pipeline gate for a request made
    by an AgentRun inside an enforced stage. Approval followed by execution is
    not part of it; see "Limitations and non-goals".
12. Adversarial: a grant whose `principalId` equals a pack `roleId` string
    matches nothing; a pack operation named with a wildcard (`fake.*`) is
    rejected by the contract; a pack naming a critical operation
    (`fake.admin`) changes no risk or approval requirement; a hand-edited
    catalog entry or stored state cannot make an unregistered operation appear
    bound; a provider catalog double that throws yields a typed resolution
    failure, not a bound view.
13. Negative: no row is written to resource, grant, action, approval or
    simulation tables by any GP-16 path. The architecture test rule that
    `ReadProjectConfiguration` is not used under
    `packages/application/src/runtime` is unedited: no scheduler, run or
    pipeline module reads the provider binding, and no run is refused by it.
14. Restore: a format-9 archive with a binding whose required provider is
    absent on the target restores; resolution then fails with the code of
    criterion 7.
15. End to end over the Unix socket, using the fake connector of the default
    registry and a test-supplied pack catalog: show bound, show unbound
    optional, show failing required, preview and apply refusal, upgrade with a
    contract change.
16. PostgreSQL: the PostgreSQL-gated suite runs binding preview, apply and
    upgrade refusal and resolution with the same codes. Criterion 11 is
    SQLite-only, as stated under "Boundaries". No migration is added on either
    backend.
17. Docs: this section, the roadmap, the architecture overview and the
    contract README.

### Unmet relative to the original wording

The task row read: "Declare required/optional abstract operations; bind
registered providers at bootstrap; reject missing required provider before
runs; grants still separately authorize use." Three parts of it are
deliberately not delivered as written.

- **A gate before runs.** "Reject missing required provider before runs" is
  delivered as a rejection at resolution, binding and upgrade, not as a
  scheduler or run gate. The Runtime does not consume the resolved
  configuration, runs do not pin it and the production pack catalog is empty,
  so a run cannot be refused by a pack contract today, and no run is. The run
  gate belongs to the execution parity task
  `a45ddb12-3159-4b60-9b8b-c26516720834`, together with GP-24, which persists
  the pins a gate would check.
- **Abstract operations.** An operation is a concrete connector operation
  name, not a provider-independent contract ID (decision 2). The registry
  namespaces every operation by its connector, so two providers cannot offer
  the same name. Provider-independent contracts need a connector SDK
  descriptor change and a second provider, which arrives with M13.
- **Binding as a resolution input under the digest.** See "ADR-0026
  narrowing".

### Limitations and non-goals

- No scheduler gate, run gate or run pin (`a45ddb12`, GP-24).
- No stage, workflow or policy semantics (GP-25) and no validator adapters
  (GP-14).
- No pack-granted authority and no credentials. A binding creates no
  resource, grant, action, approval or simulation.
- No provider version pin or range, and no choice between providers.
- The binding is read when the configuration is resolved. It is not stored,
  not audited on read and not attested by `configurationDigest`.
- A capability cannot be owned, overridden or disabled by a project.
- The development pack declares no operations (GP-10C).
- No migration, no portable archive format change and no new storage port.
- `project:pack:apply` to the empty selection and then to a new pack version
  carries a contract change without the upgrade review, because after the
  first step no capability is present in both closures. GP-11 has the same
  property for role capabilities. It moves no authority: a binding grants
  nothing, and the provider check still runs on the second apply.
- The with and without binding comparison of criterion 11 does not run
  approval followed by execution. The fake connector declares
  `supportsExecution: false` and has no `invoke`, so that pair needs the
  filesystem connector and its simulation flow. Fresh authorization at
  execution uses the same policy evaluation that the comparison covers at
  request time, and no GP-16 module is imported by it.

### Implementation record

- Contract: `packages/domain-pack-contracts/src/manifest.ts`
  (`CapabilityContribution`, `CapabilityOperation`,
  `maximumCapabilityOperations`). The bound of 100 operations and the name
  syntax were chosen here; the brief left both open.
- Port: `packages/application/src/ports/operation-provider-catalog.port.ts`.
  The Runtime host adapter is
  `packages/runtime-host/src/operation-provider-catalog.ts`, built in
  `runtime-command.ts` from the registry instance the command context holds;
  `ConnectorRegistry.descriptors()` is the one addition to the connector SDK.
  The catalog is built with each command composition, as the registry itself
  is, and is the same for every composition of one program.
- Binding rules and the contract difference:
  `packages/application/src/domain-pack/capability-contracts.ts`, one
  computation shared by resolution, the binding preflight and the upgrade
  plan.
- The provider catalog is an optional dependency of the resolver, the
  configuration reader, the binding service and the upgrade service. When it
  is absent they use the empty catalog: a required operation fails closed
  with `missing_required_capability_provider`, an optional one is reported as
  `unbound_optional`, and nothing is bound by omission. The Runtime host
  always supplies it.
- A mode mismatch fails closed for an optional operation as well as for a
  required one. An optional operation is `unbound_optional` only when no
  provider lists its name.
- A provider catalog that throws or returns a malformed list, and one that
  lists an operation name under two providers, fail as
  `configuration_invariant` with a fixed message; the cause is not reported.
  The catalog is read only when some capability of the closure declares an
  operation, so a configuration of labels never depends on it.
- The view lists every capability of the closure, labels included, ordered by
  pack ID and then local ID. A label has no `requirement` and an empty
  `operations` list.
- Binding apply raises `ProjectPackBindingProviderError` for the provider
  codes and the existing `ProjectPackBindingRefusedError` for
  `capability_contract_change_requires_upgrade`. Preview of the unchanged
  selection runs the provider check when the closure resolves, like the GP-22
  comparison. When the current closure cannot be read,
  `capabilityContractChanges` is `unavailable` and the existing GP-11 rule
  decides: only a pure removal is applied.
- Every entry of `capabilityContractChanges` carries `requirement` with
  `before` and `after`, changed or not. An earlier revision of this branch
  omitted it when only an operation changed; adding it changed `planDigest`
  material, which no stored state depends on.
- A capability added or removed by a selection change is listed in
  `capabilityContractChanges` but is not a change to an existing capability,
  so `project:pack:apply` carries it. A label that gains operations, and a
  capability that loses them, are changes to an existing capability.
- The upgrade plan has no separate list of the target's contracts. The
  proposed tuples and their manifest digests are under `planDigest` and
  determine every contract, also when the current closure cannot be read.
- Portable restore is not edited: it never consulted providers, and a
  restored binding whose provider is missing fails at resolution.
- Tests: `tests/unit/pack-capability-contracts.test.ts`,
  `tests/integration/pack-capability-contracts.test.ts` (SQLite, and
  PostgreSQL when `AI_OFFICE_TEST_POSTGRES_URL` is set; added to the
  PostgreSQL CI job), `tests/integration/pack-capability-grants.test.ts`
  (SQLite, real policy engine and gateway) and
  `tests/e2e/pack-capability-contracts.test.ts`.

## GP-10A development roles and task defaults

Status: implemented. The owner approved the contract below on 2026-10-06.
"Implementation record" at the end of this section records what was built
where the contract left a choice, and where the evidence stops.

Formal scope:

> Define the development domain pack as a committed reference artifact and
> prove parity with the legacy development defaults over the subset
> expressible by the current pack contract. No Runtime consumption, catalog
> registration, implicit adoption, or legacy-path removal occurs in GP-10A.

Anti-goal:

> GP-10A MUST NOT make the development pack authoritative for Runtime
> execution.

The property GP-10A proves is **expressible-subset parity**: the development
pack and the legacy development defaults are equal over the subset that the
current pack contract (schema 1) can represent. It is not complete
equivalence of Runtime behaviour and it is not execution parity. A project
bound to the pack still runs on its OfficeManifest, its Runtime roles and its
Runtime agents, exactly as before; comparing execution from a resolved
configuration with legacy execution stays with the Runtime task
"Runtime resolved-configuration execution parity"
(`a45ddb12-3159-4b60-9b8b-c26516720834`).

Nothing was removed from the legacy path. `agents/`, the default office
manifest, `officeTaskKinds`, the agent definition loader and
`SyncAgentDefinitions` are unchanged and remain the only source the Runtime
reads. The pack repeats the expressible part of those defaults as a second,
verified description; a test fails when the two drift apart.

### Decisions

1. Defining the defaults in the pack means a verified reference artifact. The
   legacy path is neither removed nor modified.
2. The pack lives in `packages/domain-pack-development/`, is data only and is
   not registered in any catalog.
3. Its identity is `org.ai-office.development@0.1.0`. The contract fixture
   `tests/fixtures/domain-pack/development.json` (`@1.0.0`) is a different,
   unrelated artifact and is unchanged.
4. The 14 legacy role capabilities are declared as id-only capability
   contributions. They are descriptive labels, not GP-16 capability contracts,
   and grant nothing.
5. The legacy office role `purpose` maps to the pack role `description`. The
   mapping is covered by a test.
6. Agents declare no capabilities: the legacy state has no per-agent set.
7. Parity is verified twice: against the GP-09 fixture profile, and against
   the defaults actually shipped in the repository (`agents/` and the default
   office manifest) through the real loader and sync.
8. The pack contract is not extended.
9. The pack is neither registered nor adopted; that is GP-10C.

### Reference pack

The manifest declares exactly:

- four roles, `architect`, `developer`, `reviewer` and `qa`, each with the
  legacy title, the legacy `purpose` as `description`, and the capability set
  of the Runtime role of the same key;
- four agents with the same IDs, each naming the role of its ID and nothing
  else;
- five task types, `feature`, `bugfix`, `maintenance`, `research` and
  `release`, by ID only;
- the 14 role capabilities, by ID only.

It declares no workflow, prompt, knowledge entry, policy, artifact type,
evidence type or validator, and no agent capability. Those belong to GP-10B
and GP-10C.

### Expressible-subset parity

Both sides are projected into one comparison shape and must be equal:

- a role: `id`, `title`, `description`, capability set;
- an agent: `id`, `role`;
- the task type IDs.

One side is the resolved configuration (GP-06) of a project that holds the
default legacy state and is bound to the pack through a catalog the test
supplies. The other side is the GP-09 legacy development profile of the same
project. The comparison runs on the GP-09 fixture state and, separately, on
legacy state built from the shipped `agents/` directory and the shipped
default office manifest. The second comparison is the drift guard on the
defaults that are actually distributed: it fails when a shipped default
changes and the pack does not.

Two points found after GP-09 shape this:

- **Runtime role name.** GP-09's `runtime_role_fields_not_expressible` gap
  lists `guidance`, `limits`, `modelPolicy`, `tools` and `version`. It does
  not list the Runtime role `name` (`software-architect`, for example), which
  the pack vocabulary cannot express either. The name is added to the list
  below. The frozen GP-09 profile is not edited.
- **Synthetic guidance in the GP-09 fixture.** The GP-09 fixture's
  `runtime-definitions.json` carries one-line guidance written for the
  fixture, not the shipped `system.md` files. Its pinned digest therefore
  says nothing about the real defaults, and parity with the fixture does not
  prove parity with what the repository ships. Hence the separate comparison
  with the shipped artifacts.

### Outside pack vocabulary

Every legacy field of the four roles, four agents and five task kinds is
either in the projection above or in this list, never both and never
neither. The list is a committed artifact that a test verifies; it also
holds the pipeline, approval and check semantics that a schema-1 pack
workflow cannot express. Each entry names the task that owns it next: GP-10B,
GP-10C, or the Runtime execution parity task `a45ddb12` (in full
`a45ddb12-3159-4b60-9b8b-c26516720834`).

| Subject      | Field                         | Owner    | GP-09 gap code                                                 |
| ------------ | ----------------------------- | -------- | -------------------------------------------------------------- |
| office role  | `responsibilities`            | GP-10B   | `role_fields_not_expressible`                                  |
| Runtime role | `name`                        | a45ddb12 | none (missing from GP-09's list)                               |
| Runtime role | `version`                     | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | capability order              | a45ddb12 | none                                                           |
| Runtime role | `tools`                       | GP-10C   | `runtime_role_fields_not_expressible`                          |
| Runtime role | `modelPolicy`                 | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | `limits`                      | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | `guidance`                    | GP-10B   | `runtime_role_fields_not_expressible`                          |
| agent        | `enabled`                     | a45ddb12 | none                                                           |
| task kind    | `pipelineId`                  | GP-10B   | none                                                           |
| pipeline     | `defaultFor`                  | GP-10B   | `pipeline_routes_several_task_kinds`                           |
| pipeline     | `enforcement`                 | GP-10B   | `pipeline_fields_not_expressible`                              |
| stage        | `name`                        | GP-10B   | `stage_fields_not_expressible`                                 |
| stage        | `objective`                   | GP-10B   | `stage_fields_not_expressible`                                 |
| stage        | `checks`                      | GP-10B   | `stage_fields_not_expressible`                                 |
| stage        | `requiresApproval`            | GP-10B   | `stage_fields_not_expressible`                                 |
| stage        | `capabilities`                | GP-10B   | `stage_fields_not_expressible`                                 |
| stage        | `requiresIndependentApproval` | GP-10B   | `stage_fields_not_expressible` if used; unused by the defaults |
| stage        | `requiresDifferentAgentFrom`  | GP-10B   | `stage_fields_not_expressible` if used; unused by the defaults |

The owners above are the ones GP-10A assigned. GP-10B has since been split.
The GP-10B-1 section holds the list as GP-10B-1 left it, and the "GP-10B-2 PR 2
development pack 0.3.0" section holds the current list with the current
owners.

`limits` is the Runtime limit set (`maxIterations`, `maxCostMicros`,
`timeoutSeconds`). `guidance` is the role's system instructions, the shipped
`system.md`. `pipelineId` is the routing of a task kind to a pipeline.
Capability order: the Runtime stores a role's capabilities as an ordered
list, and a pack role holds a set.

The last two rows are legacy stage fields that the default state does not
use: neither the shipped default office manifest nor the GP-09 fixture sets
them, so GP-09 reports no gap for them there. They are listed because a
schema-1 workflow cannot express an independent-approval flag or a
separation constraint, and they carry `inDefaultState: false` in the
artifact; every other entry was observed in the default state and carries
`true`. A test fails if the default state starts using either field, or if
an entry marked unused is not a legacy stage field that GP-09 reports once a
stage uses it.

The list covers the fields of roles, agents, task kinds, pipelines and
stages. It does not cover the manifest's `office.name`, `project` model or
`provenance`, and the order of roles, agents and task kinds is not compared.

A pipeline's `id`, `name` and `description` and a stage's `id` and `roleId`
are expressible by a schema-1 workflow. They are absent from the pack because
workflows are GP-10B, not because the vocabulary lacks them, so they are not
in the list.

### Acceptance

1. The committed manifest passes `verifyDomainPackManifest` against core
   contract 1 and its `manifestDigest` equals a pinned literal. It fails if
   the bytes change without a version change.
2. It declares exactly the roles `architect`, `developer`, `reviewer` and
   `qa`, the agents of the same IDs each naming its role, and the five task
   types. It fails on any extra, missing or renamed ID.
3. It contains no workflows, prompts, knowledge, policies, artifact or
   evidence types, or validators, and no agent capabilities. It fails if
   GP-10B or GP-10C content appears.
4. For a project holding the default legacy state and bound to the pack
   through a test-supplied catalog, the projection of the resolved
   configuration equals the projection of the GP-09 legacy profile for every
   role (`id`, `title`, `description` from `purpose`, capability set), agent
   (`id`, `role`) and task type. It fails on any difference.
5. The same holds when the legacy state is built from the shipped `agents/`
   directory and the shipped default office manifest through the real loader
   and sync. It fails if a shipped default changes without the pack changing.
6. Every legacy field of the four roles, four agents and five kinds is either
   in the projection or in the pinned outside-pack-vocabulary list. It fails
   if a field is in neither or in both.
7. The outside-pack-vocabulary list is a committed, test-verified artifact.
   It contains every role-side GP-09 `vocabularyGaps` entry for the default
   state plus tools, modelPolicy, limits, guidance, responsibilities, Runtime
   role name, capability order, agent enabled, and the pipeline, approval and
   check semantics not expressible by the pack workflow; every entry names
   its owner. It fails if a GP-09 role gap, a listed field or an owner is
   missing.
8. Changing one title, description, capability, agent role or task-type ID in
   a copy of the pack makes the parity comparison fail. It fails if the
   comparison is vacuous.
9. Binding the pack leaves the legacy profile digest equal to the GP-09
   pinned vector, and the GP-09 frozen fixture files are byte-identical. It
   fails on any change.
10. `project:configuration:show` for an unbound project and the empty-digest
    vector are unchanged. It fails if either changes.
11. The default production catalog contains no pack and no project gains a
    binding from install, sync or restore. It fails if the pack is resolvable
    without a test-supplied catalog.
12. No file under `packages/domain`, `packages/application`,
    `packages/runtime-host`, the storage packages or `apps` imports the pack
    package or contains its ID. It fails mechanically in the architecture
    test.
13. The pack package imports only `domain-pack-contracts`. It fails on any
    other import.
14. No migration, archive format, audit event type, CLI command or
    contract-package change is in the diff. It fails if one appears.
15. `agents/`, the default office manifest, `officeTaskKinds`, the loader and
    sync are byte-identical to the base. It fails if a legacy default is
    edited.
16. The documentation names the claim expressible-subset parity, carries the
    formal scope and the anti-goal verbatim, lists the residue with owners,
    records the two GP-09 points, and states that nothing was removed. It
    fails if it says the defaults left the legacy path or claims execution
    parity.

### Non-goals

- No registration, install or adoption of the pack (GP-10C).
- No contract or schema extension.
- No workflows, routing, prompts or guidance text (GP-10B).
- No Runtime roles or agents created from archetypes.
- No generalisation of `officeTaskKinds`.
- No specialists from `agent-catalog/`.
- No removal or modification of any legacy default.
- The pack is not authoritative for Runtime execution.

### Implementation record

- Package. `packages/domain-pack-development/` holds `manifest.json`,
  `outside-pack-vocabulary.json`, a `package.json` that makes it a workspace
  member, and a README. It has no source file, so it imports nothing; the
  architecture test allows a future source file to import only
  `domain-pack-contracts`. No path alias, dependency or production file
  names the package or its ID, and `bun.lock` lists it as a workspace only.
- Manifest. Schema 1, `coreContract` `[1, 2)`, no dependency. Roles are in
  the default office manifest's order and task types in `officeTaskKinds`
  order; neither order is compared. A role's capability list is written in
  code-unit order, the order the contract validates it to. Task types,
  agents and capabilities carry no title or description: the legacy state
  has none to copy.
- Pinned. `manifestDigest` is
  `sha256:cda1c5fc48b5e04d75905d00f0f5d2b41a69e497eb4cc009a3aa77cfc2dac567`.
  The test also pins the digest of the file's exact bytes, so a formatting
  change at version `0.1.0` fails too.
- Capabilities. The 14 IDs are `approve_or_reject`, `assess_security`,
  `assess_tradeoffs`, `create_patch`, `decompose_work`, `derive_test_cases`,
  `inspect_code`, `inspect_diff`, `inspect_project`, `inspect_tests`,
  `modify_code`, `propose_adr`, `report_regressions` and `run_tests`. They
  are the union of the four shipped `agent.yaml` capability lists; `run_tests`
  is held by both `developer` and `qa`.
- Projection. `tests/helpers/development-pack-parity.ts` is test code and
  the only place the two sides meet. The legacy side reads the profile's
  office-derived `roles`, `agents` and `taskKinds`: a role's capabilities are
  those of the Runtime role of the same key, as a set; an agent is its name
  and the office role it serves. The pack side reads every enabled role,
  agent and task type of the resolved configuration by local ID, whatever
  its origin, so a definition the project adds would break the comparison
  as it should. `runtimeOnly` roles and agents are not development defaults
  and are not projected; in the GP-09 fixture that is the `security`
  specialist and the unused `release-engineer` role.
- Binding in tests. A test builds an `InMemoryInstalledDomainPackCatalog`
  with one trusted test installer, registers the committed bytes and binds
  the project through `ManageProjectPackBinding.apply`, or through
  `project:pack:apply` over the socket. No production path does either.
- Two comparisons. On the GP-09 fixture, the committed pre-pack dump is
  replayed and migrated to head. On the shipped defaults, a project is
  given the shipped default office manifest through `ApplyOfficeManifest`
  and the shipped `agents/` directory through `YamlAgentDefinitionLoader`
  and `SyncAgentDefinitions`; an end-to-end case does the same with
  `install` and `agent:sync` over the Unix socket. Edited copies of the
  shipped files show the guard works: a capability added, removed or
  renamed, a role key, a title or a purpose breaks parity.
- Task types. The five kinds are defined by the domain constant
  `officeTaskKinds`, not by the shipped office manifest, so the task-type
  drift guard watches that constant.
- What the drift guard does not see. A change to a field in the list above
  (guidance text, model policy, the Runtime role name, for example) leaves
  the expressible subset equal. The test asserts that too, so the limit of
  the claim is itself pinned.
- Completeness is decided by mutation, not by a second hand-written list:
  each legacy field of the profile is changed in a copy, and the field counts
  as projected when the projection changes. It must then be absent from the
  list, and a field that does not change the projection must be in it.
  Capability order is the one aspect entry: the field is projected as a set
  and only its order is outside.
- List of fields outside the vocabulary. `outside-pack-vocabulary.json`
  holds the table above with a reason per entry: 19 entries, 17 observed in
  the default state and 2 legacy stage fields it does not use. A test checks
  its shape and owners, that it carries every GP-09 `vocabularyGaps` field
  of the default state (pipeline and stage gaps included), that each GP-09
  code it cites reports that field exactly when the entry is marked as in
  the default state, on the GP-09 fixture and on the shipped defaults, and
  that the table in this section equals it entry for entry. (Since GP-10B-1
  that comparison is made with the table of the GP-10B-1 section. The table
  in this section is checked for its fields and gap codes against the list
  and for the owners GP-10A assigned as literals.)
- Owners. `tools` is assigned to GP-10C, which puts capability declarations
  behind pack contracts; Runtime role name, version, capability order, model
  policy, limits and agent enablement to the execution parity task;
  responsibilities, guidance, routing and every pipeline and stage field to
  GP-10B.
- Unchanged. The legacy profile digest of the fixture project is the GP-09
  vector before and after the binding, every legacy row is the same, and a
  test pins the checksum of each GP-09 fixture file. An unbound project
  still resolves to the empty configuration at its pinned digest, also on a
  host whose catalog holds the pack.
- Architecture scans. The checks for criteria 11 to 13 are textual,
  mechanical guards: they catch a literal import, the literal pack ID, a
  literal `installedPacks` supplied outside the option plumbing and a
  literal catalog `register` call. They are not tamper-proof against a
  constructed string, a `require` or a catalog passed positionally.
- Criteria 14 and 15 are properties of this change set, not of the code.
  They were checked on the diff against the base commit: it touches only
  the plan, the roadmap, the architecture overview, the README, `bun.lock`,
  the new package and tests. No test keeps them true afterwards; a later
  edit of a legacy default is caught by the drift guard only where it
  changes the expressible subset.
- PostgreSQL. Nothing here reaches storage code, so no PostgreSQL-gated
  suite covers it and none was added.
- No migration, archive format, audit event type, CLI command, Runtime code
  or contract-package change was added.

## GP-10B-1 development workflow templates

Status: implemented. The owner approved the contract below on 2026-10-06.
"Implementation record" at the end of this section records what was built
where the contract left a choice, and where the evidence stops.

Formal scope:

> Extend the development reference pack `org.ai-office.development` from
> `0.1.0` to `0.2.0` with the four development workflows, within manifest
> schema 1, and prove parity with the legacy default pipelines over the subset
> expressible by the current pack contract. No contract change, Runtime
> consumption, catalog registration, adoption or legacy-path removal occurs
> in GP-10B-1.

Anti-goal:

> the pack must not become authoritative for Runtime execution without a
> separately approved task

The property GP-10B-1 proves is **expressible-subset parity for workflows**:
the workflows of the development pack and the legacy default pipelines are
equal over the subset that a schema-1 workflow can represent. That subset is
a pipeline's `id`, `name` and `description`, the ordered stage sequence of
stage `id` and role, and one task type per workflow. It is not equality of
the whole legacy pipeline and it is not execution parity. A project bound to
the pack still runs on the pipelines of its OfficeManifest, exactly as
before; comparing execution from a resolved configuration with legacy
execution stays with the Runtime task
"Runtime resolved-configuration execution parity"
(`a45ddb12-3159-4b60-9b8b-c26516720834`).

Nothing was removed from the legacy path. The default office manifest, its
four pipelines, `officeTaskKinds`, the instruction builder and the
requirement assessment are unchanged and remain the only source the Runtime
reads. Prompts were not delivered: the pack's `prompts` list stays empty, and
role guidance, instruction-contract texts and the requirement-assessment
prompt are not in the pack.

### Decisions

The owner approved these on 2026-10-06.

1. GP-10B is split. GP-10B-1 is this task. GP-10B-2 is the descriptive
   contract extension and the prompts, Runtime task
   `e890324a-ecd4-4fcc-b1f8-37fdbdaca319`.
2. The plan row no longer says that the templates go behind pack defaults.
   GP-10B-1 defines the workflows as a reference artifact and removes
   nothing.
3. The `delivery` workflow declares `taskType: feature`. The legacy route
   `maintenance -> delivery` is residue.
4. A workflow's ID is the legacy pipeline ID, and the legacy pipeline `name`
   maps to the workflow `title`.
5. Role guidance is not stored in a prompt `description`.
6. An additive schema-1 extension and portable archive format 10 are approved
   in principle for GP-10B-2 only. GP-10B-1 changes neither.
7. The five governance entries move to a new policy task, "GP-25 — Pack
   policy contribution contract", Runtime task
   `1a883c04-0905-4b36-a57b-12d45fdfd59f`: pipeline `enforcement`, and stage
   `requiresApproval`, `requiresIndependentApproval`,
   `requiresDifferentAgentFrom` and `capabilities`. The number GP-25 is
   provisional, and the task needs an owner-approved scope proposal.
8. The execution parity task `a45ddb12-3159-4b60-9b8b-c26516720834` depends on
   GP-10B-1, GP-10B-2 and the policy task (GP-25).
9. Instruction-contract texts and the requirement-assessment prompt are not
   part of GP-10B-1. They belong to GP-10B-2.
10. GP-10B touches `prompts` only and never `knowledge`, which is GP-15.
11. The frozen GP-09 profile and its gap codes stay untouched.

### Reference pack

`org.ai-office.development@0.2.0` declares the roles, agents, task types and
capabilities of `0.1.0` unchanged, and exactly four workflows:

| Workflow    | Title            | Task type  | Stages, as stage ID (role)                                                        |
| ----------- | ---------------- | ---------- | --------------------------------------------------------------------------------- |
| `delivery`  | Feature delivery | `feature`  | `design` (architect), `implement` (developer), `review` (reviewer), `verify` (qa) |
| `bugfix`    | Bug fix          | `bugfix`   | `reproduce` (qa), `fix` (developer), `review` (reviewer)                          |
| `discovery` | Research         | `research` | `investigate` (architect)                                                         |
| `release`   | Release          | `release`  | `readiness` (reviewer), `verification` (qa)                                       |

Each workflow also carries the legacy pipeline `description`. `prompts`,
`knowledge`, `policies`, `artifactTypes`, `evidenceTypes` and `validators`
stay empty, and no agent names a prompt or a knowledge entry.

### Expressible-subset parity for workflows

Parity is semantic and limited to the expressible subset. The GP-10A
comparison shape gains two parts, and both sides must be equal on them:

- a workflow: `id`, `title` (the legacy `name`), `description`, its task
  types, and the ordered stage sequence of `id` and `role` (the legacy
  `roleId`);
- the expressed routes, each a task type and the workflow it routes to.

Stage order is compared. The order of the workflows is not, as for roles and
agents.

Every pack route is a legacy route. The legacy state has one more: the
`delivery` pipeline is the default for `feature` and for `maintenance`, and a
schema-1 workflow names one task type. The only legacy route missing from the
pack is `maintenance -> delivery`. The comparison leaves out the route of the
`maintenance` task kind on the legacy side, and a test pins the difference
between the two route sets as that one literal route.

Every other legacy pipeline or stage field is outside the comparison and is
in the list below. The comparison runs on the GP-09 fixture state and on
legacy state built from the shipped defaults, as in GP-10A.

### Residue

`outside-pack-vocabulary.json` still holds the 19 entries of GP-10A, among
them the 12 that GP-10A assigned to GP-10B; none is removed or merged. Each
entry now states separately what GP-10B-1 delivers and what remains outside
the pack, and names the task that owns the residue: GP-10B-2, GP-25, GP-10C
or the Runtime execution parity task `a45ddb12` (in full
`a45ddb12-3159-4b60-9b8b-c26516720834`). This table is the list as GP-10B-1
left it; the table of the "GP-10B-2 PR 2 development pack 0.3.0" section is
the current list, and the table in the GP-10A section shows the owners as
GP-10A assigned them.

| Subject      | Field                         | GP-10B-1 delivers                                                                                                                                            | Residue                                                                           | Owner    | GP-09 gap code                                                 |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| office role  | `responsibilities`            | nothing                                                                                                                                                      | The whole field.                                                                  | GP-10B-2 | `role_fields_not_expressible`                                  |
| Runtime role | `name`                        | nothing                                                                                                                                                      | The whole field.                                                                  | a45ddb12 | none (missing from GP-09's list)                               |
| Runtime role | `version`                     | nothing                                                                                                                                                      | The whole field.                                                                  | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | capability order              | nothing                                                                                                                                                      | The order of the list.                                                            | a45ddb12 | none                                                           |
| Runtime role | `tools`                       | nothing                                                                                                                                                      | The whole field.                                                                  | GP-10C   | `runtime_role_fields_not_expressible`                          |
| Runtime role | `modelPolicy`                 | nothing                                                                                                                                                      | The whole field.                                                                  | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | `limits`                      | nothing                                                                                                                                                      | The whole field.                                                                  | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | `guidance`                    | nothing                                                                                                                                                      | The whole field.                                                                  | GP-10B-2 | `runtime_role_fields_not_expressible`                          |
| agent        | `enabled`                     | nothing                                                                                                                                                      | The whole field.                                                                  | a45ddb12 | none                                                           |
| task kind    | `pipelineId`                  | The routes feature -> delivery, bugfix -> bugfix, research -> discovery and release -> release, each as the taskType of the workflow of that ID.             | The route maintenance -> delivery.                                                | GP-10B-2 | none                                                           |
| pipeline     | `defaultFor`                  | One task kind per pipeline, as the taskType of its workflow: the routes feature -> delivery, bugfix -> bugfix, research -> discovery and release -> release. | The second task kind of the delivery pipeline: the route maintenance -> delivery. | GP-10B-2 | `pipeline_routes_several_task_kinds`                           |
| pipeline     | `enforcement`                 | nothing                                                                                                                                                      | The whole field.                                                                  | GP-25    | `pipeline_fields_not_expressible`                              |
| stage        | `name`                        | nothing                                                                                                                                                      | The whole field.                                                                  | GP-10B-2 | `stage_fields_not_expressible`                                 |
| stage        | `objective`                   | nothing                                                                                                                                                      | The whole field.                                                                  | GP-10B-2 | `stage_fields_not_expressible`                                 |
| stage        | `checks`                      | nothing                                                                                                                                                      | The whole field.                                                                  | GP-10B-2 | `stage_fields_not_expressible`                                 |
| stage        | `requiresApproval`            | nothing                                                                                                                                                      | The whole field.                                                                  | GP-25    | `stage_fields_not_expressible`                                 |
| stage        | `capabilities`                | nothing                                                                                                                                                      | The whole field.                                                                  | GP-25    | `stage_fields_not_expressible`                                 |
| stage        | `requiresIndependentApproval` | nothing                                                                                                                                                      | The whole field.                                                                  | GP-25    | `stage_fields_not_expressible` if used; unused by the defaults |
| stage        | `requiresDifferentAgentFrom`  | nothing                                                                                                                                                      | The whole field.                                                                  | GP-25    | `stage_fields_not_expressible` if used; unused by the defaults |

GP-10B-1 delivers a part of two entries, the four expressed routes, and
nothing of the other ten that GP-10B owned. Of those twelve, the five
governance entries now belong to GP-25 and the other seven to GP-10B-2. The
seven entries that GP-10B never owned keep their owner.

A pipeline's `id`, `name` and `description` and a stage's `id` and `roleId`
are expressible and are now in the pack, so they are not in the list.

### Acceptance

1. `packages/domain-pack-development/manifest.json` is
   `org.ai-office.development@0.2.0`, passes `verifyDomainPackManifest`
   against core contract 1, and its manifest and file digests are pinned.
2. It declares exactly the workflows `delivery`, `bugfix`, `discovery` and
   `release`. Each has `title`, `description`, one `taskType` and ordered
   `{id, role}` stages. Roles, agents, task types and capabilities are
   unchanged from `0.1.0`.
3. `prompts`, `knowledge`, `policies`, `artifactTypes`, `evidenceTypes` and
   `validators` stay empty, and no agent has `prompts` or `knowledge`.
4. Parity is semantic and limited to the expressible subset; it is not
   equality of the whole legacy object. For a project holding the default
   legacy state and bound through a test-supplied catalog, the resolved
   workflows equal the GP-09 profile pipelines on exactly: pipeline `id`,
   `name` (as `title`), `description`, and the ordered stage sequence of `id`
   and `roleId` (as `role`); plus the expressed routes of criterion 5. Every
   other legacy pipeline or stage field is outside the comparison and is
   covered by criteria 7 and 8. This runs on the GP-09 fixture and on the
   shipped defaults.
5. Every pack route (task type to workflow) is a legacy route. The only
   legacy route missing is `maintenance -> delivery`, pinned as a literal.
6. Changing a pipeline name, description, stage order, stage ID, stage role
   or an expressed route in a copy fails parity, on both the pack and the
   legacy side.
7. Changing any legacy attribute that schema 1 cannot represent leaves parity
   equal, and each such attribute is in the residue list. These are: the
   stage attributes other than `id` and `role` (`name`, `objective`,
   `checks`, `requiresApproval`, `capabilities`,
   `requiresIndependentApproval`, `requiresDifferentAgentFrom`), pipeline
   `enforcement`, the `maintenance` route, and an office role
   responsibility. Stage `id` and `role` are expressible and are covered by
   criterion 6, not by this one.
8. `outside-pack-vocabulary.json` still contains the 12 entries originally
   owned by GP-10B, none removed or merged. Each entry states separately what
   GP-10B-1 delivers (nothing, or the delivered part) and what remains as
   residue, with the residue owner updated to GP-10B-2 or GP-25. The
   task-kind `pipelineId` and pipeline `defaultFor` entries record the four
   expressed routes as delivered and `maintenance -> delivery` as residue.
   The table above equals the list entry for entry, and the
   completeness-by-mutation test passes.
9. Binding the pack leaves the GP-09 profile digest at its pinned vector, and
   every GP-09 fixture file is byte-identical.
10. An unbound project resolves to the empty configuration at the pinned
    empty digest, and the production catalog contains no pack.
11. The architecture tests still pass unmodified: no core, storage or app
    file imports the pack or contains its ID.
12. The diff does not change `packages/domain-pack-contracts/**`,
    `packages/application/**`, `packages/runtime-host/**`, the storage
    packages, `apps/**`, `migrations/**`, `supabase/**`, an archive format,
    an audit event type, a CLI command, `agents/**`, the default office
    manifest, `officeTaskKinds`, `build-project-instructions.ts`,
    `requirement.ts`, the agent definition loader or the agent sync.
13. No pipeline, run, pin, approval or guard is created from a pack workflow,
    and nothing is scheduled from one.
14. The documentation names the claim expressible-subset parity for
    workflows, repeats the anti-goal verbatim, states that nothing was
    removed and that prompts were not delivered, and links the execution
    parity task `a45ddb12-3159-4b60-9b8b-c26516720834` by its ID.

### Non-goals

- No contract or schema extension and no archive format (GP-10B-2).
- No prompt, role guidance, instruction-contract text or
  requirement-assessment prompt (GP-10B-2), and no knowledge entry (GP-15).
- No policy, enforcement, approval, separation or stage capability
  semantics (GP-25).
- No registration, install or adoption of the pack (GP-10C).
- No Runtime pipeline, run, pin, approval or guard from a pack workflow, and
  no scheduling from one.
- No removal or modification of any legacy default.
- No change to the frozen GP-09 profile or its gap codes.

### Implementation record

- Manifest. `packages/domain-pack-development/manifest.json` is
  `org.ai-office.development@0.2.0`, schema 1, `coreContract` `[1, 2)`, no
  dependency. The four workflows are in the default office manifest's
  pipeline order, which is not compared. The package still holds the same
  four files and no source file.
- Pinned. `manifestDigest` is
  `sha256:6321bb076a19765ce50f3127914c95487658c44e4cf480c3471337d2983f227e`,
  and a test pins the digest of the file's exact bytes. A second pin is a
  digest over the roles, agents, task types and capabilities, computed from
  the committed `0.1.0` manifest: it shows that those four are unchanged.
- Comparison shape. `tests/helpers/development-pack-parity.ts` is still test
  code and the only place the two sides meet. Its shape gains `workflows`
  and `routes`. On the legacy side a workflow is a profile pipeline; on the
  pack side it is an enabled workflow of the resolved configuration, by
  local ID, whatever its origin. The end-to-end GP-10A case over the Unix
  socket uses the same projection, so it compares the workflows too.
- Routing is read twice on the legacy side, because the legacy state holds
  it twice: as `defaultFor` of a pipeline, compared with the workflow's one
  task type, and as the pipeline of a task kind, compared with the routes.
  Both leave out the task kind `maintenance`, whatever it routes to. This is
  a rule by task kind, not by position in `defaultFor`: decision 3 names the
  kind. A separate test pins, on the unedited state, that every pack route
  is a legacy route and that the one legacy route missing is exactly
  `maintenance -> delivery`.
- Legacy-side changes go through the real derivation. A test edits a copy of
  the office manifest and derives the GP-09 profile again, so the profile
  digest changes with each edit. A change to an expressible part must break
  parity. A change to an attribute outside the subset must change the digest
  and leave parity equal, and its field must be in the list. On the shipped
  defaults the edited manifest also passes the real office manifest parser
  and `ApplyOfficeManifest`.
- Completeness by mutation now covers pipelines and stages. Three profile
  fields are skipped as not being legacy fields of their own: the two
  containers `runtime` and `stages`, and `eligibleAgents`, which GP-09
  derives from the agents. A field with a delivered part must be read by the
  projection; a field with none must not be. The pipeline of a task kind and
  `defaultFor` are read for every kind but `maintenance`, so both are
  projected and both carry a delivered part and a residue.
- List. `outside-pack-vocabulary.json` has `schemaVersion` 2, because every
  entry gained two required keys: `delivered`, a statement or null, and
  `residue`. `owner` is the task that owns the residue. The entries, their
  order, their GP-09 codes and `inDefaultState` are those of GP-10A. For an
  entry with nothing delivered the residue is the whole field.
- Owners. Decision 7 names the five entries of GP-25. The other seven
  former GP-10B entries went to GP-10B-2: responsibilities, guidance, stage
  `name`, `objective` and `checks`, and the two routing entries, whose
  residue needs a workflow that names more than one task type.
- GP-10A section. Its table of fields is kept as GP-10A wrote it, with one
  added sentence that points here. The test that compared that table with
  the list entry for entry now compares the table above; the GP-10A table is
  still checked for the same 19 fields in the same order, for the owners
  GP-10A assigned as literals, and for its gap codes against the list.
- GP-10A tests changed where the pack changed: the pinned version and
  digests, the count of workflows, the owners, the classification list, and
  the task type renamed in a copy of the pack, which is now `maintenance`
  because every other task type is named by a workflow.
- Nothing is created from a workflow. On the GP-09 fixture, which has
  pipeline runs, stage runs and approvals, binding the pack and resolving
  the four workflows leaves every table but the binding tables and the audit
  log identical, and the one audit event is the selection. On a project
  built from the shipped defaults the run, approval and job tables stay
  empty.
- Unchanged. The GP-09 profile digest of the fixture project is the pinned
  vector before and after the binding, the checksum of each GP-09 fixture
  file is pinned, an unbound project resolves to the empty configuration at
  its pinned digest, and the Runtime's own catalog holds no pack. The
  architecture tests were not edited.
- Criterion 12 is a property of this change set. It was checked on the diff
  against the base commit: the diff touches the plan, the roadmap, the
  architecture overview, the README, the pack package and tests. No test
  keeps it true afterwards.
- PostgreSQL. Nothing here reaches storage code, so no PostgreSQL-gated
  suite covers it and none was added.
- Evidence limits. Parity is shown for the default legacy state only. The
  pack is resolved through a catalog a test supplies; no production path
  installs or selects it. Whether a Runtime that executed these workflows
  would behave like the legacy pipelines is not shown and is the subject of
  task `a45ddb12-3159-4b60-9b8b-c26516720834`.

## GP-10B-2 descriptive workflow and prompt vocabulary

Status: the contract (PR 1) is implemented; development pack `0.3.0` (PR 2) is
specified in the next section. The owner approved the scope on 2026-10-06
as two pull requests: the contract below, and then development pack `0.3.0`
with the data and its parity tests (PR 2), which is a separate, later change.
"Implementation record" at the end of this section records what was built
where the contract left a choice, and where the evidence stops.

Formal scope of PR 1:

> Extend manifest schema 1 additively with the descriptive vocabulary the
> GP-10B-1 residue needs: workflow stage `title`, `objective` and `checks`,
> role `responsibilities`, prompt `text` and workflow `additionalTaskTypes`.
> Carry the same fields in project-owned and `replace` payloads, the resolved
> view, upgrade reconciliation and portable archive format 10. No pack data,
> no migration, no CLI command, no Runtime consumption.

Anti-goal:

> the pack must not become authoritative for Runtime execution without a
> separately approved task

Every field is declarative text or a declarative reference. Nothing here
reaches the Runtime: no role, agent, pipeline, run, run pin, approval or
guard is created, read or written, the OfficeManifest is not touched, no
instruction file is generated from a pack, no prompt is sent to a provider
from a pack and nothing is scheduled from a resolved workflow. The legacy
path stays the only source the Runtime reads. The development pack manifest
is unchanged by PR 1 and stays at `0.2.0`.

### Decisions

The owner approved these on 2026-10-06, each at the default of the scope
proposal.

1. Two pull requests: this contract, then pack `0.3.0`. The contract is not
   split further, because an archive format identifies exactly one schema and
   only format 10 was approved (GP-10B-1 decision 6).
2. Routing is expressed by `additionalTaskTypes` beside the required
   `taskType`. `taskType` keeps its type and meaning.
3. The manifest gets no rule that a task type is named by at most one
   workflow. Schema 1 has none today, adding one to `taskType` would not be
   additive, and "default workflow for a task type" is a scheduling concept
   that belongs to the Runtime execution parity task
   `a45ddb12-3159-4b60-9b8b-c26516720834`.
4. Project text keeps its single rule: at most 16,000 UTF-16 code units, no
   U+0000 and no lone surrogate. There is no dedicated bound for prompt
   `text`. See "Limitations".
5. A mutation larger than the 16 KiB argument limit cannot be sent, and no
   `--mutation-file` option is added. See "Limitations".
6. `extend` cannot set any new field. It still fills only an absent `title`
   or `description` of the contribution.
7. `checks` and `responsibilities` are ordered lists of 1 to 64 non-empty
   entries. Duplicates are allowed. An empty array is rejected; "none" is the
   absent field.
8. A `replace` is the complete envelope: an existing or new replacement that
   omits a new field hides the pack's value for it.
9. Role guidance attaches through the existing agent `prompts` reference
   (GP-12). A role gets no guidance field.
10. The per-pipeline line of the generated instruction contract is derived,
    mixes stage titles with `enforcement` (GP-25) and is not a prompt.
11. Parity of the requirement-assessment prompt (PR 2) is shown by capturing
    the provider request of `requirement:validate` with a deterministic
    provider; `requirement.ts` is not edited.
12. The residue list (PR 2) moves to `schemaVersion` 3 with a nullable
    `residue` and keeps all 19 entries.
13. A prompt `text` in a manifest, and each `checks` and `responsibilities`
    entry, must be non-empty. These are deliberate exceptions to the one rule
    for manifest text.

### Manifest fields

All six fields are optional members of manifest schema 1. The manifest stays
schema 1 and the core contract version stays 1.

| Kind           | Field                 | Type       | Rules                                                                                                                                                          |
| -------------- | --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow stage | `title`               | string     | The manifest text rule. Maps the legacy stage `name`, as GP-10B-1 decision 4 mapped the pipeline `name`.                                                       |
| workflow stage | `objective`           | string     | The manifest text rule.                                                                                                                                        |
| workflow stage | `checks`              | string[]   | Ordered. 1 to 64 entries, each a non-empty string under the manifest text rule. Duplicates allowed. An empty array is rejected.                                |
| role           | `responsibilities`    | string[]   | The rules of `checks`.                                                                                                                                         |
| prompt         | `text`                | string     | Non-empty; otherwise the manifest text rule: no length bound, not normalized, U+0000 allowed when JSON-escaped (GP-23).                                        |
| workflow       | `additionalTaskTypes` | local ID[] | A set of 1 to 1,000 unique local IDs (`maximumContributionReferences`). Each names a task type the same manifest declares. It must not contain the `taskType`. |

- **Strictness.** Each field exists only where the table puts it. On any
  other kind or level it is an unknown field. A reader built before this
  extension rejects a manifest that uses a field; no reader ignores one.
- **Errors.** Every violation is a `DomainPackManifestError` with code
  `invalid_contribution` and the member's path: a non-array, empty or
  over-bound list; a non-string, empty or lone-surrogate entry; an empty
  `text`; a malformed, duplicate or undeclared `additionalTaskTypes` entry or
  one equal to `taskType`; and any of the fields on another kind or level.
- **Order.** `checks` and `responsibilities` keep the order written, and that
  order is digest material (ADR-0026, canonicalization step 2).
  `additionalTaskTypes` is a set like the GP-11 and GP-12 reference lists:
  the validated manifest holds it in ascending code-unit order, so the
  written order does not change `manifestDigest`.
- **Digest.** A field is part of the canonical form only when present. A
  manifest that omits all six has the canonical form and `manifestDigest` it
  had before. The four golden fixtures and development pack `0.2.0` keep
  their digests.
- **List bound.** `maximumDescriptiveListEntries` (64) is one constant of the
  contracts package, used by the manifest reader, the project mutation
  contract and the portable archive, as GP-12 did for reference lists. A
  list a pack may declare is therefore always storable and exportable.
- **Routes.** A workflow's routes are its `taskType` and its
  `additionalTaskTypes`. Two workflows may name the same task type, as they
  could before (decision 3).

### Project payloads

| Payload                                              | New keys                                                    | Notes                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Project-owned role; `replace` on a pack role         | `responsibilities`                                          | A `replace` stays the complete descriptive envelope. The capability set stays the pack's (GP-11); `capabilities` is rejected. |
| Project-owned prompt; `replace` on a pack prompt     | `text`                                                      | The same complete-envelope rule.                                                                                              |
| Project-owned workflow; `replace` on a pack workflow | stage `title`, `objective`, `checks`; `additionalTaskTypes` | Stage order is kept as given. `additionalTaskTypes` resolves in the workflow's own namespace, like `taskType`.                |
| `extend`, every kind                                 | none                                                        | Unchanged: it fills an absent `title` or `description` only.                                                                  |
| `disable`                                            | none                                                        | Unchanged: no payload.                                                                                                        |

- **Text rule.** Every new text value and every list entry is project
  definition text (`isDefinitionText`: at most 16,000 UTF-16 code units, no
  U+0000, no lone surrogate) and additionally non-empty.
- **Lists.** `checks` and `responsibilities` hold 1 to 64 entries in the
  order given; they are stored, exported, restored and resolved in that
  order. `additionalTaskTypes` holds 1 to 1,000 unique local IDs and is
  stored in ascending code-unit order, whatever order the mutation gave.
- **Errors.** No error code is added.

  | Finding                                                                                                                                                                                                                | Code                             |
  | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
  | Text that is not a string, is empty, exceeds the bound, or holds U+0000 or a lone surrogate; a list that is not an array, is empty or is over its bound; a malformed `additionalTaskTypes` entry; an unknown stage key | `malformed_origin_reference`     |
  | A duplicate in `additionalTaskTypes`, or an entry equal to `taskType`                                                                                                                                                  | `conflicting_ownership_metadata` |
  | A new key on a kind that does not have it, in an `extend`, or `capabilities` in a role payload                                                                                                                         | `protected_security_invariant`   |
  | An `additionalTaskTypes` entry of a `replace` that the exact source manifest does not declare (preview and apply)                                                                                                      | `source_definition_missing`      |

  A rejected mutation writes nothing. An error message names the field and
  never quotes a value.

- **Audit.** `project.definition_changed` and `project.pack_upgrade_applied`
  carry identities and revisions only, as before. No prompt text and no other
  definition body enters the audit log, the upgrade plan or an error message.

### Resolution

The resolver passes a pack contribution whole into `effectiveDefinitions`, so
every new field of a pack is digest material without a format change.
`configurationDigest` stays format 1 and the empty-input vector is unchanged.

`project:configuration:show` gains these derived fields, each present only
when the effective definition has the field:

- `roles[].responsibilities`, in the effective order;
- `workflows[].stages[]`: `title`, `objective` and `checks`;
- `workflows[].additionalTaskTypeIds`: stable task type IDs
  (`pack:<packId>/taskTypes/<localId>` or `project:taskTypes/<localId>`), in
  ascending order of the local ID.

A prompt's `text` is reported in `effectiveDefinitions.prompts[].payload`;
there is no derived prompt view.

`resolvedWorkflowReferences[]`, which is digest material, gains
`additionalTaskTypeIds` (effective IDs) only when the workflow has at least
one. A configuration that uses none of the new fields therefore keeps its
digest.

Every additional task type of an enabled workflow resolves inside the
workflow's own namespace, with the GP-06 codes and no new one:
`missing_workflow_reference`, `ambiguous_reference` and
`disabled_required_definition`, exactly as for `taskType` (GP-13). A disabled
workflow is not resolved, so its routes cannot fail. A stored payload that
violates the mutation contract fails as `unresolved_override` (an override)
or `configuration_invariant` (a project-owned definition).

An override applies as before. A `replace` substitutes the whole envelope, so
a field it omits is absent, except a role's capability set, which stays the
pack's. An `extend` keeps every new field of the pack.

### Upgrade and merge semantics

`project:pack:upgrade` (GP-08) needs one change, in `convert_to_replace`. All
other rows follow from existing rules.

| Case                                                              | Outcome                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not customized, a new field added, changed or removed upstream    | The new template applies. Reported as a template change (`changed`): the comparison covers the whole contribution.                                                     |
| `replace`, upstream gains or changes a new field                  | `retargeted`, `upstream: changed`. The project's envelope wins whole; a replacement without the field stays without it (decision 8, as GP-12).                         |
| `extend`, upstream gains or changes a new field                   | `retargeted`. The field is the new version's. It is never an `extend_conflict`, because an `extend` cannot set it.                                                     |
| `convert_to_replace` of an `extend_conflict`                      | The replacement takes `responsibilities` (role), `text` (prompt), stage `title`, `objective` and `checks`, and `additionalTaskTypes` (workflow) from the new template. |
| `convert_to_replace`, template text does not fit the project rule | Blocks as `prospective_configuration_invalid` (`unresolved_override`), the existing path of GP-23. Nothing is written.                                                 |
| `retain_as_project_owned`, role or prompt `replace`               | The retained definition keeps `responsibilities` or `text`.                                                                                                            |
| `retain_as_project_owned`, workflow                               | Still refused (`invalid_resolution`), as in GP-13.                                                                                                                     |
| `replace` whose `additionalTaskTypes` entry is gone upstream      | Blocks as `prospective_configuration_invalid` (`missing_workflow_reference`).                                                                                          |

Template text "does not fit" when it is longer than 16,000 code units, holds
U+0000, or is an empty stage `title` or `objective`, which a manifest may
declare and a project payload may not.

No upgrade drops or rewrites a project value. `planDigest` carries identities
only; definition bodies are bound through `prospectiveConfigurationDigest`.

### Persistence

No migration is added. Both backends store a definition payload as JSON with
no key constraint: SQLite as `TEXT` guarded by `json_valid` (`0042`, `0046`),
PostgreSQL as `jsonb` with an object-shape check (`20261006000300`). A JSON
array keeps its order on both, so `checks` and `responsibilities` come back
in the order stored. The kind and operation constraints already admit
`roles`, `prompts` and `workflows` with `replace`.

Portable archive format 10 has the format-9 contents and additionally accepts
the new keys in project-owned payloads and in `replace` payloads:
`responsibilities` on a role, `text` on a prompt, and on a workflow the stage
fields and `additionalTaskTypes`. In a format-10 payload every new text is
non-empty project definition text, a list has 1 to 64 entries, and
`additionalTaskTypes` is in the order the mutation contract stores: 1 to
1,000 local IDs, strictly ascending, without the `taskType`. A key on another
kind, in an `extend` or on a `disable` is rejected.

Formats 1–9 keep their readers and meanings, and format 9 rejects every new
key. A backup is written as format 10 only when the project state contains at
least one new key; every other state is written as before, byte for byte.

### Limitations and non-goals

- No Runtime consumption. See the anti-goal above.
- **Project text bound (decision 4).** A project-owned or replacing prompt
  `text`, stage `objective` or list entry is at most 16,000 UTF-16 code
  units. Legacy role guidance may be up to 65,536 UTF-8 bytes. Guidance
  between the two bounds can be pack text but cannot be a project override or
  a project-owned prompt. This matters for adoption (GP-10C).
- **Argument limit (decision 5).** `project:definition:apply` takes the
  mutation as one inline `--mutation` argument, and one argument is at most
  16 KiB inside a 64 KiB request. A prompt replacement near the 16,000-unit
  bound, with JSON-escaped newlines, cannot be sent. There is no
  `--mutation-file`.
- Manifest text is unbounded, so a pack may carry text that cannot be copied
  into a project override; `convert_to_replace` then blocks.
- No route uniqueness (decision 3), no default workflow and no scheduling.
- `extend` cannot set a new field, there is no per-stage edit, and a
  replacement does not follow later upstream changes to a new field; they
  are reported as `upstream: changed`.
- No derived prompt view and no prompt `purpose` discriminator.
- `additionalTaskTypes` follows the namespace rule of GP-13: a pack workflow,
  customized or not, names task types of its own pack only, and a
  project-owned workflow names project-owned task types only.
- Governance semantics are GP-25, `knowledge` is GP-15, registration and
  adoption are GP-10C. The frozen GP-09 profile and its gap codes stay
  untouched.

### Acceptance

PR 1, the contract:

1. The manifest parser accepts the six fields with the rules above. A
   manifest without them has an unchanged canonical form and digest; the four
   golden fixture digests and the `0.2.0` digest are pinned unchanged.
2. Each of these fails with `DomainPackManifestError` `invalid_contribution`
   and the member path: a non-array, empty or over-bound list; an empty or
   lone-surrogate entry; an empty `text`; a malformed, duplicate or
   undeclared `additionalTaskTypes` entry, or one equal to `taskType`; any
   new field on another kind or level.
3. The written order of `additionalTaskTypes` does not change
   `manifestDigest`; the written order of `checks` and `responsibilities`
   does.
4. `put_owned` and `replace` accept the new keys per the payload table and
   store `additionalTaskTypes` ascending.
5. Rejections carry the codes listed above and write nothing: a new key on
   the wrong kind or in an `extend`; text over 16,000 units, with U+0000 or a
   lone surrogate; an over-bound list.
6. A role `replace` never changes the pack capability set, and a payload
   with `capabilities` is still rejected.
7. `project:configuration:show` reports the new view fields. The empty-input
   `configurationDigest` vector is unchanged, and a configuration using none
   of the fields keeps its digest, pinned on an existing fixture.
8. A missing, ambiguous or disabled additional task type fails resolution
   with the GP-06 code. A disabled workflow's routes are not resolved.
9. Upgrade: every row of the reconciliation table has a test, including the
   negative cases: `convert_to_replace` with oversize template text blocks;
   `retain_as_project_owned` on a workflow is still `invalid_resolution`; no
   upgrade drops or rewrites a project value.
10. Archive format 10 round-trips a state with every new key. Formats 1–9
    restore with their frozen meaning. A format-9 archive carrying any new
    key is rejected. A state without new keys is written byte-identically to
    before. A format-10 archive with unsorted `additionalTaskTypes`, an empty
    list or a wrong-kind key is rejected.
11. No migration is added. A test asserts that the SQLite and PostgreSQL
    definition repositories round-trip a payload with every new key, with
    list order preserved.
12. PostgreSQL-gated coverage: the storage contract suite
    (`tests/integration/storage-contracts-postgres.test.ts`) stores, reads
    and exports the new payloads, and
    `tests/integration/migration-upgrades.test.ts` still passes with no new
    migration.
13. End-to-end over the Unix socket covers `project:definition:preview` and
    `apply` with new keys, `project:configuration:show`,
    `project:pack:upgrade` with a `convert_to_replace`, backup and restore at
    format 10, and one rejected mutation that exits 1 with a typed message
    and no payload text in stderr.
14. `project.definition_changed` and `project.pack_upgrade_applied` events
    contain no prompt text or other definition body.
15. No Runtime role, agent, pipeline, run, pin, approval or guard is created
    or read; OfficeManifest rows are byte-identical before and after. The
    anti-goal is repeated verbatim in this section.
16. The diff does not touch `agents/**`, the default office manifest,
    `build-project-instructions.ts`, `requirement.ts`,
    `legacy-development-profile.ts`, the GP-09 fixtures, the pack manifest,
    `migrations/**` or `supabase/**`.

PR 2, development pack `0.3.0`, is not part of this change; see the section
"GP-10B-2 PR 2 development pack 0.3.0". Its criteria
(17 to 25 of the approved proposal) cover the pack data, expressible-subset
parity for the new fields on the GP-09 fixture and the shipped defaults, the
role guidance and reference prompts, and the residue list.

### Implementation record

- Manifest. `packages/domain-pack-contracts/src/manifest.ts` reads the six
  fields. `maximumDescriptiveListEntries` (64) is exported from the contracts
  package. The declared-task-type check of `additionalTaskTypes` runs in the
  cross-reference pass, after every section is read, like the GP-11 and GP-12
  checks. `taskType` itself is still not checked against the manifest's task
  types, as before; GP-06 resolution does that.
- Lone surrogates. A lone surrogate in an entry or a text is
  `invalid_contribution` with the member path when a manifest value is
  validated (`validateDomainPackManifest`). The byte reader
  (`parseDomainPackManifest`, `verifyDomainPackManifest`) refuses a lone
  surrogate earlier, as `malformed_input` at `$`, because it is not
  well-formed JSON text. That is the existing behaviour for every manifest
  string and is unchanged; the tests pin both layers.
- Empty text. A stage `title` or `objective` may be the empty string in a
  manifest, like a contribution `title`. Only a prompt `text` and a list entry
  must be non-empty there. In a project payload every new text is non-empty.
  A `convert_to_replace` of such a template therefore blocks as
  `prospective_configuration_invalid` (`unresolved_override`); the message
  names the offending field, for example `Workflow stage title must be
  non-empty bounded text`, and never quotes a value.
- Unknown keys. An unknown key of a stage keeps `malformed_origin_reference`
  and the message lists the allowed stage keys; a key of the wrong kind of
  envelope (such as `text` on a role) is `protected_security_invariant`.
- Mutation contract. `project-definition.ts` admits `responsibilities` for a
  role and `text` for a prompt through one table, `descriptiveFieldOfKind`,
  used for a project-owned definition and for a `replace`; an `extend` and
  every other kind keep the two-field envelope. The messages are fixed
  strings that name a field: for example
  `text must be non-empty bounded text` and
  `additionalTaskTypes must not contain the workflow's taskType`.
- Pre-store check. `manage-project-definitions.ts` reports an additional task
  type the exact source manifest does not declare as
  `source_definition_missing`, in the list's stored order, before anything is
  written, and `project:definition:show` reports the same for stored state.
  A route missing more than once is reported once per missing task type, as
  in GP-13.
- View. The derived fields are optional and present only when set, so every
  existing view of a configuration without them is unchanged, not only its
  digest. `ResolvedRole.responsibilities`, the stage fields and
  `additionalTaskTypeIds` are the names.
- Upgrade. The only code change is in `convert_to_replace`. The other rows of
  the table are existing behaviour and are covered by tests only.
- Archive. `portableProjectDescriptiveVocabularyFormatVersion` is 10. The
  base definition schema gained a role payload, a prompt payload, the stage
  fields and `additionalTaskTypes`, with kind-specific refinements; format 9
  became a refinement that rejects every new key, and formats 6 to 8 refine
  format 9 as before. `hasDescriptiveVocabulary` decides both the format a
  state is written at and what format 9 rejects.
- Byte identity. A test pins the SHA-256 of serialized archives of four
  states without the new keys, at formats 6, 7, 8 and 9. The digests were
  computed on the base commit, before format 10 existed.
- Pinned digests. The four golden fixture digests, the `0.2.0` manifest
  digest, the empty-input `configurationDigest` vector and the digest of one
  configuration on the legal fixture and pack `0.2.0` with project-owned
  definitions and two replacements, computed on the base commit, are
  unchanged.
- Storage. No migration. `tests/contracts/project-storage.contract.ts` gained
  one case that both backends run: it stores a state with every new key,
  reads it back equal with list order kept, and checks that the state read
  back is a valid format-10 definition section that format 9 rejects. No
  PostgreSQL portable export path exists in the repository, so "exports" in
  criterion 12 is shown as that schema check on the state read from
  PostgreSQL, not as a backup written by a PostgreSQL-backed Runtime.
- PostgreSQL. The gated suites were run against a throwaway `postgres:17`
  container, the image CI uses:
  `storage-contracts-postgres`, `storage-bootstrap-postgres`,
  `pack-manifest-nul-policy`, `legacy-development-profile-postgres` and
  `migration-upgrades` passed, 93 tests in 5 files.
- Earlier tests. One GP-13 unit case asserted that a stage `title` is an
  unknown stage key; it now uses `name`, which is still unknown. One
  snapshot unit case used format version 10 as its unsupported version; it
  now uses 11.
- Preservation. On a project with a real OfficeManifest, Runtime roles and
  agents and a started pipeline run, definitions with the new keys and an
  upgrade that converts one leave every table but the definition, binding
  and audit tables identical, the OfficeManifest rows included.
- Criterion 16 is a property of this change set, checked on the diff against
  the base commit. No test keeps it true afterwards.
- Delivery table. The GP-10B-2 row is longer than its column and the table
  was not re-padded, so that the rows of tasks developed in parallel merge
  without a conflict. Prettier reports the file; re-padding is left to the
  last of those merges.
- Evidence limits. Nothing shows how a Runtime would use these fields,
  because none does. Parity of the development defaults with these fields is
  PR 2. The 16 KiB argument limit is recorded, not tested.

## GP-10B-2 PR 2 development pack 0.3.0

Status: implemented. The owner approved the contract below on 2026-10-06,
every decision at its proposed default.
"Implementation record" at the end of this section records what was built
where the contract left a choice, and where the evidence stops.

Formal scope:

> Extend the development reference pack `org.ai-office.development` from
> `0.2.0` to `0.3.0` with the descriptive vocabulary that the merged GP-10B-2
> contract (PR 1, #118) added to manifest schema 1: role `responsibilities`,
> workflow stage `title`, `objective` and `checks`, workflow
> `additionalTaskTypes`, and prompts with `text`. Prove expressible-subset
> parity over the new fields. No contract change, Runtime consumption,
> catalog registration, adoption or legacy-path removal occurs in this pull
> request.

Anti-goal:

> the pack must not become authoritative for Runtime execution without a
> separately approved task

The property this pull request proves is **expressible-subset parity**: the
resolved configuration of a project bound to the pack and the GP-09 legacy
development state are equal over the subset that schema 1 can now represent.
That subset is the GP-10A and GP-10B-1 subset plus stage title, objective and
checks, role responsibilities and the full route set, and, for role guidance
and the reference prompts, text equality with the legacy sources. It is not
execution parity. A project bound to the pack still runs on the pipelines of
its OfficeManifest, exactly as before; comparing execution from a resolved
configuration with legacy execution stays with the Runtime task "Runtime
resolved-configuration execution parity"
(`a45ddb12-3159-4b60-9b8b-c26516720834`).

Nothing was removed from the legacy path. The default office manifest, its
four pipelines, `officeTaskKinds`, `agents/**`, the instruction builder, the
requirement assessment, the agent definition loader and the agent sync are
unchanged and remain the only sources the Runtime reads. No Runtime role,
agent, pipeline, run, pin, approval or guard is created from the pack, no
instruction file is generated from a prompt of the pack and no prompt of the
pack is sent to a provider. Pack text is a reference copy; where it and the
legacy source disagree, the legacy source is what runs, and a test fails.

### Decisions

The owner approved these on 2026-10-06, each at the default of the scope
proposal. They are the decisions of GP-10B-2 that concern the data.

1. Role guidance attaches through the existing agent `prompts` reference
   (GP-12). A role gets no guidance field, and an agent of the pack names the
   guidance prompt of its role.
2. The per-pipeline line of the generated instruction contract is derived
   from the pipelines and mixes stage titles with `enforcement` (GP-25). It
   is recorded as derived and is not a prompt.
3. `knowledge` (GP-15) and `policies` (GP-25) stay empty, as do
   `artifactTypes`, `evidenceTypes` and `validators`. No agent names
   knowledge.
4. Parity of the requirement-assessment prompt is shown by capturing the
   provider request of `requirement:validate` with a deterministic provider.
   `requirement.ts` is not edited and exports nothing new.
5. The residue list becomes `schemaVersion` 3 with a nullable `residue` and
   keeps all 19 entries. An entry whose field the pack now delivers in full
   has `residue: null`; it is not removed.
6. The route `maintenance -> delivery` is expressed by
   `additionalTaskTypes: ["maintenance"]` on the `delivery` workflow, beside
   `taskType: feature`. The pinned literal difference of GP-10B-1 is removed.
7. Pack text is not trimmed or normalized. A prompt `text` is the exact bytes
   of its legacy source, including a trailing newline.

### Reference pack

`org.ai-office.development@0.3.0`, schema 1, core contract `[1, 2)`, still
data only and unregistered. It declares the roles, agents, task types,
capabilities and workflows of `0.2.0`, with these additions and no other:

| Where                             | Addition                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each role                         | `responsibilities`: the responsibilities of the office role of the same ID, in the legacy order                                                                      |
| Each workflow stage               | `title` (the legacy stage `name`), `objective` and `checks` (in the legacy order)                                                                                    |
| Workflow `delivery`               | `additionalTaskTypes: ["maintenance"]`                                                                                                                               |
| Each agent                        | `prompts: ["<id>-guidance"]`                                                                                                                                         |
| Four guidance prompts             | `architect-guidance`, `developer-guidance`, `reviewer-guidance`, `qa-guidance`: `text` is the bytes of `agents/<id>/system.md`                                       |
| Six instruction-contract prompts  | `instruction-repository-map`, `instruction-invariants`, `instruction-workflow`, `instruction-testing`, `instruction-documentation`, `instruction-definition-of-done` |
| One requirement-assessment prompt | `requirement-assessment`                                                                                                                                             |

The instruction-contract prompts are the static text of
`buildProjectInstructionContract`, one prompt per contract field that has
static text, its entries joined by `\n`: the repository map, the default
invariants (the text used when the manifest has no constraints), the static
entries of the workflow, testing, documentation and definition of done. Three
parts of the contract are not prompts. `policy` is a set of enumerations and
booleans, `project.name` and `project.mission` come from the project, and the
per-pipeline entries of the workflow are derived (decision 2). The
requirement-assessment prompt is the system message that `requirement:validate`
sends. Agents name only their guidance prompt; the seven reference prompts are
referenced by no agent.

### Expressible-subset parity

The comparison shape of GP-10A and GP-10B-1 gains these parts, and both sides
must be equal on them:

- a role: `responsibilities`, in order;
- a workflow stage: `title` (the legacy `name`), `objective` and `checks`, in
  order;
- a workflow: every task type it routes, its `taskType` and its
  `additionalTaskTypes`, so the routes are the five legacy routes and the
  comparison no longer leaves out a task kind.

Two comparisons are made by text and not by the shared shape:

- **Role guidance.** For each default role,
  `legacyRoleGuidanceDigest(prompt.text)` of the guidance prompt that the
  agent of the role references equals the guidance digest of the legacy
  profile, and the prompt text equals the bytes of `agents/<id>/system.md`.
  This runs on the shipped defaults only. The GP-09 fixture carries synthetic
  one-line guidance, so its digests are not those of the shipped files, and
  the test pins that difference rather than hiding it.
- **Reference prompts.** The instruction-contract prompts equal the output of
  `buildProjectInstructionContract` for a manifest without constraints, with
  the derived per-pipeline entries excluded. The requirement-assessment
  prompt equals the system message that a `requirement:validate` run sends to
  the provider, captured by a deterministic provider.

The parity comparison runs on the GP-09 fixture state and on legacy state
built from the shipped defaults, as before. Changing any newly expressible
legacy field in a copy breaks parity on both the pack side and the legacy
side. Changing a legacy field that stays residue changes the legacy profile and
leaves parity equal, and that field is still in the residue list.

### Residue

`outside-pack-vocabulary.json` has `schemaVersion` 3 and still holds the 19
entries. `residue` is a statement or `null`; `null` means that the pack
carries the whole field. `delivered` and `owner` are as in GP-10B-1. For an
entry with no residue, `owner` names the task that delivered it. This table is
the current list; the tables of the GP-10A and GP-10B-1 sections show the
owners and deliveries as they were then.

| Subject      | Field                         | GP-10B-2 PR 2 delivers                                                                                                                                                                                                 | Residue                | Owner    | GP-09 gap code                                                 |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------- | -------------------------------------------------------------- |
| office role  | `responsibilities`            | The ordered responsibilities of each default role, as the `responsibilities` of the pack role of the same ID.                                                                                                          | none                   | GP-10B-2 | `role_fields_not_expressible`                                  |
| Runtime role | `name`                        | nothing                                                                                                                                                                                                                | The whole field.       | a45ddb12 | none (missing from GP-09's list)                               |
| Runtime role | `version`                     | nothing                                                                                                                                                                                                                | The whole field.       | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | capability order              | nothing                                                                                                                                                                                                                | The order of the list. | a45ddb12 | none                                                           |
| Runtime role | `tools`                       | nothing                                                                                                                                                                                                                | The whole field.       | GP-10C   | `runtime_role_fields_not_expressible`                          |
| Runtime role | `modelPolicy`                 | nothing                                                                                                                                                                                                                | The whole field.       | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | `limits`                      | nothing                                                                                                                                                                                                                | The whole field.       | a45ddb12 | `runtime_role_fields_not_expressible`                          |
| Runtime role | `guidance`                    | The guidance text and its digest: the prompt `<role>-guidance`, referenced by the agent of the role, whose text is the bytes of `agents/<role>/system.md`. The guidance version is covered by the separate Runtime role `version` entry. | none                   | GP-10B-2 | `runtime_role_fields_not_expressible`                          |
| agent        | `enabled`                     | nothing                                                                                                                                                                                                                | The whole field.       | a45ddb12 | none                                                           |
| task kind    | `pipelineId`                  | All five routes, each as a task type of the workflow of that ID: `taskType` for feature, bugfix, research and release, and `additionalTaskTypes` for maintenance -> delivery.                                          | none                   | GP-10B-2 | none                                                           |
| pipeline     | `defaultFor`                  | Every task kind of each pipeline, as the task types of its workflow, including both task kinds of the delivery pipeline.                                                                                               | none                   | GP-10B-2 | `pipeline_routes_several_task_kinds`                           |
| pipeline     | `enforcement`                 | nothing                                                                                                                                                                                                                | The whole field.       | GP-25    | `pipeline_fields_not_expressible`                              |
| stage        | `name`                        | The stage name, as the stage `title`.                                                                                                                                                                                  | none                   | GP-10B-2 | `stage_fields_not_expressible`                                 |
| stage        | `objective`                   | The stage objective, as the stage `objective`.                                                                                                                                                                         | none                   | GP-10B-2 | `stage_fields_not_expressible`                                 |
| stage        | `checks`                      | The ordered checks of the stage, as the stage `checks`.                                                                                                                                                                | none                   | GP-10B-2 | `stage_fields_not_expressible`                                 |
| stage        | `requiresApproval`            | nothing                                                                                                                                                                                                                | The whole field.       | GP-25    | `stage_fields_not_expressible`                                 |
| stage        | `capabilities`                | nothing                                                                                                                                                                                                                | The whole field.       | GP-25    | `stage_fields_not_expressible`                                 |
| stage        | `requiresIndependentApproval` | nothing                                                                                                                                                                                                                | The whole field.       | GP-25    | `stage_fields_not_expressible` if used; unused by the defaults |
| stage        | `requiresDifferentAgentFrom`  | nothing                                                                                                                                                                                                                | The whole field.       | GP-25    | `stage_fields_not_expressible` if used; unused by the defaults |

Seven entries are delivered in full, the seven that GP-10B-2 owned. The five
governance entries stay with GP-25, the `tools` entry with GP-10C and the
other six with the execution parity task `a45ddb12`, each with its residue
unchanged. The per-pipeline instruction entry is derived (decision 2) and is
not a legacy field of the list.

### Acceptance

These continue the numbering of the approved scope proposal, whose criteria 1
to 16 are the contract (PR 1).

17. `packages/domain-pack-development/manifest.json` is
    `org.ai-office.development@0.3.0`, passes `verifyDomainPackManifest`
    against core contract 1, and its manifest and file digests are pinned.
    Roles, agents (apart from `prompts`), task types and capabilities equal
    those of `0.2.0` by a pinned digest over that subset, with the new role
    `responsibilities` and agent `prompts` removed.
18. Parity holds on the GP-09 fixture and on the shipped defaults for stage
    `title`, `objective` and `checks`, role `responsibilities` and the full
    route set, including `maintenance -> delivery`. The pinned literal
    difference of GP-10B-1 is removed.
19. For each default role, `legacyRoleGuidanceDigest(prompt.text)` equals the
    guidance digest of the legacy profile, and the prompt text equals the
    bytes of `agents/<id>/system.md`, on the shipped defaults.
20. The static instruction-contract texts equal the builder output for a
    manifest with no constraints, excluding the derived per-pipeline lines.
    The assessment prompt equals the system message that `requirement:validate`
    sends, shown by a test that captures the provider request.
21. Changing any newly expressible legacy field in a copy breaks parity on
    both sides. Changing a GP-25 or `a45ddb12` field leaves parity equal and
    the field stays in the residue list.
22. `knowledge`, `policies`, `artifactTypes`, `evidenceTypes` and `validators`
    stay empty.
23. The GP-09 profile digest and every GP-09 fixture file are unchanged. An
    unbound project resolves to the pinned empty digest. The production
    catalog holds no pack. The architecture tests pass unmodified.
24. The residue list and the table above agree entry for entry. The seven
    GP-10B-2 entries are delivered; the five GP-25 entries and the
    `a45ddb12` and GP-10C entries keep their owner.
25. The diff touches only the pack package, tests and documentation. It does
    not touch `packages/domain-pack-contracts/**`, `packages/application/**`,
    `packages/runtime-host/**`, the storage packages, `apps/**`,
    `migrations/**`, `supabase/**`, an archive format, an audit event type, a
    CLI command, `agents/**`, the default office manifest,
    `officeTaskKinds`, `build-project-instructions.ts`, `requirement.ts`,
    `legacy-development-profile.ts` or the GP-09 fixtures.

### Non-goals

- No contract, schema or archive change, and no Runtime consumption.
- No policy, enforcement, approval, separation or stage capability semantics
  (GP-25), and no knowledge entry (GP-15).
- No registration, install or adoption of the pack (GP-10C).
- No generation of an instruction file or a provider request from a pack
  prompt, and no change to `requirement.ts` or the instruction builder.
- No removal or modification of any legacy default.
- No change to the frozen GP-09 profile, its gap codes or its fixtures.

### Limitations

- Reference text can drift from its source only until a test fails: each
  prompt is compared with its legacy source, so a change to a source requires
  a new pack version.
- Guidance text up to 65,536 UTF-8 bytes fits a pack prompt, but a project
  cannot copy text over 16,000 UTF-16 code units into a `replace` (GP-10B-2
  limitation). The shipped guidance is about 2 KiB and fits.
- The GP-09 fixture's synthetic guidance is not the shipped text, so guidance
  parity is shown on the shipped defaults only.
- Parity covers the default legacy state only. Whether a Runtime that
  executed these workflows would behave like the legacy pipelines is not
  shown; that is task `a45ddb12-3159-4b60-9b8b-c26516720834`.

### Implementation record

- Manifest. `packages/domain-pack-development/manifest.json` is
  `org.ai-office.development@0.3.0`, schema 1, `coreContract` `[1, 2)`, no
  dependency, with 11 prompts, in this order: the four guidance prompts, the
  six instruction-contract prompts and `requirement-assessment`. It was
  produced from the legacy sources by a script that is not committed, then
  formatted; the tests, not the script, are the evidence. The package still
  holds the same four files and no source file.
- Pinned. `manifestDigest` is
  `sha256:4f54452420bae28efd34818451b86b256e4edb785c377104cf8e7636d6f48a35`.
  The digest of the exact file bytes is
  `sha256:015c0af5d4be1837f3143f634d8f63a0ad6a91b7a64534002da4ae9955dcbb69`.
  The roles, agents (without `prompts`), task types and capabilities keep the
  digest of `0.1.0` and `0.2.0`, `45c8fb314eb56986aefcaaeeb4c90496ec9721f3dba5aa103bf7d23af49ec0e6`, computed with the role
  `responsibilities` and the agent `prompts` removed. Two older tests pinned
  digests over the pack file itself; they now read a frozen copy of the
  `0.2.0` file, `tests/fixtures/domain-pack/development-0.2.0.json`, whose
  bytes are those committed before this change.
- Comparison shape. `tests/helpers/development-pack-parity.ts` gains role
  `responsibilities`, stage `title`, `objective` and `checks`, and every task
  type of a workflow. The exemption of the `maintenance` task kind and
  `unexpressedLegacyRoute` are removed, so both sides read all five routes.
  Guidance is compared by two further functions, not in the shared shape,
  because the GP-09 fixture's guidance is synthetic: the legacy digest of each
  role against the digest of the text of the one prompt that the agent of the
  role references.
- Completeness by mutation. A mutated legacy field counts as read when the
  shared shape or the guidance digest changes. The mutated `guidance` record
  gets another digest, so `runtime_role.guidance` is read through guidance
  parity.
- List. `schemaVersion` 3, pack `0.3.0`. The seven GP-10B-2 entries have a
  `delivered` statement and `residue: null`; `owner` stays `GP-10B-2` for
  them and names the task that delivered the field. The parser refuses an
  entry that delivers nothing and states no residue. The other 12 entries are
  as GP-10B-1 left them. The guidance version is not a separate entry: the
  Runtime role `version` entry already covers how the Runtime versions
  guidance.
- Requirement assessment. `tests/e2e/development-pack-assessment-prompt.test.ts`
  runs `requirement:validate` over the Unix socket with a deterministic
  provider and compares the captured system message with the prompt. The
  provider is a fake and the test needs no credential.
- Instruction contract. The builder output for the shipped office manifest,
  which has no constraints, is compared per field: the static entries are the
  prompts, the last entries of `workflow` are the derived per-pipeline lines,
  and none of those lines is in any prompt. `policy`, `project.name` and
  `project.mission` have no static text and are not prompts.
- Tests changed where the pack changed: the pinned version and digests, the
  count of prompts, the agent keys, the task-type rename in a copy of the pack
  (which now renames the additional task type too), the route cases that named
  `maintenance` as a `taskType`, and the GP-10B-1 tests that pinned the
  residue table, the README and the one-route difference. The GP-10B-1 table
  is now checked as history for fields, owners and gap codes. The "leaves
  parity equal" cases keep only the fields that stay residue.
- Unchanged. The GP-09 profile digest of the fixture project is the pinned
  vector before and after the binding, the checksum of each GP-09 fixture
  file is pinned, an unbound project resolves to the empty configuration at
  its pinned digest, and the Runtime's own catalog holds no pack. The
  architecture tests were not edited.
- Criterion 25 is a property of this change set. It was checked on the diff
  against the base commit; no test keeps it true afterwards. PostgreSQL: no
  storage code is reached, so no PostgreSQL-gated suite covers this change and
  none was added.
- Evidence limits. Parity is shown for the default legacy state only; guidance
  parity is shown on the shipped defaults, not on the fixture. The pack is
  resolved through a catalog a test supplies. Whether a Runtime that executed
  these workflows, prompts or checks would behave like the legacy path is not
  shown and is the subject of task `a45ddb12-3159-4b60-9b8b-c26516720834`.

## GP-25 pack policy contribution contract

Status: contract implemented; pack data pending. The owner approved the scope
proposal on 2026-10-06 (option B-M, every decision below at its proposed
default) and confirmed the number GP-25. Runtime task
`1a883c04-0905-4b36-a57b-12d45fdfd59f`. GP-25 is delivered in two pull
requests. The first, the contract, delivers everything in this section except
the pack data. The second adds the policies to the development reference
pack, their parity tests and the residue list; it waits for the pack version
GP-10B-2 publishes, because pack versions are serialized.

Formal scope:

> Give the schema-1 `policies` contribution a typed form that targets one
> workflow of its own pack and declares the workflow's `enforcement` and, per
> stage, `requiresApproval`, `requiresIndependentApproval`,
> `requiresDifferentAgentFrom` and the admitted `operations`. Resolve it into
> a derived view, keep it pack-owned, and let it change only through a
> reviewed upgrade. No Runtime consumption, migration, archive format,
> catalog registration, adoption or legacy-path removal occurs in GP-25.

Anti-goal:

> the pack must not become authoritative for Runtime execution without a
> separately approved task

GP-25 is a definition layer, like GP-11, GP-12 and GP-13. A policy is a
declaration. Nothing is enforced from it: the Runtime still reads only the
pipelines of the OfficeManifest, and no pipeline, run, pin, approval, guard,
grant or capability decision is created, read or changed by a policy.
Executing from a resolved configuration, including its policies, is the
Runtime task "Runtime resolved-configuration execution parity"
(`a45ddb12-3159-4b60-9b8b-c26516720834`), which depends on GP-25.

### Decisions

The owner approved these on 2026-10-06.

1. Shape: a policy contribution that targets a workflow by local ID, not
   flags on the workflow and its stages. The workflow definition stays free
   of governance, so the GP-13 statement that a workflow definition declares
   no approval or guard stays true.
2. Level: every clause of a pack policy is mandatory. There is no weakening
   operation and no `default`/`mandatory` level; a level can be added later
   as an optional field. Consequence: a legacy project that lowered an
   approval in its OfficeManifest cannot adopt a pack that requires it
   unchanged. That is a matter for adoption (GP-10C).
3. One manifest declares at most one policy for one workflow.
4. The legacy stage `capabilities` become `operations`: opaque operation-name
   strings, independent of GP-16.
5. An absent `operations` field means that no operation is admitted. It is
   the one encoding of the legacy empty list.
6. A `replace` of a governed workflow that drops a governed stage or breaks a
   separation order fails closed.
7. Disabling a governed workflow stays allowed.
8. The upgrade report and the `project:pack:apply` guard are part of this
   task.
9. A policy without `workflow` (an untyped policy) still parses and still
   fails resolution. `workflow` is not a required field.
10. Project-owned policies, and with them a migration and an archive format,
    are deferred to a later task.
11. This declarative slice is delivered before `a45ddb12`.
12. The task is GP-25 and depends on GP-08, GP-11, GP-13 and GP-10B-1.

### Policy item

A schema-1 policy item keeps `id` and the optional `title` and `description`
and gains three optional fields:

```text
{ id, title?, description?,
  workflow: <local ID of a workflow of the same manifest>,
  enforcement?: "enforced",
  stages?: [ { stage: <stage ID of that workflow>,
               requiresApproval?: true,
               requiresIndependentApproval?: true,
               requiresDifferentAgentFrom?: [<stage ID>, ...],
               operations?: [<operation name>, ...] } ] }
```

A policy with `workflow` is a typed policy. Its clauses mean what the legacy
pipeline fields of the same names mean (`packages/domain/src/pipeline`):

| Clause                              | Declares                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `enforcement: "enforced"`           | The workflow is enforced. Absent, it is guidance.                                         |
| `requiresApproval: true`            | Completing the stage needs an approval.                                                   |
| `requiresIndependentApproval: true` | The agent assigned to the stage cannot approve or reject it.                              |
| `requiresDifferentAgentFrom: [...]` | The stage is not assigned to the agent of any named earlier stage.                        |
| `operations: [...]`                 | The operation names admitted on the stage. Absent, no operation is admitted on the stage. |

Every fact has one encoding. Absent `enforcement` means guidance; the value
`"guidance"` is not accepted. A flag is present only as `true`. `stages`,
`operations` and `requiresDifferentAgentFrom` are sets: the validated
manifest holds `stages` in ascending code-unit order of `stage` and the two
lists in ascending code-unit order, so `manifestDigest` does not depend on
the written order. An empty list is rejected; the field is omitted instead.

Absent `operations` means that no operation is admitted, which is deny by
default. The legacy authoring rule that every stage of an enforced pipeline
must write an explicit list, empty or not, is not carried over, because the
absent field and the empty list already mean the same to the legacy
authorization. A stage the policy does not name has no clause: no approval,
no separation and no admitted operation.

An operation name follows the legacy grammar
`^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$`, holds at most 128 characters, and one
stage lists at most 64 of them (`maximumPolicyStageOperations`).

The contract package rejects, with a typed `DomainPackManifestError`
(`invalid_contribution`) and the path of the offending member:

- a `workflow` that is not a local ID or names no workflow of the same
  manifest;
- a second policy for the same workflow in one manifest;
- `enforcement` with any value but `"enforced"`;
- `enforcement` or `stages` on a policy without `workflow`;
- a typed policy with neither `enforcement` nor `stages`;
- `stages` that is not an array or is empty, a stage entry that is not an
  object or has an unknown key, a `stage` that is not a stage of the target
  workflow, and a second entry for the same stage;
- a stage entry with no clause;
- a flag with any value but `true`;
- `requiresIndependentApproval` without `requiresApproval`;
- a `requiresDifferentAgentFrom` that is not an array, is empty, holds a
  duplicate, or names anything but an earlier stage of the target workflow
  in the workflow's stage order (the stage itself and a later stage
  included);
- an `operations` list that is not an array, is empty, holds more than 64
  entries, a duplicate, or an entry outside the grammar or over 128
  characters;
- any of the three fields on another contribution kind, where it remains an
  unknown field.

References are bare local IDs, so a policy can only govern a workflow of its
own manifest; a workflow of another pack, a dependency included, cannot be
named.

This is an additive section-schema extension within manifest schema 1 and
core contract version 1. A manifest without a typed policy keeps its
canonical form and `manifestDigest`; the four golden fixture digests and the
digests of the published development pack versions are unchanged. A Runtime
built before GP-25 rejects a manifest that uses the fields as unknown fields;
it never ignores them.

An untyped policy, `{ id, title?, description? }`, still parses. It has no
clause and no evaluator, and a pack that declares one still fails resolution
with `unsupported_security_composition`, as in GP-06. The extension is
therefore strictly additive: no manifest that failed to resolve before
resolves now with another meaning.

### Resolution

A pack whose policies are all typed resolves. For every typed policy the
resolver finds the target workflow in the policy's own namespace, the exact
originating pack tuple, and checks the policy against the effective workflow,
which is the pack's or the project's replacement:

| Finding                                                                                     | Code                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------- |
| A policy has no `workflow`                                                                  | `unsupported_security_composition` |
| The effective workflow lacks a stage the policy names, as a governed stage or a predecessor | `policy_target_missing`            |
| A separation predecessor no longer comes before the stage that names it                     | `policy_target_missing`            |
| A stored override or project-owned definition of kind `policies`                            | unchanged GP-06 codes              |

`policy_target_missing` is a new resolution code. It also covers a workflow
that is absent from the policy's namespace, which a verified manifest cannot
produce.

`project:configuration:show` exposes a derived policy view next to the role,
agent and workflow views:

- `policies`: one entry for every typed policy, in the GP-06 definition
  order, with `policyId`, `effectiveId`, `origin` (always `pack_owned`), the
  `title` and `description` when present, `workflowId`, `state`,
  `enforcement` (`enforced` or `guidance`) and `stages`. Each stage entry is
  `{ stage, requiresApproval, requiresIndependentApproval,
requiresDifferentAgentFrom, operations }` with both flags as booleans and
  both lists present, empty when the policy declares none, in ascending
  order of `stage`.

`policyId` is the stable ID `pack:<packId>/policies/<localId>` and
`workflowId` the `workflowId` of the GP-13 workflow view. Neither carries a
pack version or digest. `state` is `active` when the target workflow is
enabled and `inert` when the project disabled it: no workflow means nothing
to govern, and the policy is still listed so that the omission is visible.

The view is derived from the effective definitions and is not part of the
version-1 `configurationDigest` material. The digest format and the
documented empty-input vector are unchanged, and a configuration without a
policy keeps its digest. A policy is already covered by the digest through
the pack payload in `effectiveDefinitions` and its entry in `origins`.

### Policies are pack-owned and cannot be weakened

ADR-0026 requires that an override cannot weaken a pack's mandatory
requirement and that mandatory clauses compose conjunctively. GP-25 meets
this by structure, without ever comparing a "stronger" and a "weaker"
policy:

1. Policies have no project operation. `put_override` on kind `policies`
   stays `unsupported_override_operation` for `replace`, `extend` and
   `disable`, and `put_owned` stays rejected; the GP-06 resolver, both
   storage schemas and the portable archive keep rejecting stored state of
   that kind. This task adds none, and a later one may only add an operation
   that strengthens (point 6).
2. A workflow payload cannot carry a governance key. `enforcement`,
   `requiresApproval`, `requiresIndependentApproval`,
   `requiresDifferentAgentFrom`, `operations` and `capabilities` are rejected
   with `protected_security_invariant` on the workflow envelope and on a
   stage, for a `replace` and for a project-owned workflow, and nothing is
   written. On the envelope this is the GP-13 rule for every unknown key. On
   a stage these six keys were rejected before GP-25 as
   `malformed_origin_reference`, like any other unknown stage key; GP-25
   gives them the security code and leaves every other unknown stage key as
   it was. No payload that was rejected is accepted now.
3. A `replace` of a governed pack workflow must keep every stage the policy
   names, as a governed stage or as a separation predecessor, and every
   predecessor must stay earlier than the stage that names it. Otherwise:
   - `project:definition:preview` reports `policy_target_missing` and
     `project:definition:apply` refuses with it, through the GP-12/GP-13
     pre-store path that reads the exact source manifest; nothing is written;
   - `project:definition:show` reports it for a stored replacement that
     arrived without that check;
   - GP-06 resolution fails closed with it, also for state that arrived by
     restore or changed under a binding change;
   - `project:pack:upgrade` blocks as `prospective_configuration_invalid`
     (`policy_target_missing`) when a replacement would land on a version
     whose policy it does not satisfy;
   - a portable restore whose exact pack closure resolves on the host rejects
     the archive with `policy_target_missing` before anything is restored, as
     GP-22 does for a collision. When the closure does not resolve there is
     no verdict and GP-06 reports it later.
4. `disable` of a governed workflow stays allowed. The policy is then
   `inert`.
5. A stage a project adds in a replacement has no clause: no approval and no
   admitted operation. A replacement may rename the workflow, change its task
   type, reorder stages within rule 3, change stage roles and add stages.
6. Any later project policy composes conjunctively with the pack's
   (ADR-0026) and so can only add requirements.

A governed stage keeps its clauses under every customization: the clause is
keyed by the stage ID, and GP-13 identifies a stage by its ID inside its
workflow.

### Change control

A policy change is never incidental, like a role capability change in GP-11.
`project:pack:upgrade` is the only command that carries one out for an
existing workflow, under an approved plan.

The upgrade report adds two fields, both covered by `planDigest`:

- `policyChanges`: for every workflow whose policy differs between the old
  and new resolved closures, the `workflowId`, the `change` (`added`,
  `removed` or `changed`), the policy `before` and `after` where each exists,
  and whether a project override names the workflow (`customized`). A policy
  is reported as `{ policyId, workflowId, enforcement, stages }` with the
  stage entries of the resolved view. Two policies are equal when these four
  values are equal; `title` and `description` are presentation and are
  reported by the template list. It has the availability rule of the
  template list and of `roleCapabilityChanges`: `unavailable`
  (`previous_closure_unresolved`) when the previous artifacts are no longer
  installed, and empty when the selection itself does not change.
- `targetPolicies`: every typed policy of the target closure in the same
  form, in ascending `workflowId` order. Approval therefore binds the
  resulting policies even when the previous closure cannot be read.

A no-op plan reads no artifact and carries both fields empty. The
`project.pack_upgrade_applied` audit event records both fields. They contain
identities and clause values only, never a title, a description or another
definition body.

`project:pack:apply` refuses a selection change that alters the policy of a
workflow present in both resolved closures (same `workflowId`): a changed
policy, a policy added to an existing workflow and a policy removed from one.
Its preview (`project:pack:preview`) reports `policyChanges`, computed by the
same function as the upgrade plan and without the `customized` mark, and adds
the issue `policy_change_requires_upgrade` after any GP-04 failure, any
`pack_definition_collision` and the GP-11 capability refusal. The code is
carried by the preview issue and by the typed application error
`project:pack:apply` raises; the CLI prints the message, which names
`project:pack:upgrade`, on stderr and exits 1. No selection or definition
state is written and no `project.pack_binding_applied` event is added.

When the current closure cannot be resolved or the proposed manifests cannot
be read back, `policyChanges` is `unavailable` with the reason
`roleCapabilityChanges` carries, and the selection change is already refused
by the GP-11 rule for those cases (anything but a pure removal); no second
issue is added.

`project:pack:apply` still applies the addition of a pack that was not
selected, the removal of a pack, and a version change that leaves every
existing workflow's policy unchanged, which includes one that adds a governed
workflow or removes a workflow together with its policy. Applying an
identical selection remains a no-op that reads no artifact.

### Boundary with GP-16

`operations` are opaque operation-name strings, compared exactly. They are
not references to `contributions.capabilities`, are not checked against
registered providers or capability policy, and grant nothing. The two
vocabularies differ on purpose: a pack capability is a role-level local ID,
which cannot contain `:`, and a stage operation is a legacy operation name
such as `filesystem.read`. GP-16 owns capability contributions, required and
optional abstract operations and provider binding. Whether GP-16 later
relates the two vocabularies is left to GP-16. The field is named
`operations`, not `capabilities`, to keep them apart.

### Persistence

None. No migration is added on either backend, and no archive format: a
policy lives in the pack artifact and in derived output, and no project state
of kind `policies` exists. An archive of a project bound to a pack with
policies is written at the format it had before.

### Acceptance

Criteria 10 and 11 belong to the second pull request.

1. The manifest parser accepts the typed policy item. Each validation failure
   listed above raises `invalid_contribution` with the member path. Golden
   fixture digests and the digests of earlier pack versions are unchanged.
2. The written order of `stages`, `operations` and
   `requiresDifferentAgentFrom` does not change `manifestDigest`.
3. A pack whose policies are all typed and valid resolves, and
   `project:configuration:show` lists `policies` with stable IDs. A pack with
   an untyped policy still fails with `unsupported_security_composition`.
4. The empty-input `configurationDigest` vector and the digest of every
   configuration without policies are unchanged.
5. `put_owned` and `put_override` on kind `policies` are still rejected. A
   workflow payload with any governance key is rejected with
   `protected_security_invariant`. Nothing is written in either case.
6. A `replace` of a governed workflow that drops a named stage, or moves a
   separation predecessor after its dependant, is reported by
   `project:definition:preview` and refused by `apply`, and makes a stored
   state fail resolution with `policy_target_missing`.
7. A `replace` that keeps every governed stage, renames or reorders within
   the rule, or adds stages resolves, and the added stages carry no clause. A
   `disable` of a governed workflow resolves and the policy is reported as
   inert.
8. Upgrade: `policyChanges` and `targetPolicies` are present, are covered by
   `planDigest` and are recorded in the audit event with no definition body
   beyond clause values; a no-op plan carries both empty; `policyChanges` is
   `unavailable` when the previous artifacts are not installed, by the GP-11
   rule, while `targetPolicies` still lists the target closure.
9. `project:pack:apply` refuses a version change that alters an existing
   workflow's policy, with the typed error, exit 1, and no state or binding
   event written. It still applies an addition or removal of a pack.
10. (Second pull request.) The development reference pack declares policies
    that equal the legacy defaults on the five entries.
11. (Second pull request.) Mutating any of the five legacy fields in a copy
    breaks parity on both sides; the five residue entries are marked
    delivered and the list equals the plan table.
12. Negative: no pipeline, run, pin, approval, guard, grant or capability
    decision is created or changed by a policy. Run, approval and job tables
    are identical before and after binding on the GP-09 fixture.
    `PipelineRun`, `ManagePipelineRuns`, `OrchestratePipelineStage` and
    `EvaluatePipelineAuthorization` are not in the diff.
13. No migration and no archive format change. An archive of a project bound
    to a pack with policies is written at the same format as before and
    restores, and restore preflight rejects a stored workflow `replace` that
    violates criterion 6.
14. PostgreSQL-gated coverage: binding, upgrade and resolution of a pack with
    policies run in the PostgreSQL storage contract suite with results
    identical to SQLite, and `tests/integration/migration-upgrades.test.ts`
    passes with no new migration.
15. End-to-end over the Unix socket: `project:pack:preview`/`apply` including
    the refused policy change, `project:pack:upgrade` with `policyChanges`,
    `project:configuration:show` with `policies`, and
    `project:definition:apply` refused for a violating workflow `replace`.
16. The GP-09 profile digest, gap codes and fixtures are unchanged;
    architecture tests pass unmodified; the production catalog holds no pack.
17. This section, with the anti-goal verbatim, the GP-16 boundary, the one
    pointer sentence in the GP-13 section, and `a45ddb12` linked by ID. The
    pack data is delivered by the second pull request.

### Non-goals

- Runtime enforcement from a pack policy, and any change to the pipeline
  engine, runs, pins, approvals, guards, grants or controlled-action
  authorization (`a45ddb12`).
- Project-authored policies, a `default`/`mandatory` level and any override
  operation on a policy.
- Capability contracts and provider binding (GP-16), and any relation between
  `operations` and `contributions.capabilities`.
- Evidence and professional-decision clauses (GP-14, GP-17, GP-18).
- The policies of the development reference pack, their parity tests and the
  residue list, which the second pull request of this task delivers.
- A policy that governs a workflow of another pack, or more than one policy
  for one workflow.

### Known limitations

Nothing is enforced from a policy yet, so none of these has an effect today.
Each is an input for Runtime task `a45ddb12-3159-4b60-9b8b-c26516720834` and
must be decided before a pack policy is enforced.

- Two selection changes can replace a policy without a policy-level audit
  record. The `project:pack:apply` guard compares the two closures of one
  selection change and refuses only for a workflow present in both. A project
  bound to a version that governs a workflow can apply the empty selection
  and then a version that keeps the workflow and drops or changes its policy.
  Both changes apply: criterion 9 requires that removing and adding a pack
  still applies, and GP-11 has the same property for role capabilities. Each
  preview reports the `policyChanges` of its own step, but the
  `project.pack_binding_applied` event records only the pack tuples
  (`previousPacks` and `packs`), so the audit trail shows the two selections
  and not the policy difference. To decide: whether the binding event
  carries the policy changes, or the guard compares against the last
  governed state of the workflow instead of the previous closure.
- A twin of a governed workflow is ungoverned. A project can disable a
  governed pack workflow, which leaves its policy `inert`, and add a
  project-owned workflow under another local ID with the same task type,
  stages and roles. No policy applies to that workflow: a policy targets a
  workflow of its own pack, and no project-authored policy exists (owner
  decisions 7 and 10). To decide: whether such a project is outside the
  pack's governance by design, or enforcement must close the route.
- The separation list has a wider bound than the legacy one.
  `requiresDifferentAgentFrom` uses the general contribution reference bound
  of 1,000 entries, and the legacy OfficeManifest schema allows at most 16
  per stage. The bound is the approved contract and is unchanged. A pack can
  therefore declare a separation list that the legacy manifest cannot
  express: a parity gap for the second pull request, whose pack data must
  stay within the legacy bound, and for `a45ddb12`.

### Implementation record

This records what the contract pull request built where the contract left a
choice, and where the evidence stops. Three of the choices are visible to the
owner: policy identity is part of policy equality, `targetPolicies` stays
listed when `policyChanges` is `unavailable` (criterion 8), and a governance
key on a workflow stage is now refused as `protected_security_invariant`
instead of `malformed_origin_reference`.

- Contract package. `PolicyContribution` and `PolicyStageClause` in
  `packages/domain-pack-contracts/src/manifest.ts`. Shape is checked when the
  item is read and the workflow, stage and separation references once every
  section has been read, as for roles and agents; paths use the written
  positions, and the sets are ordered afterwards.
- One computation per rule. `pack-policy-clauses.ts` holds the clause values
  and `policyTargetViolations`, used by GP-06 resolution, the definition
  pre-store check and the restore preflight. `pack-policy-changes.ts` holds
  `workflowPolicyDifferences`, used by the upgrade plan and the selection
  guard.
- Policy identity is part of a policy. Two versions that declare the same
  clauses for a workflow under another policy local ID differ, so the change
  is reported as `changed` and `project:pack:apply` refuses it. The stable
  `policyId` is what a consumer keys on.
- Target policies stay available. The approved criterion 8 read "both are
  `unavailable` when the previous artifacts are not installed (the GP-11
  rule)". Under the GP-11 rule it cites only the difference is unavailable,
  and the target sets stay listed so that approval binds them. The
  implementation follows the rule: `policyChanges` is `unavailable` and
  `targetPolicies` lists the target closure. Criterion 8 above is worded
  accordingly.
- Stage governance keys. Criterion 5 asks for `protected_security_invariant`
  for any governance key in a workflow payload. A key on a stage was rejected
  as `malformed_origin_reference` before, so the six keys named above now
  get the security code on a stage; see "Policies are pack-owned and cannot
  be weakened", point 2.
- Refusal while a closure cannot be read. The selection guard adds no second
  issue in the two `unavailable` cases: the GP-11 rule already refuses every
  such change but a pure removal, which leaves no surviving workflow with
  another policy.
- Restore. The preflight raises `ProjectRestorePolicyTargetError`, a
  `ProjectPortabilityError` with the code `policy_target_missing`, for the
  first violation of the first violating replacement.
- Existing tests that pin the shape this task changes were updated and no
  other: the derived-view list in the independent digest helper of
  `tests/unit/resolve-project-configuration.test.ts`, the empty
  configuration in `tests/e2e/development-pack-parity-cli.test.ts`, which
  gains `policies: []`, the key list of `project:configuration:show` in
  `tests/e2e/daemon-cli.test.ts` and
  `tests/e2e/legacy-development-profile-cli.test.ts`, which gains
  `policies`, and the GP-25 row assertions of the GP-10B-1
  documentation test in `tests/unit/development-pack.test.ts`. No pack data,
  pinned digest, parity assertion or architecture test was edited.
- Criterion 12 is partly a property of the change set: `PipelineRun`,
  `ManagePipelineRuns`, `OrchestratePipelineStage` and
  `EvaluatePipelineAuthorization` are not in the diff against the base
  commit. No test keeps that true afterwards; the table comparison on the
  GP-09 fixture does.
- PostgreSQL. The shared storage contract suite runs binding, the pre-store
  refusal, resolution, the selection guard and the upgrade of a governed pack
  on both backends and compares each result with the pure functions, so the
  results are provider-independent. Its audit sink is in memory: the audit
  repositories have their own contract suite.
- Evidence limits. Nothing reads a policy at run time, so nothing here shows
  that a Runtime executing from these declarations would behave like the
  legacy pipelines; that is the subject of task
  `a45ddb12-3159-4b60-9b8b-c26516720834`. The development reference pack
  declares no policy yet: the policies used on the GP-09 fixture are added to
  a copy of the pack inside the test.

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
Since the 2026-10-06 re-scope of the exit, no M16 task depends on M11.6
Phase B, and the Runtime's use of the resolved view is M16.5 (see
[M16 exit re-scope](#m16-exit-re-scope-owner-decision-2026-10-06)).

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
storage, and AgentKnowledgeStore boundary. Within M16 the fixtures prove the
definition layer only: binding, resolution, customization and upgrade. Running
a core lifecycle from a pack is M16.5 (see
[M16 exit re-scope](#m16-exit-re-scope-owner-decision-2026-10-06)):

| Project           | Domain definitions and scenario                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — development   | CTO/Architect/Developer/QA; requirement → implementation → review → hardening → complete; project may replace roles or insert security, QA and human approval stages.           |
| B — legal         | Counsel/Researcher/Reviewer; matter intake → research → draft → review → approval, with source/citation evidence and human authority. No production legal service claim.        |
| C — manufacturing | Planner/Operator/Quality Engineer/Supervisor; production order → execution → inspection → deviation review → release. No MES/PLC mutation.                                      |
| D — empty/custom  | No official pack; project-created roles, agents, pipeline, artifact types and policies. It eventually runs and audits through the same contracts without modifying core source. |

## Compatibility stages

1. **Contracts:** add pack manifest validation and public contracts beside
   schema-1 office definitions; current behavior and persisted bytes still load.
2. **Resolution:** introduce deterministic pack/project/override resolution and
   inspectable origin/digest; current manifest remains an input, not a duplicate
   project store.
3. **Implicit legacy development:** recognize existing project state through a
   versioned compatibility profile without rewriting office, role, agent,
   pipeline, binding, knowledge or snapshots. GP-09 delivers this as
   legacy-state parity: the profile is compared with the Runtime's legacy
   readers. Comparing old and resolved behavior is execution parity, a
   separate Runtime task (see the GP-09 section).
4. **Extraction:** define development defaults and integration metadata in
   the development pack in small slices, proving parity for each slice. An
   old coupling is removed only by a later, separately approved task. GP-10A
   delivers the first slice as expressible-subset parity over roles, agents
   and task types and removes nothing (see the GP-10A section). GP-10B-1
   delivers the second slice as expressible-subset parity over workflows and
   removes nothing (see the GP-10B-1 section). GP-10B-2 delivers the third slice,
   the descriptive fields, role guidance and reference prompts, as
   expressible-subset parity and removes nothing (see the GP-10B-2 PR 2 section).
5. **Opt-in adoption:** preview and audit an explicit development-pack binding;
   preserve project edits and in-flight pinned runs. Support old snapshots.
   This stage is not part of the M16 exit. Adoption is planned together with
   Runtime execution from the resolved configuration and run pinning, in
   M16.5, as task GP-10C-2; its dependencies are set by its scope proposal.
   M16 delivers only the declarative content an adoption would bind
   (GP-10C-1).
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
GP-03 + GP-06 → GP-14A artifact/evidence/validator definitions
GP-06 → GP-15 knowledge; GP-06 → GP-16 capabilities
GP-16 ⇢ GP-25 operation vocabulary by name only (GP-25 operations are opaque; no dependency)
GP-09 + GP-11..GP-12 → GP-10A roles/agents/task defaults
GP-10A + GP-13 → GP-10B-1 workflow templates
GP-10B-1 → GP-10B-2 descriptive workflow and prompt vocabulary (contract, then pack 0.3.0)
GP-08 + GP-11 + GP-13 + GP-10B-1 → GP-25 pack policy contribution contract
GP-10B-2 + GP-14A + GP-15 + GP-16 → GP-10C-1 declarative evidence/knowledge/capabilities
GP-11..GP-13 + GP-14A + GP-15 + GP-16 + GP-25 → GP-17 legal, GP-18 manufacturing, GP-19 empty/custom
GP-10C-1 + GP-25 + GP-17..GP-19 → GP-20 purity and regression → GP-21 authoring guide
GP-06 + GP-07 → GP-22 binding composition preflight (hardening)
GP-06 + GP-07 → GP-23 pack manifest U+0000 policy assessment (hardening)
```

Planned for the successor milestone M16.5, outside the M16 exit (see
[M16 exit re-scope](#m16-exit-re-scope-owner-decision-2026-10-06)). The
edges in this block are provisional: they record the expected order, none is
owner-approved, and each is set by the scope proposal of its item:

```text
GP-10B-2 + GP-25 → Runtime activation: execution from the resolved configuration, persisted run pins
Runtime activation → GP-24 block pack removal on active pack-pinned runs
GP-10B-1 + GP-10B-2 + GP-25 → Runtime task a45ddb12 execution parity
Runtime activation → Runtime task a45ddb12 execution parity
GP-14A + M11.6 Phase B → GP-14B fail-closed evidence/validators, version-bound review
GP-10C-1 + Runtime activation → GP-10C-2 previewed adoption/registration
GP-16 + Runtime activation → GP-16 run gate
```

GP-14A has no M11.6 dependency. The M11.6 Phase B artifact contract is a
prerequisite to GP-14B only.
M15-4 integration and the ADR-0026 comparison satisfied GP-02's decision gate.
Tasks may be reviewed as individual PRs; no task is permission to implement
another roadmap milestone.

## Delivery tasks

Every GP key is also a project requirement key. Each row gives the task's
objective, smallest delivery slice, acceptance, artifact/verification, and
explicit exclusion. The linked AI Office task and requirement descriptions
carry the same fields. Runtime records for the split keys (GP-14A, GP-14B,
GP-10C-1, GP-10C-2) and for the rows reworded by the M16 exit re-scope are
updated separately; until then the records carry the pre-split GP-14 and
GP-10C. GP-01 through GP-09, GP-10A, GP-10B-1, GP-11 through
GP-13, GP-22 and GP-23 have passed review and merged. GP-24 and GP-25 exist
as tasks; GP-24 is planned for M16.5 and is listed in
[M16 exit re-scope](#m16-exit-re-scope-owner-decision-2026-10-06), with the
other work that left the M16 exit.

| ID and title                                                      | Depends on                      | Slice and acceptance                                                                                                                                                                                                                                                                                                                                                      | Artifact / verification                                                                                                                                                                  | Non-goal                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GP-01 — Core/domain boundary audit                                | M15 assessment input            | Classify all current domain, application, runtime, worker, lifecycle, schema, CLI, prompt, test and docs seams; record exact core/pack/adapter split and compatibility risks.                                                                                                                                                                                             | Updated evidence matrix and dependency map; review every cited source and compare current behavior.                                                                                      | Production changes.                                                                                         |
| GP-02 — Domain Pack contract ADR                                  | GP-01; M15-4 review/integration | Accept or revise ADR-0026 against ADR-0027: manifest, version/schema compatibility, lifecycle, execution boundary, conflicts, ownership, governance, knowledge, capability and purity.                                                                                                                                                                                    | Accepted ADR plus contract examples; architecture review against M11.6, ADR-0022/0025/0027.                                                                                              | Arbitrary plugin execution.                                                                                 |
| GP-03 — Minimum generic primitives                                | GP-02                           | Add only genuinely reusable type/artifact/evidence/task metadata selected by ADR; preserve existing state machines and schema-1 readers.                                                                                                                                                                                                                                  | Contract and migration plan; unit and representative upgrade tests.                                                                                                                      | Renaming development entities for appearance.                                                               |
| GP-04 — Pack catalog and deterministic resolution                 | GP-03                           | Validate locally installed IDs, versions, digests, dependencies and compatibility; duplicate/missing/incompatible/conflicting definitions fail clearly and independent of import order.                                                                                                                                                                                   | Public catalog/resolver contract; deterministic positive/negative tests.                                                                                                                 | Remote registry or downloads.                                                                               |
| GP-05 — Project pack binding                                      | GP-04                           | Persist explicit project selection through ProjectStorage; expose preview/read and compatibility failures, with SQLite and PG parity as its provider permits.                                                                                                                                                                                                             | Forward migrations, repository contracts, tenant/RLS and upgrade tests; CLI/IPC coverage.                                                                                                | Pack selection from tools or client detection.                                                              |
| GP-06 — Resolved project configuration                            | GP-04, GP-05, GP-07             | Resolve packs + project definitions/overrides into stable effective roles, agents, pipelines, policies and capability needs with origin/digest; reuse manifest revisions where sound.                                                                                                                                                                                     | Inspectable resolved view; equality, pinning and invalid-input tests.                                                                                                                    | Second mutable project authority.                                                                           |
| GP-07 — Definition ownership and project overrides                | GP-05                           | Record core/pack/project/override/resolved origin; allow replacement, extension, disablement and custom definitions where safe; security gates cannot be weakened.                                                                                                                                                                                                        | Ownership/override contract and tests for customized, removed and conflicting definitions.                                                                                               | Fixed pack workflow.                                                                                        |
| GP-08 — Pack upgrade/reconciliation                               | GP-06, GP-07                    | Preview/apply upgrades idempotently; preserve customized definitions, handle deleted/old references and active pins, audit changes, block unresolved conflicts.                                                                                                                                                                                                           | Migration/reconciliation report; repeat, rollback/failure and compatibility tests.                                                                                                       | Silent overwrite or automatic pack download.                                                                |
| GP-09 — Legacy development compatibility                          | GP-06, GP-08                    | Legacy-state parity: a versioned, read-only legacy development profile describes old offices, roles, agents, task kinds and pipelines; old databases, bindings and snapshots load unchanged. Execution parity is a separate Runtime task.                                                                                                                                 | Legacy fixture, frozen archives and comparison with Runtime legacy readers; tasks, approvals, knowledge, audit.                                                                          | Forcing adoption; inferred packs; execution parity.                                                         |
| GP-10A — Development roles and task defaults                      | GP-09, GP-11, GP-12             | Define the development pack roles, agents and task types as a committed reference artifact; prove expressible-subset parity with the legacy development defaults. No Runtime consumption, catalog registration, adoption or legacy-path removal.                                                                                                                          | Reference pack manifest and outside-pack-vocabulary list; parity tests on the GP-09 fixture and shipped defaults.                                                                        | Pack authority over Runtime execution; registration or adoption.                                            |
| GP-10B-1 — Development workflow templates                         | GP-10A, GP-13                   | Define the feature delivery, bug fix, research and release workflows in the committed development reference pack (`0.2.0`), within manifest schema 1; prove expressible-subset parity for workflows with the legacy default pipelines. No contract change, Runtime consumption, catalog registration, adoption or legacy-path removal; project pipelines remain editable. | Reference pack workflows and the outside-pack-vocabulary list with delivered part, residue and residue owner per entry; workflow parity tests on the GP-09 fixture and shipped defaults. | Pack authority over Runtime execution; prompts; contract extension; new pipeline engine or forced workflow. |
| GP-10B-2 — Descriptive workflow and prompt vocabulary | GP-10B-1 | Runtime task `e890324a-ecd4-4fcc-b1f8-37fdbdaca319`. Two PRs. (1) Additive schema-1 extension: stage `title`, `objective`, `checks`; role `responsibilities`; prompt `text`; workflow `additionalTaskTypes`; the same fields in project-owned and `replace` payloads, the resolved view, upgrade reconciliation and portable archive format 10; no migration. (2) Development pack `0.3.0` with the descriptive defaults, the `maintenance -> delivery` route, role guidance and the static instruction-contract and requirement-assessment texts as reference prompts; expressible-subset parity; generated files unchanged. | Contract section, format-10 archive tests, SQLite/PostgreSQL payload round-trip, Unix-socket e2e; pack 0.3.0, residue list and parity tests on the GP-09 fixture and shipped defaults. | Governance semantics (GP-25); `knowledge` (GP-15); route uniqueness and Runtime execution from packs (a45ddb12); registration or adoption (GP-10C); changes to the GP-09 profile. |
| GP-25 — Pack policy contribution contract                         | GP-08, GP-11, GP-13, GP-10B-1   | Runtime task `1a883c04-0905-4b36-a57b-12d45fdfd59f`. Definition layer: a typed schema-1 policy contribution that targets a workflow of its own pack and declares `enforcement` and per-stage `requiresApproval`, `requiresIndependentApproval`, `requiresDifferentAgentFrom` and admitted `operations`. Pack-owned: no project override or project-owned policy; a workflow replacement must keep governed stages; policy changes go only through a reviewed upgrade. Development pack carries the five governance entries with expressible-subset parity. No migration, no archive format. | Policy contract section, resolver view, upgrade report and apply guard; SQLite/PostgreSQL and Unix-socket e2e; pack policies, residue list and parity tests.                             | Runtime enforcement from a pack (a45ddb12); project-authored or preset-level policies; capability contracts and provider binding (GP-16); evidence and professional-decision clauses (GP-14, GP-17, GP-18). |
| GP-10C-1 — Development declarative evidence and declarations      | GP-10B-2, GP-14A, GP-15, GP-16  | First half of the split GP-10C. Declare repository/GitHub/commit/PR/CI evidence types, knowledge guidance and capability declarations in the development reference pack, as data under the GP-14A, GP-15 and GP-16 definition contracts. No adoption, catalog registration or Runtime consumption; old bindings are untouched.                                            | Development reference pack entries and the updated outside-pack-vocabulary list; resolution tests through a test-supplied catalog.                                                       | Adoption or registration (GP-10C-2, M16.5); redesign of worker, queue, model routing or governance.         |
| GP-11 — Pack role archetypes                                      | GP-06, GP-07                    | Define pack roles with stable identity and declarative capabilities; rename, replace, omit and add them in project configuration; preserve identity, capabilities and project changes on upgrade.                                                                                                                                                                         | Role contracts and customization/upgrade tests.                                                                                                                                          | Official role names; Runtime roles, grants or bindings.                                                     |
| GP-12 — Pack agent archetypes                                     | GP-11                           | Definition layer: stable agent identity; declarative role, prompt, knowledge and requested-capability references bounded by the role; project replace, disable and add; identity and project changes kept on an upgrade.                                                                                                                                                  | Agent configuration contracts and upgrade/authority tests.                                                                                                                               | Runtime agents, model, tools, pipeline, approval, grants.                                                   |
| GP-13 — Pack workflow templates                                   | GP-11, GP-12                    | Definition layer: stable workflow and stage identity; project replace (rename, reorder, add or remove stages with pack-local references), extend and disable of a pack workflow; customizations kept on an upgrade; generic engine, runs, pins, approvals and guards untouched.                                                                                           | Workflow customization contracts and upgrade/preservation tests.                                                                                                                         | Pipeline engine, Runtime pipelines, in-flight pinned runs (GP-24).                                          |
| GP-14A — Artifact, evidence and validator definitions             | GP-03, GP-06                    | First half of the split GP-14; no M11.6 dependency. Definition layer: declare domain artifact and evidence types and trusted validator references (adapter ID, exact version, input/output schema, failure policy); project customization and upgrade rules as its contract section defines. No validator runs and no evidence or review state is enforced.               | Typed fixture schemas and definition, customization and upgrade tests.                                                                                                                   | Running arbitrary pack code; fail-closed evidence and version-bound review (GP-14B, M16.5).                 |
| GP-15 — Pack knowledge guidance                                   | GP-06                           | Contribute categories, schemas, seed references, retrieval guidance and agent settings through AgentKnowledgeStore with trusted tenant/project scope.                                                                                                                                                                                                                     | Scope compatibility plan and old/new knowledge fixtures; outage and provenance tests.                                                                                                    | New vector/graph store or authority.                                                                        |
| GP-16 — Pack capability contracts                                 | GP-06                           | Definition layer: a pack capability declares required or optional operations by name and mode; the Runtime host exposes its registered providers read-only; resolution, binding preview/apply and upgrade fail closed on a missing or mismatched required provider; the resolved view reports each binding. Grants, constraints, approval and controlled execution are unchanged and still separately authorize use. No scheduler gate. | Capability contract, provider catalog port, fail-closed resolution/preflight tests, and controlled-action tests proving a binding grants nothing.                                        | Pack-granted authority or direct credentials; run gating and pins (`a45ddb12`, GP-24); stage or policy semantics (GP-25); validator adapters (GP-14); abstract multi-provider contracts. |
| GP-17 — Legal reference fixture                                   | GP-11–13, GP-14A, 15, 16, 25    | Matter intake, research, draft, citation/evidence review and human approval are defined through public contracts with no software defaults. The fixture binds through a test-supplied catalog, resolves, and is customized and upgraded; it does not run a core lifecycle.                                                                                                | Minimal legal pack/fixture and bind, resolve, customize and upgrade tests for roles, workflow, artifact, knowledge and governance definitions.                                           | Production legal service or filing adapter; lifecycle execution (M16.5).                                    |
| GP-18 — Manufacturing reference fixture                           | GP-11–13, GP-14A, 15, 16, 25    | Production order, execution, inspection, deviation and supervisor approval are defined through public contracts with no software defaults. The fixture binds through a test-supplied catalog, resolves, and is customized and upgraded; it does not run a core lifecycle.                                                                                                 | Minimal manufacturing pack/fixture and bind, resolve, customize and upgrade tests for provenance, policy and capability definitions.                                                     | MES, ERP, OPC-UA or PLC writes; lifecycle execution (M16.5).                                                |
| GP-19 — Empty/custom domain fixture                               | GP-11–13, GP-14A, 15, 16, 25    | Zero official packs: the fixture resolves with an empty selection; project-defined roles, agents, workflow, artifacts, policy and knowledge definitions are added and customized without core edits. Pack upgrade does not apply to it. It does not run a core lifecycle.                                                                                                 | Custom-domain fixture and tests: empty-selection resolution; adding and customizing project-owned definitions.                                                                           | Making `custom` a privileged official pack; lifecycle execution (M16.5).                                    |
| GP-20 — Core purity and legacy regression gate                    | GP-10C-1, GP-17–GP-19, GP-25    | Enforce `pack → public core contracts` and no core import of official packs; run the four-domain fixtures at the definition layer (bind, resolve, customize, upgrade) and the pre-pack fixtures against lifecycle, approval, storage, knowledge, audit and fencing on the legacy path.                                                                                    | Architecture rule and integration suite; `bun run check` plus DB upgrade/RLS checks as applicable.                                                                                       | Broad refactor outside M16; execution from packs (M16.5).                                                   |
| GP-21 — Pack authoring and operations guide                       | GP-20                           | Document manifest, lifecycle, project ownership/customization, conflicts, upgrades, local install/validate and custom/three reference examples using actual commands.                                                                                                                                                                                                     | Authoring guide and tested examples; docs/CLI parity review.                                                                                                                             | Marketplace, remote registry or speculative CLI commands.                                                   |

## Post-GP-06 hardening follow-ups

GP-22 is implemented. GP-23 is assessed: U+0000 stays allowed in pack manifest
text by design, with regression tests and no change to the manifest contract.
They harden the
merged GP-06 and GP-07 contracts; they are not unfinished GP-06 or GP-07 acceptance
criteria and do not reopen that work. Each is a project requirement key with
one linked AI Office task, depends only on GP-06 and GP-07, and can be
completed without the other. No other GP task depends on them.

### GP-22 — Binding composition preflight

Status: implemented. The contract below is unchanged; "Implementation" at the
end of this section records what the code does where the contract left a
choice.

Depends on: GP-06, GP-07.

GP-07 rejects a project-owned definition whose `(kind, localId)` collides with
the currently resolved pack closure. The inverse path is open: a project that
already holds a project-owned definition can apply a binding whose resolved
closure contains the same `(kind, localId)`; the binding mutation succeeds and
GP-06 then reports `duplicate_effective_definition`. A portable restore can
likewise carry individually valid binding and definition sections whose
composition is invalid.

Goal: close the inverse gap so composition validation is symmetric. GP-07
checks a prospective project definition against the resolved pack closure.
GP-22 checks a prospective pack binding against existing project-owned
definitions. Portable restore validates the combined prospective binding,
project definitions and resolved closure after archive structural validation
and before authoritative state is committed, but only when the exact closure
is resolvable on the restore host. No second resolver is introduced.

Pack availability is operational, host-local state, not portable project
authority. Portable archives do not embed pack artifacts or catalog state, and
an archive carrying an exact binding must stay restorable onto a host whose
catalog does not yet contain those artifacts. GP-22 does not make installed
pack availability a prerequisite for restore. This exception applies to
restore only; binding mutation stays strict.

Acceptance, `project:pack:preview` and `project:pack:apply`:

- the prospective exact pack closure is resolved with the existing
  GP-04/shared resolver; GP-04 and GP-06 resolution logic is not duplicated;
- every project-owned `(kind, localId)` is compared against every definition
  in the prospective resolved closure, selected packs and transitive
  dependencies alike;
- identity comparison is exact, case-sensitive and locale-independent;
- a collision is rejected deterministically with the typed diagnostic
  `pack_definition_collision`;
- preview and apply agree for a changed selection;
- a failed apply leaves the binding revision and state unchanged.

Collision diagnostic. The preflight reports `pack_definition_collision`, the
code GP-07 already uses for the same `(kind, localId)` conflict before a
mutation. Binding preview, binding apply and the restore preflight share it as
the machine-readable code. `duplicate_effective_definition` stays GP-06's
effective-resolution backstop diagnostic and is not emitted by the preflight.
Apply carries the code through a typed error whose code type includes it. The
error class restore uses is an implementation decision, but restore exposes the
same code.

Unchanged selection. GP-22 preserves the existing GP-05 behavior: applying the
exact currently active selection at the current revision is a no-op. It
performs no resolution and no composition preflight, does not increment the
binding revision and adds no audit event, even when the artifacts are
unavailable locally or the persisted composition already collides. Such a
latent collision stays visible through `project:pack:preview` and GP-06
effective resolution once the closure resolves. A changed selection always requires fresh resolution and
the preflight.

Restore scope. The preflight runs only on the restore path that is about to
write binding and definition state, a restore that creates the project and
yields `restored`. It does not apply to the existing `attached` and
`unchanged` outcomes, which write no binding or definition state, so rerunning
the same restore after a partial failure stays possible. Archive structural
and integrity validation stays separate and does not require pack resolution.

Acceptance, portable restore when the exact closure is locally resolvable.
After archive structural and integrity validation and before authoritative
state is committed:

- the exact prospective pack closure is resolved with the existing shared
  GP-04 resolver;
- project-owned `(kind, localId)` definitions are compared against that
  resolved closure;
- an archive whose sections are individually valid but whose composition
  contains a project-owned/pack collision is rejected before commit;
- restore stays atomic and leaves no partial project, binding or definition
  state.

Acceptance, portable restore when the exact closure is not locally resolvable,
for any existing GP-04 resolution failure:

- restore remains allowed; the archive is not rejected merely because selected
  or dependency pack artifacts are unavailable locally;
- the exact portable binding and definition state are persisted under the
  existing portability contract;
- definitions are never guessed, and nothing is resolved against a different
  installed pack version or digest;
- GP-06 remains the fail-closed backstop: while the exact closure is
  unavailable it reports its existing typed closure failure, `pack_unavailable`
  for an absent selected pack and `pack_dependency_failure` for an absent
  dependency, and a composition error such as `duplicate_effective_definition`
  once the exact closure becomes resolvable and conflicts with project-owned
  definitions;
- GP-06 owns these resolution diagnostics; GP-22 does not invent, rename or
  normalize them into one code.

Resolution and transaction boundary. Exact pack closure resolution and catalog
access happen before, and outside, the authoritative database transaction. No
transaction is held open during resolution, and the catalog is not read from
inside the transaction to repeat it.

Binding apply:

1. resolves the exact prospective closure outside the transaction;
2. enters the transaction;
3. keeps the existing expected-revision compare-and-set on the binding;
4. re-reads the current project-owned definitions inside the transaction;
5. compares them against the already resolved closure;
6. commits only if the composition is still valid.

Restore compares the archive's own binding and project-owned definitions,
which do not change, against the closure resolved before the transaction. No
new concurrency mechanism is introduced unless implementation evidence shows
the existing revision check is insufficient. A host-local catalog change
between resolution and commit is not prevented.

GP-06 remains the defensive fail-closed backstop for that case, for a
project-owned definition whose own preflight passed against the previous
binding and which commits after the binding apply, for corrupt state and for
non-conforming adapters.

Acceptance tests cover at minimum:

- a direct selected-pack collision;
- a collision introduced by a transitive dependency;
- a different kind with the same local ID is allowed;
- a different case is not a collision;
- removal and replacement scenarios remain possible where appropriate;
- preview/apply consistency and the `pack_definition_collision` code;
- binding revision unchanged after a rejected apply;
- an unchanged-selection apply stays a no-op with no revision increment and no
  audit event;
- a project-owned definition written between preflight and commit is caught by
  the in-transaction comparison;
- restore with an available closure and a direct collision is rejected
  atomically, for a checksummed archive;
- restore with an available closure and a transitive collision is rejected
  atomically;
- restore with an available closure and no collision succeeds;
- restore of an exact binding whose pack artifacts are absent succeeds and
  preserves the binding and definitions;
- after such a restore, GP-06 reports `pack_unavailable` for an absent selected
  pack and `pack_dependency_failure` for an absent dependency;
- when the exact artifacts later become available, a valid composition
  resolves normally and a colliding composition fails closed;
- no fallback to another installed version or digest is permitted;
- a restore yielding `attached` or `unchanged` is not rejected by the
  preflight;
- existing portability behavior covered by the repository tests, including
  restore into an empty catalog, is preserved;
- SQLite and PostgreSQL behave equivalently where the binding path supports
  both.

Non-goals: pack upgrade reconciliation (GP-08); aliases; automatic pack
selection; Runtime scheduling from pack definitions; a second configuration
resolver; making installed pack availability a prerequisite for restore.

Implementation.

- One comparison. `packDefinitionCollisions` is a pure function over a
  resolved closure and a list of `(kind, localId)`. GP-07's mutation check,
  binding preview, binding apply (before and inside the transaction) and the
  restore preflight all call it. It compares kind and local ID with `===`, so
  identity is exact by code unit. A project-owned definition collides whether
  it is enabled or disabled, as in GP-06.
- One resolution. Binding preview resolves the proposed selection once through
  `resolveInstalledPackManifests`, which wraps the GP-04 resolver and keeps the
  manifests it verified. That call reports the GP-04 issue as before and
  supplies the closure for the comparison.
- Issue order in `project:pack:preview`: a GP-04 selection or availability
  failure, alone, because nothing else can be computed without the closure;
  then one `pack_definition_collision` for each colliding project-owned
  definition, in kind then local-ID code-unit order, each naming the first
  colliding pack as `<id>@<version>`; then the GP-11 issue
  `role_capability_change_requires_upgrade`. The GP-11 guard itself is
  unchanged and `roleCapabilityChanges` is still reported next to a collision.
  `project:pack:apply` raises the first issue, so a selection that both
  collides and changes a role's capabilities fails with the collision. The
  collision comes first because no command can carry out a colliding
  selection: `project:pack:upgrade`, where the capability refusal points,
  blocks the same state as `prospective_configuration_invalid` with detail
  `duplicate_effective_definition`. The upgrade planner is not changed by
  GP-22 and does not emit `pack_definition_collision`.
- Typed errors. Apply raises `ProjectPackBindingCollisionError`, whose `code`
  is `pack_definition_collision`. Restore raises
  `ProjectRestoreCompositionError`, a `ProjectPortabilityError` with the same
  `code` and the list of collisions. The CLI prints the message on stderr and
  exits 1 for both; the restore message contains the code, since restore has
  no preview that would carry it.
- Preview of the unchanged active selection runs the comparison when the
  closure resolves, which is how a latent collision stays visible. Apply of
  the unchanged selection returns before any resolution.
- Binding apply re-reads the project-owned definitions after the
  compare-and-set replacement, in the same transaction, and throws to roll it
  back. On PostgreSQL's read-committed isolation a definition that commits
  after that read is not seen; GP-06 is the backstop for it, as stated above.
- Restore decides before its transaction whether the archive identity is
  unknown on the host, which is the path that yields `restored`, and runs the
  preflight only then. A closure that does not resolve for a GP-04 reason, or
  whose manifests cannot be read back, gives no verdict. An archive without
  packs or without project-owned definitions is not resolved at all.
- No migration, archive format, port or dependency is added. The binding
  service takes the existing definition repository and the portability service
  the existing installed-catalog port.

### GP-23 — Pack manifest U+0000 policy assessment

Status: assessed. The recorded outcome is the second one: U+0000 is allowed in
pack manifest text by design. The criteria below are unchanged; "Assessment
record" at the end of this section holds the evidence and the reasoning.

Depends on: GP-06, GP-07.

Project definition text has one shared rule: at most 16,000 UTF-16 code units,
no lone surrogate, no U+0000, valid non-BMP characters allowed, no
normalization. U+0000 is rejected there because PostgreSQL `jsonb` cannot
represent it consistently with SQLite. Pack manifest descriptive text has
separate validation and may still permit U+0000.

Goal: determine, from the actual persistence, canonicalization and runtime
boundaries, whether pack manifest text needs the same restriction. The task is
assessment-first.

Assessment: trace manifest textual fields through manifest parsing and
verification; JCS canonicalization and the manifest digest; the installed pack
catalog; SQLite persistence, if any; PostgreSQL persistence, if any; portable
or exported state, if any; the effective GP-06 configuration; CLI/API
serialization; and dashboard/read models. U+0000 is tested against those real
boundaries, not assumed unsafe because project definitions reject it.

Acceptance: exactly one explicit, evidence-backed outcome is recorded.

1. Reject U+0000 in pack manifest text, if any supported storage or runtime
   boundary cannot represent it consistently. Then:
   - one shared manifest text predicate is added;
   - rejection happens before installation or persistence;
   - valid non-BMP Unicode and existing normalization semantics are preserved;
   - SQLite/PostgreSQL parity tests are added where applicable;
   - manifest and digest regression tests are added.
2. Allow U+0000 by design, if all supported manifest paths represent it
   consistently. Then:
   - the distinction from project-definition text is documented;
   - a regression test proves U+0000 remains supported;
   - the documentation states why PostgreSQL's project-definition `jsonb`
     limitation does not apply to this path.

No restriction is introduced without evidence.

Non-goals: Unicode normalization; unnecessary changes to manifest identity
semantics; changes to GP-07 definition text behavior; a general Unicode
redesign.

Assessment record.

Manifest text is `metadata.name`, `metadata.description`, and the optional
`title` and `description` of an item in each of the eleven contribution
sections: 24 fields, all validated by the one `string` check in
`packages/domain-pack-contracts/src/manifest.ts`, which requires a string
without a lone surrogate and sets no length bound. Every other manifest string
is an identity with its own pattern and cannot hold U+0000.

Each boundary was exercised with a manifest whose text contains U+0000, on
SQLite and on PostgreSQL 17.6 where storage is involved. "Read" marks a row
established by reading the code only.

| Boundary                                                            | U+0000 in manifest text                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Lone surrogate, for comparison                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Strict JSON reader                                                  | The escape `\u0000` is accepted. A raw 0x00 byte is a JSON syntax error, `malformed_input` at `$`, "unescaped control character", like any raw control character.                                                                                                                                                                                                                                                                                                                               | `malformed_input` at `$`.                                                                          |
| Field validation                                                    | Accepted; the text is returned unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `malformed_input` (metadata) or `invalid_contribution` (contribution text), with the field's path. |
| RFC 8785 canonicalization and `manifestDigest`                      | Serialized as the six characters `\u0000`, as RFC 8785 requires; the canonical bytes hold no 0x00. The digest is deterministic and differs from the digest of the same manifest without the character.                                                                                                                                                                                                                                                                                          | Not reached.                                                                                       |
| `artifactDigest`                                                    | SHA-256 of the exact bytes; unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not reached.                                                                                       |
| Installed pack catalog                                              | Registers. The catalog is in memory and holds the exact bytes; no database stores a manifest.                                                                                                                                                                                                                                                                                                                                                                                                   | Registration fails as `malformed_catalog_entry`.                                                   |
| Pack binding, binding preview and apply, their audit events         | Unaffected: both backends store and audit pack identities only (ID, version, digest).                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                  |
| GP-06 effective configuration, `configurationDigest`, derived views | The text is intact in `effectiveDefinitions` and in the role, agent and workflow views. The digest is computed and equals the upgrade plan's prospective digest. The result is the same from SQLite and PostgreSQL state.                                                                                                                                                                                                                                                                       | —                                                                                                  |
| `project:configuration:show` over the Runtime socket                | One JSON text holding the escape; neither the frame nor the printed output holds a raw U+0000, and parsing it returns the exact text. Same with and without `--json`.                                                                                                                                                                                                                                                                                                                           | —                                                                                                  |
| Ordinary project override (`extend`, `replace`, `disable`)          | The stored payload is the project's own fields under the GP-07 text rule. Pack text is merged at resolution and is never written: an extension of an agent whose pack description contains U+0000 stores `{"title": …}` only, on both backends.                                                                                                                                                                                                                                                 | —                                                                                                  |
| Upgrade plan, `planDigest`, upgrade audit event                     | Identities, outcomes and counts only. Template change detection compares canonical forms and reports the item as changed.                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                  |
| `convert_to_replace`                                                | The one path that copies pack text into a project payload: the replacement takes the fields the extension does not set from the new template. The prospective configuration is resolved before anything is written and re-checks the payload with the GP-07 mutation contract, so the plan carries `prospective_configuration_invalid` with detail `unresolved_override`, apply raises `upgrade_blocked`, and binding, definitions and audit are unchanged. Identical on SQLite and PostgreSQL. | —                                                                                                  |
| `retain_as_project_owned`                                           | Read: it is accepted only for a `replace` override whose template is gone and moves that override's own payload, which is project text. No pack text is copied.                                                                                                                                                                                                                                                                                                                                 | —                                                                                                  |
| Portable archive (formats 6–9)                                      | `project:backup` of a project bound to such a pack succeeds; the archive names the pack by identity and holds no manifest text. Executed on SQLite; restore was not executed, since the archive carries nothing of the manifest.                                                                                                                                                                                                                                                                | —                                                                                                  |
| Dashboard, read models, generated Markdown                          | Read: none of them reads a manifest or the resolved configuration. `project:configuration:show` and the upgrade planner are the only consumers.                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                  |

For reference, PostgreSQL rejects `'{"title":"a\u0000b"}'::jsonb` with SQLSTATE
22P05, "unsupported Unicode escape sequence", and a text parameter holding
0x00 with 22021. SQLite's `json_valid` accepts the escape. That difference is
what the GP-07 rule answers.

Outcome: allow U+0000 in pack manifest text by design. No manifest path
represents the character inconsistently, so the first outcome's condition is
not met.

- Manifest text is not persisted. It lives in the catalog's artifact bytes and
  in derived, in-memory output. Project storage holds pack identities, and
  project definition payloads that are project text. PostgreSQL's `jsonb`
  limitation therefore has nothing of a manifest to act on.
- The single copy path is a project-state path, and it is already governed by
  the project definition text rule. It fails closed with a typed code, before
  any write, identically on both backends. Text longer than 16,000 code units,
  which manifest text may also be, is refused there in the same way, so
  rejecting U+0000 in manifests would not make that conversion total. The
  operator can still reach the new pack version with `remove_override`, and a
  conversion whose copied text fits project text is applied as before.
- A restriction would reject manifests that validate today and would do so
  without a boundary that requires it.

Distinction from project definition text: `isDefinitionText` bounds project
text to 16,000 code units and rejects U+0000 because that text is stored in
`payload_json` on every ProjectStorage provider and exported in portable
archives. Manifest text has neither property and keeps its own rule: a string
without a lone surrogate, not normalized, not bounded. The two rules meet only
at `convert_to_replace`, where the project rule decides.

Tests: `tests/unit/domain-pack-manifest-text.test.ts` (every text field through
parsing, canonicalization and digests), `tests/integration/pack-manifest-nul-policy.test.ts`
(resolution, storage, both conversion outcomes and the unchanged GP-07 rule, on
SQLite and, with `AI_OFFICE_TEST_POSTGRES_URL`, PostgreSQL) and
`tests/e2e/pack-manifest-nul-policy.test.ts` (the Runtime socket and
`project:backup`). No code, migration, archive format, manifest schema or core
contract version changed. The four fixture manifests hold no U+0000 and their
golden digests are unchanged.

Limits and follow-ups, none of them changed here:

- The refused conversion reports `unresolved_override` with
  `malformed_origin_reference`; it does not name the template field that broke
  the project text rule.
- The assessment holds while manifests are not stored in a database. A
  persistent catalog, or any new path that writes manifest text to project
  storage, has to repeat it.
- Observed while probing storage, and corrected afterwards outside GP-23: the
  PostgreSQL definition repository bound `JSON.stringify(payload)` to a
  `jsonb` parameter, and the stored value was a `jsonb` string holding the
  JSON text, not a `jsonb` object. The repository read it back correctly, and
  as a side effect a payload with U+0000 written past the mutation contract
  was stored on PostgreSQL as well as on SQLite. The repository now binds the
  payload object, `20261006000300_project_definition_payload_object.sql`
  converts the stored strings and makes the object shape a rule of both
  tables, and PostgreSQL refuses such a payload with SQLSTATE 22P05 while
  SQLite still stores it; see "Project definition payload objects" in
  `supabase/README.md`. The assessment never relied on the database rejecting
  anything: manifest text does not reach `payload_json`, and the one copy
  path is refused by the GP-07 rule before any write. The outcome, the GP-07
  rule and its tests are unchanged.

## M16 exit re-scope (owner decision, 2026-10-06)

The owner approved this on 2026-10-06. It is a planning record: it changes
which work the M16 exit requires and delivers no code.

**Decision.** M16 exits at the definition and contract layer plus reference
fixtures. Work that needs the Runtime to execute from a pack, or that needs
the M11.6 Phase B artifact contract, is planned for the successor milestone
**M16.5 — Domain Pack Runtime Activation** (see the [roadmap](roadmap.md)).

**Product claim.** After M16, Domain Packs are a definition, customization
and upgrade layer with reference fixtures. The Runtime does not yet execute
from a pack: pipeline runs are still created from the OfficeManifest, no run
pins a pack configuration, the production catalog holds no pack and no
project has adopted the development pack.

**Why.** The points below are the rationale recorded with the decision.

- The exit clause "Runtime execution consumes generic resolved configuration"
  had no owning task. The plan deferred activation to "a later activation
  task" and "a separately approved task" without naming one, and the
  execution-parity task `a45ddb12-3159-4b60-9b8b-c26516720834` compares
  executions and presupposes that consumption.
- GP-14 required the M11.6 Phase B contract (persisted artifacts, immutable
  versions, fingerprints, review requests and results). Phase B is "future"
  in the roadmap and does not exist in code.
- Speed: the re-scoped exit does not depend on the code of an unfinished
  milestone (M11.6 Phase B).

**Exit clauses changed.** The current text is in
[Milestone exit and exclusions](#milestone-exit-and-exclusions).

| Document | Previous clause                                                                                                                                                | Change                                                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan     | "Runtime execution consumes generic resolved configuration"                                                                                                    | Removed from the M16 exit; it is expected to become the exit of M16.5.                                                                                                                                                                                                                                                                        |
| Plan     | "roles, agents, pipelines and other pack defaults can be replaced or omitted"                                                                                  | Limited to the definitions for which an M16 task delivers a contract, each as far as that contract allows. The word "pipelines" became "workflows".                                                                                                                                                                                           |
| Plan     | "the empty/custom fixture succeeds beside development, legal and manufacturing"                                                                                | "Succeeds" is defined: a pack-backed fixture binds through a test-supplied catalog, resolves, and is customized and upgraded. The empty/custom fixture has no pack to bind or upgrade: it resolves with an empty selection and its project-owned definitions are added and customized. In neither case does the fixture run a core lifecycle. |
| Plan     | "An accepted ADR or a fixture alone does not satisfy the eventual end-to-end exit."                                                                            | Replaced by a statement of what M16 delivers and does not deliver. An accepted ADR alone still does not satisfy the exit.                                                                                                                                                                                                                     |
| Roadmap  | "development, legal, manufacturing, and empty/custom fixtures run the same core lifecycles without changes to core for each domain"                            | The fixtures bind, resolve, and are customized and upgraded through the same public contracts; they do not run a core lifecycle in M16.                                                                                                                                                                                                       |
| Roadmap  | "Project-owned roles, agents, prompts, validators, capabilities, artifacts, knowledge settings and pipelines can be customized or replaced without pack forks" | Stated at the definition layer and limited to what each M16 contract allows; Runtime roles, agents, pipelines, validators and capability bindings are not created from them.                                                                                                                                                                  |
| Roadmap  | "cross-domain scenario tests prevent development semantics from returning to core"                                                                             | "cross-domain fixture tests", since no scenario runs a lifecycle in M16.                                                                                                                                                                                                                                                                      |

**Tasks split.**

- GP-14 is split. GP-14A is the declarative definition layer for artifact
  types, evidence types and validator references; it stays in M16 and has no
  M11.6 dependency. GP-14B is the enforcement half and is planned for M16.5.
- GP-10C is split. GP-10C-1 declares evidence types, knowledge guidance and
  capability declarations in the development reference pack; it stays in
  M16. GP-10C-2 is previewed explicit adoption and registration and is
  planned for M16.5.
- GP-17, GP-18, GP-19, GP-20 and, through GP-20, GP-21 now depend on GP-14A,
  not on GP-14. GP-17 to GP-19 are definition-layer fixtures. The slice,
  verification and non-goal cells of GP-17 to GP-20 were reworded to the
  definition layer, and GP-20 runs lifecycle regressions only on the legacy
  path. Where the GP-20 row and the table above say that the fixtures bind,
  resolve, and are customized and upgraded, that applies to the three
  pack-backed fixtures; the empty/custom fixture resolves with an empty
  selection and carries project-owned definitions, as the exit text says.
- GP-17, GP-18 and GP-19 also depend on GP-25. A fixture that carries policy
  or governance definitions cannot resolve before GP-25, because GP-06
  rejects a non-empty policy section as `unsupported_security_composition`.
  For GP-19 the dependency is provisional: it has no pack, and whether
  project-owned policy definitions in a pack-free project fall under GP-25
  is set by GP-25's scope.
- The sections of delivered tasks and the committed
  `outside-pack-vocabulary.json` still name GP-10C and GP-14 as owners and
  are not rewritten. Read registration, install and adoption as GP-10C-2,
  and declarative content, including the `tools` residue, as GP-10C-1. The
  list's owner field is updated by the task that next changes it.
- Two more statements in delivered sections are not rewritten and are read
  as follows. The GP-08 section assigns blocking a removal to "the task
  that persists those pins", and the GP-13 section calls GP-24 that task.
  Runtime activation is now expected to persist the run pins; blocking a
  removal stays with GP-24, which uses them. The GP-10B-1 section and the
  roadmap say that the execution parity task "depends on GP-10B-1, GP-10B-2
  and the policy task (GP-25)": it is now also expected to need Runtime
  activation (provisional, see the table below).

**Rows owned by other pull requests.** The same owner decision set the M16
part of three tasks whose table rows this record does not edit. Until each
task's own pull request updates its row, read the rows as follows.

- GP-16. The row still lists "bind registered providers at bootstrap" and
  "reject missing required provider before runs". Those two clauses are the
  run gate and are M16.5. In M16, GP-16 is delivered as capability
  declarations plus fail-closed provider availability at resolution and at
  binding preflight, with no run or scheduler gate. The GP-16 row and its
  contract section now state this, and the run gate remains M16.5.
- GP-15. The row still reads as use of the AgentKnowledgeStore. In M16,
  GP-15 is delivered as a definition layer only: no store call and no
  seeding. Store use, seeding, and "outage and provenance" behaviour beyond
  proving that the store is untouched are not M16; this record assigns them
  to no milestone.
- GP-25. The pack policy contribution contract is an M16 task: a definition
  layer, pack-owned. Its row and scope are updated by its own pull request.

**Planned for M16.5.** None of these rows is M16 work and none has
owner-approved acceptance criteria yet; each needs a scope proposal before
any work. The "Depends on" column is provisional: it records the expected
order, and each entry is set by the item's scope proposal.

| Item                                                  | Depends on (provisional)              | Scope                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime activation (no key or task yet)               | GP-10B-2, GP-25                       | Runtime execution consumes the resolved configuration; a new run persists its `configurationDigest` and exact source pack tuples with its existing pins (ADR-0026). This is the former M16 exit clause.                                                       |
| GP-24 — Block pack removal on active pack-pinned runs | Runtime activation                    | Block a pack removal while an active run pins that pack. Whether it also blocks a workflow change on such a run, which the GP-13 section defers to GP-24, is set by its scope proposal. It needs persisted run pins, which activation is expected to deliver. |
| Runtime task `a45ddb12-3159-4b60-9b8b-c26516720834`   | GP-10B-1, GP-10B-2, GP-25; activation | Execution parity: compare execution from a resolved configuration with legacy execution.                                                                                                                                                                      |
| GP-14B — Evidence and validator enforcement           | GP-14A; M11.6 Phase B                 | Stale evidence and invalid validator output fail closed; version-bound review, atop the generic version/provenance/review contracts.                                                                                                                          |
| GP-10C-2 — Development pack adoption                  | GP-10C-1; activation                  | Previewed explicit adoption of the development pack and its catalog registration, preserving old bindings; legacy snapshot, approval, action and provenance regression tests.                                                                                 |
| GP-16 run gate                                        | GP-16; activation                     | Bind registered providers at bootstrap and reject a missing required provider before runs. The M16 row of GP-16 still lists these clauses; see "Rows owned by other pull requests" above.                                                                     |

**Left open by this decision.**

- Core still holds the closed list of five software task kinds
  (`officeTaskKinds`). Opening it is needed before a legal or manufacturing
  task type can route; no task owns it. Whether the M16 clause "no
  privileged core import or branch" covers that closed list is not decided
  here. It needs an owner ruling before GP-20's scope is approved.
- ADR-0026 is unchanged and stays an accepted target. Its parts on Runtime
  consumption of the resolved view, run pinning, removal blocked on active
  pinned runs, previewed migration to a development-pack binding, fail-closed
  validation and fixtures that "exercise the same Runtime contracts" are not
  met by the M16 exit; they are M16.5 scope.
- The definition contracts for validators, capabilities and policy
  contributions are fixed before any Runtime consumer exercises them, so
  M16.5 may have to revise them.

## Milestone exit and exclusions

The M16 exit is at the definition and contract layer plus reference fixtures
(see [M16 exit re-scope](#m16-exit-re-scope-owner-decision-2026-10-06)).

M16 completes only when old development projects remain operational at each
stage; a pack cannot silently overwrite project-owned configuration; roles,
agents, workflows and the other pack defaults for which an M16 task delivers
a definition contract can be replaced or omitted, each as far as that
contract allows; projects can add their own definitions; official packs have
no privileged core import or branch; upgrade conflicts are deterministic and
auditable; and the empty/custom fixture succeeds beside development, legal
and manufacturing. A pack-backed fixture succeeds when it binds through a
test-supplied catalog, resolves, and is customized and upgraded. The
empty/custom fixture has zero packs, so there is nothing to bind or upgrade:
it succeeds when it resolves with an empty selection and project-owned
definitions are added and customized. Pack upgrade does not apply to it;
upgrade preservation is proven on the pack-backed fixtures. Success does not
mean that a fixture runs a core lifecycle. Existing tenant, RLS, fencing,
approval, audit, provenance, task, run, pipeline and storage guarantees must
still pass.

What M16 delivers: Domain Packs as a definition, customization and upgrade
layer with reference fixtures. What it does not deliver: the Runtime does not
execute from a pack. Runs are still created from the OfficeManifest, no run
pins a pack configuration, no pack is registered in the production catalog
and no project adopts the development pack. Runtime execution that consumes
the generic resolved configuration leaves the M16 exit and is expected to
become the exit of M16.5. An accepted ADR alone does not satisfy the M16
exit, and ADR-0026 stays unmet in the parts that M16.5 owns.

Out of scope: complete legal software, MES, ERP or industrial integrations;
third-party marketplace/distribution; remote registry and dynamic downloading;
untrusted executable plugins or runtime-generated packs; replacing the
pipeline engine, governance, `ProjectStorage`, `AgentKnowledgeStore`, model
routing or worker queue. Future Pro deployment work remains in M15/M9 tracks.

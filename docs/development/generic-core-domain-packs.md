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
  workflow definition.
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

The owners above are the ones GP-10A assigned. GP-10B has since been split,
and the GP-10B-1 section holds the current list with the current owners.

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
`a45ddb12-3159-4b60-9b8b-c26516720834`). This table is the current list; the
table in the GP-10A section shows the owners as GP-10A assigned them.

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
   removes nothing (see the GP-10B-1 section).
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
GP-09 + GP-11..GP-12 → GP-10A roles/agents/task defaults
GP-10A + GP-13 → GP-10B-1 workflow templates
GP-10B-1 → GP-10B-2 descriptive contract extension/prompts
GP-25 pack policy contribution contract (provisional number; scope proposal pending)
GP-10B-2 + GP-14A + GP-15 + GP-16 → GP-10C-1 declarative evidence/knowledge/capabilities
GP-11..GP-13 + GP-14A + GP-15 + GP-16 + GP-25 → GP-17 legal, GP-18 manufacturing, GP-19 empty/custom
GP-10C-1 + GP-17..GP-19 → GP-20 purity and regression → GP-21 authoring guide
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
| GP-10B-2 — Development descriptive contract extension and prompts | GP-10B-1                        | Runtime task `e890324a-ecd4-4fcc-b1f8-37fdbdaca319`. Additive schema-1 extension and portable archive format 10, approved in principle, for the descriptive residue of GP-10B-1: stage name, objective and checks, role responsibilities and guidance, the `maintenance -> delivery` route, instruction-contract texts and the requirement-assessment prompt.             | Contract extension, prompt templates and parity tests for the descriptive residue.                                                                                                       | Governance semantics (GP-25); `knowledge` (GP-15); Runtime execution from packs.                            |
| GP-25 — Pack policy contribution contract                         | Set by its scope proposal       | Provisional number; Runtime task `1a883c04-0905-4b36-a57b-12d45fdfd59f`. Needs an owner-approved scope proposal before any work. Owns the five governance entries of the GP-10B-1 residue: pipeline `enforcement`, and stage `requiresApproval`, `requiresIndependentApproval`, `requiresDifferentAgentFrom` and `capabilities`.                                          | Set by its scope proposal.                                                                                                                                                               | Set by its scope proposal.                                                                                  |
| GP-10C-1 — Development declarative evidence and declarations      | GP-10B-2, GP-14A, GP-15, GP-16  | First half of the split GP-10C. Declare repository/GitHub/commit/PR/CI evidence types, knowledge guidance and capability declarations in the development reference pack, as data under the GP-14A, GP-15 and GP-16 definition contracts. No adoption, catalog registration or Runtime consumption; old bindings are untouched.                                            | Development reference pack entries and the updated outside-pack-vocabulary list; resolution tests through a test-supplied catalog.                                                       | Adoption or registration (GP-10C-2, M16.5); redesign of worker, queue, model routing or governance.         |
| GP-11 — Pack role archetypes                                      | GP-06, GP-07                    | Define pack roles with stable identity and declarative capabilities; rename, replace, omit and add them in project configuration; preserve identity, capabilities and project changes on upgrade.                                                                                                                                                                         | Role contracts and customization/upgrade tests.                                                                                                                                          | Official role names; Runtime roles, grants or bindings.                                                     |
| GP-12 — Pack agent archetypes                                     | GP-11                           | Definition layer: stable agent identity; declarative role, prompt, knowledge and requested-capability references bounded by the role; project replace, disable and add; identity and project changes kept on an upgrade.                                                                                                                                                  | Agent configuration contracts and upgrade/authority tests.                                                                                                                               | Runtime agents, model, tools, pipeline, approval, grants.                                                   |
| GP-13 — Pack workflow templates                                   | GP-11, GP-12                    | Definition layer: stable workflow and stage identity; project replace (rename, reorder, add or remove stages with pack-local references), extend and disable of a pack workflow; customizations kept on an upgrade; generic engine, runs, pins, approvals and guards untouched.                                                                                           | Workflow customization contracts and upgrade/preservation tests.                                                                                                                         | Pipeline engine, Runtime pipelines, in-flight pinned runs (GP-24).                                          |
| GP-14A — Artifact, evidence and validator definitions             | GP-03, GP-06                    | First half of the split GP-14; no M11.6 dependency. Definition layer: declare domain artifact and evidence types and trusted validator references (adapter ID, exact version, input/output schema, failure policy); project customization and upgrade rules as its contract section defines. No validator runs and no evidence or review state is enforced.               | Typed fixture schemas and definition, customization and upgrade tests.                                                                                                                   | Running arbitrary pack code; fail-closed evidence and version-bound review (GP-14B, M16.5).                 |
| GP-15 — Pack knowledge guidance                                   | GP-06                           | Contribute categories, schemas, seed references, retrieval guidance and agent settings through AgentKnowledgeStore with trusted tenant/project scope.                                                                                                                                                                                                                     | Scope compatibility plan and old/new knowledge fixtures; outage and provenance tests.                                                                                                    | New vector/graph store or authority.                                                                        |
| GP-16 — Pack capability contracts                                 | GP-06                           | Declare required/optional abstract operations; bind registered providers at bootstrap; reject missing required provider before runs; grants still separately authorize use.                                                                                                                                                                                               | Capability contract and fail-closed/controlled-action tests.                                                                                                                             | Pack-granted authority or direct credentials.                                                               |
| GP-17 — Legal reference fixture                                   | GP-11–13, GP-14A, 15, 16, 25    | Matter intake, research, draft, citation/evidence review and human approval are defined through public contracts with no software defaults. The fixture binds through a test-supplied catalog, resolves, and is customized and upgraded; it does not run a core lifecycle.                                                                                                | Minimal legal pack/fixture and bind, resolve, customize and upgrade tests for roles, workflow, artifact, knowledge and governance definitions.                                           | Production legal service or filing adapter; lifecycle execution (M16.5).                                    |
| GP-18 — Manufacturing reference fixture                           | GP-11–13, GP-14A, 15, 16, 25    | Production order, execution, inspection, deviation and supervisor approval are defined through public contracts with no software defaults. The fixture binds through a test-supplied catalog, resolves, and is customized and upgraded; it does not run a core lifecycle.                                                                                                 | Minimal manufacturing pack/fixture and bind, resolve, customize and upgrade tests for provenance, policy and capability definitions.                                                     | MES, ERP, OPC-UA or PLC writes; lifecycle execution (M16.5).                                                |
| GP-19 — Empty/custom domain fixture                               | GP-11–13, GP-14A, 15, 16, 25    | Zero official packs: the fixture resolves with an empty selection; project-defined roles, agents, workflow, artifacts, policy and knowledge definitions are added and customized without core edits. Pack upgrade does not apply to it. It does not run a core lifecycle.                                                                                                 | Custom-domain fixture and tests: empty-selection resolution; adding and customizing project-owned definitions.                                                                           | Making `custom` a privileged official pack; lifecycle execution (M16.5).                                    |
| GP-20 — Core purity and legacy regression gate                    | GP-10C-1, GP-17–GP-19           | Enforce `pack → public core contracts` and no core import of official packs; run the four-domain fixtures at the definition layer (bind, resolve, customize, upgrade) and the pre-pack fixtures against lifecycle, approval, storage, knowledge, audit and fencing on the legacy path.                                                                                    | Architecture rule and integration suite; `bun run check` plus DB upgrade/RLS checks as applicable.                                                                                       | Broad refactor outside M16; execution from packs (M16.5).                                                   |
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
  binding preflight, with no run or scheduler gate. The row and a GP-16
  contract section are updated by GP-16's own pull request.
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

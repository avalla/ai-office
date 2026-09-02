# Project portability and synchronization

## Identity and local binding

An AI Office installation, logical project, source repository, checkout, and
runtime database are distinct things. In particular:

```text
filesystem path != project identity
Git remote      != project identity
runtime row ID  != portable project identity
```

The schema-version 2 `.ai-office/project.json` is the repository-portable
identity anchor accepted by ADR-0008. Its opaque `repositoryId` is the logical
identity used by portable snapshots. The file remains intentionally limited to
schema, ownership, and identity; it is safe to commit and contains no path,
runtime project ID, secret, grant, or project state.

Each installation maps that identity to its own runtime-local `project.id` in
`project_repository_identity`. Canonical checkout paths remain machine-local
`project_source` rows. The same project can therefore be:

```text
repo_abc -> runtime A project 17 -> /Users/alice/dev/example
repo_abc -> runtime B project 92 -> /home/alice/work/example
```

An additional checkout in an existing runtime must still satisfy the accepted
Git-remote corroboration rule. A repository binding that disagrees with an
archive fails closed. Restore never silently rewrites an unrelated binding.
When no committed binding exists, matching Git provenance may corroborate the
target; when a matching binding exists, the remote remains diagnostic and is
not promoted to project identity.

## Portable snapshot v1

`project:backup` writes one UTF-8 JSON file with the `.aioffice` extension. The
root is a strict envelope:

```text
manifest
  format = ai-office-project
  formatVersion = 1
  projectIdentity
  createdAt
  revision { id, parentRevisionId?, stateChecksum }
  optional sanitized source provenance
  declared content groups
state
  explicitly modeled portable records
integrity
  algorithm = sha256
  checksum over canonical manifest + state
```

The maximum input/output size is 32 MiB. JSON keys are strict and collection,
identifier, text, numeric, timestamp, and enum values are bounded. The state
checksum is independent from archive creation metadata; a second backup of
unchanged semantic state reuses the head revision. A changed backup creates an
immutable child revision.

JSON was chosen over ZIP or tar because snapshot v1 has no binary artifacts.
It needs no extraction, so archive entries cannot perform path traversal,
zip-slip/tar-slip, symlink writes, or arbitrary artifact placement. A later
format may introduce a container only alongside a defined artifact ownership
and path model.

The SHA-256 values are integrity checks, not signatures. A party able to rewrite
an archive can recompute them, so import treats every archive as untrusted even
after checksum validation. Strict schema/size validation, sensitive-key checks,
binding identity, and source corroboration remain independent gates. A future
remote adapter must authenticate its transport or objects and must still
revalidate the archive checksums after download.

### Included

- project name, user-owned description, and timestamps, except exact legacy
  generated descriptions proven by a matching local source binding;
- task lifecycle state, including assigned, running, blocked, or review-waiting
  semantics when no live execution authority remains;
- active profile knowledge except detected checkout root paths, raw remote URL
  entries, and source references; sanitized remote provenance lives only in the
  manifest;
- all office manifest revisions;
- milestones, requirements, architecture decisions, and only those reviews and
  approvals whose complete referenced portable subject is present;
- project role and agent definitions, with a portable source marker on restore;
- terminal agent-run identity, status, and timestamps without action, result,
  error, pipeline, or worktree payloads;
- sanitized network Git remote/branch provenance when all portable checkout
  sources agree.

Project descriptions are semantic user/domain data and are preserved verbatim;
the snapshot layer never infers meaning from a prefix such as `Imported from`.
One historical importer generated exactly `Imported from <root>`. The portable
projection omits that description only when `<root>` exactly equals a
`project_source.local_path` or historical
`project_checkout_detachment.local_path` belonging to the same project. It does
not mutate the database. Unmatched paths, arbitrary suffixes, and different
casing remain user data. New repository imports no longer inject checkout paths
into descriptions. Structured source/detachment rows own that local provenance.

Network Git provenance accepts HTTP(S), SSH, Git-protocol, and normalized
scp-style remotes. URL user information, query strings, and fragments are
removed. `file://`, POSIX, relative, Windows drive-absolute or drive-relative,
UNC, and ambiguous remote strings are machine-local and omitted. Source-row
ordering has no meaning: if
all sanitized network remotes resolve to one comparable remote, that remote is
recorded; if distinct network remotes remain, source provenance is omitted.
Branch is included only when the contributing sources agree. The remote never
becomes project identity. Recursive sensitive-field validation rejects nested
structured fields such as token, password, credential, authorization, secret,
or API key. Profile entry `key` and `category` labels additionally fail closed
when their normalized structured meaning denotes an API key, access token,
password, secret, credential/reference, authorization, or token. Backup reports
the entry ID and label without its value. AI Office does not regex-scan arbitrary
free-form descriptions or prose and cannot promise that a user never pasted a
secret there.

### Excluded

- absolute checkout and worktree paths, scans, detachments, locks, sockets,
  PIDs, processes, caches, drafts, projections, and client executable/config
  state;
- active agent or pipeline execution and task locks;
- run action intents, results, errors, and event payloads;
- resources, credential references, capability grants, action requests,
  simulations, local approvals, executions, and audit events;
- managed secret values and connector/provider credentials;
- global reusable memory in `global.sqlite`;
- pricing, budgets, reservations, usage, and cost accounting;
- source files and binary artifacts.

Security authority is intentionally re-established on the destination. A past
approval or capability record never becomes current machine authority merely
because another machine exported it.

### Snapshot consistency and referential closure

Snapshot v1 is referentially closed. Requirements may reference only exported
milestones; superseding ADR references resolve within the exported ADR set;
agents reference exported roles; and terminal run summaries reference exported
tasks and agents. Review subjects must resolve to an exported task,
requirement, ADR, milestone, or terminal run. An approval is exported only with
its review. Pending reviews have no approval or completion timestamp; decided
reviews have one matching append-only approval.

Active-run reviews and their approvals are omitted while the run is not
portable. In practice the active run also makes the project non-quiescent, so
normal `project:backup` rejects rather than emitting a partial archive. Once the
run is terminal, its summary and attached governance records enter the portable
closure deterministically.

### Execution-authority quiescence

Snapshot v1 has no resumable execution model. Backup therefore rejects before
advancing the project-state head when any of these are present:

- an agent run in `queued`, `preparing`, `running`, or `reviewing`;
- an active pipeline run;
- an unexpired task lock.

Task status alone is not execution authority. `pending`, `assigned`, `running`,
`blocked`, `waiting_review`, and terminal task values are all preserved exactly
when no live run, pipeline, or lock remains. A blocked task may represent a
long-lived external dependency; an assigned or review-waiting task may likewise
remain meaningful without an executor. The authoritative blockers are the
execution principals themselves, not correlated status names. Backup reports
every live run/pipeline/lock by identity. It never rewrites lifecycle state,
fabricates a run on restore, or claims that excluded execution can resume on
another machine.

## Backup and restore lifecycle

Backup is a daemon-backed project command. The application service checks
execution-authority quiescence and loads one consistent semantic snapshot in a
short database transaction. It constructs and validates the complete archive
schema, semantic profile safety, closure, checksums, and manifest before it
records a changed `local_snapshot` revision. State that is intrinsically
non-portable therefore leaves revision/head state unchanged. The revision means
the daemon observed this semantic state, not that an output artifact was
published. The infrastructure adapter then writes the envelope as a separate
filesystem result.

This deliberately avoids pretending SQLite and the filesystem share one
transaction. The normal-process publication protocol is:

1. open a fresh private temporary file in the destination directory;
2. write and `fsync` that file;
3. hard-link it to the final name, which refuses an existing target;
4. remove the temporary name.

The boundary behavior is explicit:

- before the observation transaction, no new revision exists;
- after the transaction but before publication, the semantic observation may
  be the head even though no archive exists;
- temporary-write or link failure removes the temporary file when the process
  is still running and leaves the observation valid;
- an identical retry reuses the same revision and can publish to a fresh path;
- an existing target is never overwritten;
- after final link creation, the target is the complete synchronized temporary
  file; a process or machine crash may still leave the private temporary link.

This is atomic/no-clobber publication during normal execution. AI Office does
not claim parent-directory `fsync` or power-loss durability after successful
return. Revision `createdAt` and manifest `createdAt` are the semantic
observation time, not a persisted archive-publication timestamp.

Restore reads and validates a regular, non-symlink `.aioffice` file before any
database mutation. It verifies format/version, strict schema, sensitive fields,
state checksum, envelope checksum, repository identity, target binding, local
association, and checkout evidence. New authoritative state, identity mapping,
revision, and local source association are inserted in one short transaction.
The repository binding is atomically reconciled afterward, following the same
database/filesystem ordering and partial-state reporting used by install.

Restore outcomes are conservative:

- unknown identity: create a new runtime-local project and bind this checkout;
- known identity plus identical semantic state: attach a verified checkout or
  return unchanged only when any local head is the same revision;
- different local semantic state: reject as a conflict;
- different local/archive revision heads: reject rather than roll back or
  rewrite lineage, even when their current semantic checksums happen to match;
- different repository/archive identity: reject before state mutation;
- duplicate entity/cross-project constraint failure: roll back the transaction;
- binding write failure after a committed restore: report a partial result and
  recover through status plus the same idempotent restore.

There is no destructive overwrite or `--force`. Restoring an older backup over
newer/different local authority is therefore impossible by accident.

Decided governance reviews are reconstructed through the existing database
sequence: insert the review as pending, insert its append-only approval so the
governance trigger finalizes it, preserve the archived review completion time,
and compare the fully reloaded portable state with the archive before commit.
This preserves both legacy review completion timestamps and approval creation
timestamps when they differ, without weakening triggers or constraints.

Restored terminal agent-run rows are summaries only. Their terminal status is
irreversible, and action intent, pipeline binding, worktree, result, error, and
event data are null or absent. The run state machine rejects every transition
from completed, failed, or cancelled back to running; pipeline completion
requires a running/reviewing run with a persisted pipeline binding; controlled
actions require a persisted intent; and task-lock acquisition accepts only a
non-terminal run bound to that task. Restored summaries therefore cannot resume
a pipeline, authorize an action, or reacquire execution authority.

## Revision and remote architecture

`project_state_revision` stores immutable revision identity, optional parent,
semantic checksum, local acquisition origin, and observation time.
`project_state_head` stores the local head and its known synchronization base.
Revisions are AI Office state observations, not Git commits or archive
publication receipts. A source commit may later be provenance on a snapshot,
but many AI Office revisions may occur without any source commit.

Revision IDs use globally unique generated identifiers and are globally unique
inside one runtime database. A collision with another project fails closed;
`ON CONFLICT` never aliases the rows because stored project, parent, checksum,
and observation time are revalidated. `project_state_revision_identity`
reserves one project owner for every materialized revision ID and every
referenced-but-unmaterialized parent/base ID. A shallow parent may later be
materialized only by that project; another project cannot retroactively capture
the identifier. A known parent must belong to the same project, self/cyclic
lineage is rejected (including cycles exposed by later materialization), and an
absent parent remains an intentional shallow lineage anchor when restoring an
archive from another installation. The restored archive revision becomes both
local head and known base. Attaching another checkout to an already identical
headed project changes only the machine-local source association; it does not
rewrite head, base, or revision metadata. Repeated restore is idempotent.
Binding failure after a new restore commit retains the documented partial
recovery path.

The application-layer `ProjectStateRemote` port is backend-neutral:

- read the remote head;
- pull a requested/head archive;
- push with `expectedHeadRevisionId` compare-and-swap.

No remote adapter or push/pull command is implemented in this slice. The first
planned adapter is filesystem storage for a NAS, mounted drive, or synchronized
folder. GitHub, GitLab, Forgejo, S3/R2, Postgres, and hosted AI Office are later
adapters; none belongs in application/domain types.

Future push/pull must report local base, local head, and remote head. A push is
safe only when the expected remote head still matches. A stale writer receives
a divergence result and cannot overwrite the remote. Pull likewise must not
replace changed local state. Automatic semantic merge is not claimed.

## Evolution to semantic sync

Whole-project snapshots are the conservative transfer and backup unit. Future
multi-machine work may add immutable, globally identified entity changes such
as `task.created`, `task.updated`, or `decision.created`. Independent changes
to different entities can then merge, while incompatible changes to one entity
need explicit conflict resolution. This is an evolution path, not an
event-sourcing rewrite in the current implementation.

## Migration and lifecycle ownership

Migration 0022 preserves existing `project_repository_identity` rows. An
unmapped pre-feature project without a source association receives one random
opaque identity exactly once; pre-feature imported repositories continue
through normal binding migration/install so their committed identity remains
authoritative. New `project:create` and `project:import` commands associate an
identity transactionally. Repeated migration is a no-op.

Migration 0023 names local revision acquisition honestly as a semantic
`local_snapshot` observation. Migration 0024 creates lightweight project-owned
revision identities for every materialized revision and shallow parent/base
reference. It preserves valid lineage exactly and aborts atomically if
historical rows assign one revision ID to more than one project.

Repository uninstall preserves `.ai-office/project.json` and all external
`.aioffice` files. Runtime purge owns the revision tables only as part of
`project.sqlite`; it never follows paths to exported backups. Remote
configuration/cache ownership will be defined with the future adapter rather
than guessed now.

Git remains responsible for reviewable declarative source such as the identity
file, `AI-OFFICE.md`, intentional agent/pipeline configuration, policies, and
documentation. Mutable SQLite files and snapshot archives are not a Git merge
or synchronization protocol.

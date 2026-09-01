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

- project name, user-owned description, and timestamps;
- pending and terminal tasks in an execution-quiescent project;
- active profile knowledge except detected checkout root paths, raw remote URL
  entries, and source references; sanitized remote provenance lives only in the
  manifest;
- all office manifest revisions;
- milestones, requirements, architecture decisions, and only those reviews and
  approvals whose complete referenced portable subject is present;
- project role and agent definitions, with a portable source marker on restore;
- terminal agent-run identity, status, and timestamps without action, result,
  error, pipeline, or worktree payloads;
- sanitized network Git remote/branch provenance when available.

Imported-source descriptions generated as `Imported from <absolute path>` are
not portable descriptions and are omitted. Network Git provenance accepts
HTTP(S), SSH, Git-protocol, and normalized scp-style remotes. URL user
information, query strings, and fragments are removed. `file://`, POSIX,
relative, Windows-drive, UNC, and ambiguous remote strings are machine-local
and omitted. A sensitive-key check rejects snapshot state containing fields
such as token, password, credential, authorization, secret, or API key; backup
fails rather than exporting the suspect value.

### Excluded

- absolute checkout and worktree paths, scans, detachments, locks, sockets,
  PIDs, processes, caches, drafts, projections, and client executable/config
  state;
- active agent or pipeline execution and task locks;
- run action intents, results, errors, and event payloads;
- resources, credential references, capability grants, action requests,
  simulations, local approvals, executions, and audit events;
- secret values and connector/provider credentials;
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

### Execution quiescence

Snapshot v1 has no resumable execution model. Backup therefore rejects before
advancing the project-state head when any of these are present:

- a task in `assigned`, `running`, `blocked`, or `waiting_review`;
- an agent run in `queued`, `preparing`, `running`, or `reviewing`;
- an active pipeline run;
- an unexpired task lock.

Pending tasks and terminal tasks (`completed`, `failed`, or `cancelled`) remain
portable. Backup reports every blocker by task/run/pipeline identity. It never
rewrites lifecycle state, fabricates a run on restore, or claims that active
work can resume on another machine.

## Backup and restore lifecycle

Backup is a daemon-backed project command. The application service checks
execution quiescence and loads one consistent semantic snapshot in a short
database transaction, records/reuses its revision only after those checks, and
returns the envelope. The infrastructure adapter atomically writes a new
mode-`0600` file and refuses overwrite.

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
event data are null or absent. Existing action and pipeline gateways therefore
cannot treat them as live execution principals or recover transferred
authority.

## Revision and remote architecture

`project_state_revision` stores immutable revision identity, optional parent,
semantic checksum, provenance, and creation time. `project_state_head` stores
the local head and its known synchronization base. Revisions are AI Office
state snapshots, not Git commits. A source commit may later be provenance on a
snapshot, but many AI Office revisions may occur without any source commit.

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

Repository uninstall preserves `.ai-office/project.json` and all external
`.aioffice` files. Runtime purge owns the revision tables only as part of
`project.sqlite`; it never follows paths to exported backups. Remote
configuration/cache ownership will be defined with the future adapter rather
than guessed now.

Git remains responsible for reviewable declarative source such as the identity
file, `AI-OFFICE.md`, intentional agent/pipeline configuration, policies, and
documentation. Mutable SQLite files and snapshot archives are not a Git merge
or synchronization protocol.

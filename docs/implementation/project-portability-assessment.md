# Project portability assessment

Date: 2026-09-01; hardened through 2026-09-02

## Current architecture

1. **Current identity.** Runtime-local `project.id` identifies one row in one
   `project.sqlite`. The committable `.ai-office/project.json` carries the
   opaque `repositoryId` that survives moves and clones.
   `project_repository_identity` maps it to a selected runtime project, while
   `project_source.local_path` is a machine-local checkout association.

2. **Current storage.** The daemon owns authoritative state in
   `<runtime-home>/project.sqlite`. `global.sqlite` separately owns reusable
   memory. `AI-OFFICE.md`, client skills, and Markdown exports are derived
   integration/projection artifacts rather than authority.

3. **Portable state.** Snapshot v1 can safely carry logical identity, project
   metadata, all task lifecycle states when live execution authority is absent,
   sanitized active profile
   knowledge, office manifest revisions, referentially closed governance
   records, project role/agent definitions, and terminal run summaries without
   execution-authority or result/error payloads.

4. **Local or security authority.** Absolute source/worktree paths, checkout
   detachments, local scans, active runs/locks/pipelines, resources, credential
   references, capability grants, controlled actions/approvals/executions,
   audit payloads, daemon state, caches, projections, and client configuration
   must not transfer. Global memory, pricing, reservations, usage/cost data,
   and purge state also have separate ownership. Managed credentials and
   structured profile values explicitly labelled as credentials are never
   portable; arbitrary human prose is not content-scanned.

5. **Migration.** Migration 0019 introduced portable identity mapping but raw
   pre-M7.5 projects can remain unmapped until install. A forward migration
   should give every safely unambiguous unmapped project one globally unique
   opaque identity exactly once, preserve existing mappings, and cover future
   raw creation. Imported repositories whose committed identity is not yet
   known must continue through install instead of being guessed. Install must
   reuse an existing mapping when creating a missing repository file. Revision
   metadata must not rewrite project history.

   Historical imports encoded `Imported from <root>` in `project.description`.
   Snapshot projection omits it only when the complete description exactly
   matches a structured `project_source.local_path` or checkout-detachment path
   for the same project; the authoritative description is not mutated. All
   unmatched or differently cased descriptions remain user data. New imports
   store path provenance only in structured source/profile records. Revision
   ownership migration reserves materialized IDs plus shallow parent/base IDs
   and fails on contradictory historical ownership rather than choosing a
   project.

6. **Archive format.** A strict, size-bounded JSON envelope with the
   `.aioffice` extension is the safest v1. It is one self-describing,
   canonicalizable file. Avoiding extraction removes zip-slip/tar-slip,
   symlink-entry, and artifact-path write surfaces. SHA-256 over canonical
   manifest and state detects corruption and inconsistent envelopes; it is not
   a signature or proof of archive origin.

7. **Remote scope.** Full push/pull does not fit safely in this PR. The current
   aggregate model has no entity/event merge semantics or central mutation
   generation. Remote configuration, storage ownership, CAS recovery, status,
   and cleanup would destabilize the mandatory backup/restore slice.

8. **First backend.** The first later adapter should be a deterministic
   filesystem snapshot remote. It exercises the provider-neutral port and CAS
   rules needed by NAS, mounted cloud storage, and backup disks without adding
   provider credentials. Hosted systems remain replaceable adapters.

9. **Divergence.** Revisions are immutable and carry an ID, optional parent,
   and state checksum. The remote port requires an expected head for CAS push.
   Restore creates an unassociated identity, attaches a checkout when local
   state and revision are identical, or no-ops for the same snapshot. Different
   existing authoritative state or revision lineage is a conflict; there is no
   overwrite or force path.

10. **Security.** Risks include oversized/malformed input, future schemas,
    checksum corruption, sensitive fields, cross-project IDs, path traversal,
    symlink substitution, wrong-repository binding, rollback, and partial
    database/filesystem coordination. Mitigations are strict bounds, canonical
    checksums, no extraction or embedded write paths, sensitive-key rejection,
    regular-file checks, identity matching, foreign keys, a short transaction,
    semantic profile-label validation before revision creation,
    normal-process atomic/no-clobber publication, and fail-closed conflicts.
    Parent-directory crash durability is not claimed. The CLI remains a daemon
    client.

    The implementation review added further invariants. Task status is semantic
    data, so backup rejects non-terminal runs, active pipelines, and unexpired
    locks rather than status-name proxies. Revisions are local semantic-state
    observations; archive publication is a separate no-clobber filesystem
    result. Portable Git provenance accepts only sanitized network remotes and
    is included only when all portable checkout remotes agree. Governance and
    agent records must form a closed reference graph. Shallow revision IDs have
    stable project ownership before their full revision payload is present.

11. **Documentation.** README needs the workflow and ownership map. Storage and
    overview docs need snapshot/revision boundaries. A focused development
    document should own format, lifecycle, security, migration, remotes, and
    semantic-sync evolution. The roadmap must separate completed snapshots from
    future remote transport and merge. Only the generated skill source needs
    concise command guidance.

## Scope decision

This PR will implement stable identity migration, conservative local binding,
versioned portable backup/restore, integrity validation, immutable snapshot
revisions, a provider-neutral CAS remote port, CLI/daemon wiring, security
hardening, tests, and current documentation.

It will not implement a remote adapter, push/pull, forced restore, database-file
sync, semantic merge, binary artifacts, secrets transfer, active execution
migration, or global-memory migration. These boundaries preserve current
daemon, transaction, capability, and ownership invariants while leaving a
direct path to filesystem remotes and later entity/event sync.

Snapshot v1 deliberately requires execution-authority quiescence rather than
attempting to normalize or recreate active work. It preserves task lifecycle
status exactly when no live run, pipeline, or lock remains. Governance restore
replays the valid pending-review then append-only-approval sequence and verifies
the reloaded portable state through its canonical checksum before commit.

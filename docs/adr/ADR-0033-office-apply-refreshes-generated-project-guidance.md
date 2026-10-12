# ADR-0033: Refresh generated project guidance after `office:apply`

- Status: Proposed (owner direction: option 3, design pending approval)
- Date: 2026-10-12
- Relates to: ADR-0012

## Context

`office:apply` persists a new office manifest revision in SQLite. The
repository skill and `AI-OFFICE.md` are derived from that state (ADR-0012), but
they are written only by `install` and the client commands. After a manifest
change the generated task-kind guidance stays stale until someone reruns
`install`. M16.5 makes the gap more visible because a manifest can now declare
task kinds that the generated skill does not list.

Constraints that any fix must respect:

- ADR-0012: file writes follow `inspect -> plan -> approve exact hash -> apply
-> validate`; unmanaged files are never overwritten.
- AGENTS.md: the Runtime host owns state, the client owns relative local
  filesystem semantics, and the daemon must not infer a caller's working
  directory or write to a caller's repository on its own.
- Filesystem mutation outside that flow is not a controlled action.
- Transactions stay short; no filesystem work inside them.

## Options

1. **Daemon rewrites files inside `office:apply`.** Rejected. It bypasses the
   approved-hash flow, makes the Runtime write into client-owned paths, and
   couples a state transition to a filesystem side effect.
2. **Client follows `office:apply` with the existing install plan/apply flow
   (recommended).** After the Runtime confirms the new revision, the CLI
   (which owns local paths) runs `inspect -> plan` for the bound root. If the
   plan only touches AI Office-managed artifacts it is presented with its
   exact hash and applied on the usual approval; with `--yes`-style
   non-interactive approval the hash is still bound. No new write path, no
   daemon filesystem access. A failed or declined refresh leaves the revision
   committed and reports the artifacts as drifted.
3. **Read-only stale hint.** `office:apply` reports that the skill is stale
   and names the command to run. Smallest change, no automatic refresh.

## Decision (proposed)

Adopt option 2. `office:apply` remains a state-only Runtime command. The CLI
client chains the existing plan/approve/apply flow for the bound repository
root after a successful apply, reusing `ManageSharedProjectArtifacts` and the
client adapters unchanged.

## Consequences

- The refresh is a client behavior; callers that use the Runtime API directly
  still need `install` or a client command.
- Partial failure is repairable: rerunning install reconciles.
- No migration, no change to the manifest schema or the contract format.
- Tests: CLI end-to-end through the Unix-socket protocol for apply followed by
  refresh, declined refresh, unmanaged-file preservation, and a project with
  several bound roots.

## Open question for the owner

Confirm option 2, or choose option 1 (not recommended) or 3. Implementation
starts only after this ADR is accepted.

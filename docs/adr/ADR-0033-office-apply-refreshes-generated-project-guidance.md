# ADR-0033: Refresh generated project guidance after `office:apply`

- Status: Accepted (owner approved option 2 on 2026-10-12; approval model amended on 2026-10-13)
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
2. **Client follows `office:apply` with the existing `install` flow
   (recommended).** After the Runtime confirms the new revision, the CLI
   (which owns local paths) asks for approval and then runs `install` for the
   bound root. No new write path, no daemon filesystem access. A failed or
   declined refresh leaves the revision committed and reports the artifacts as
   drifted.
3. **Read-only stale hint.** `office:apply` reports that the skill is stale
   and names the command to run. Smallest change, no automatic refresh.

## Decision

Adopt option 2. `office:apply` remains a state-only Runtime command. The CLI
client chains the existing `install` flow for the bound repository root after
a successful apply and an explicit approval, reusing `ManageSharedProjectArtifacts`
and the client adapters unchanged.

**Amendment (2026-10-13, owner decision).** The first draft bound the approval
to an exact plan hash. `install` plans and applies internally and exposes no
plan or hash, and adding one would be a new public Runtime contract. The owner
chose to keep the existing contract: the approval is an explicit decision to
run `ai-office install .` for the bound repository (an interactive `[y/N]`
answer, or `--refresh-guidance`). It is not bound to a plan hash, so a
concurrent change between approval and apply is not re-approved, and `install`
may reconcile other AI Office-managed artifacts (for example `AI-OFFICE.md`).
It never overwrites a user-owned file's own content, but it can modify the
file: when Claude is detected and an unmarked `CLAUDE.md` exists, `install`
appends the managed bridge block to it, and it can replace an existing managed
block inside a merged file. Approving the refresh therefore permits those edits
too; arbitrary user content is preserved. Hash-bound approval for this refresh remains a possible
follow-up that needs its own contract decision.

## Consequences

- The refresh is a client behavior; callers that use the Runtime API directly
  still need `install` or a client command.
- Partial failure is repairable: rerunning install reconciles.
- No migration, no change to the manifest schema or the contract format.
- Tests: CLI end-to-end through the Unix-socket protocol for apply followed by
  refresh, declined refresh, unmanaged-file preservation, and a project with
  several bound roots.

## Implementation notes

- The refresh runs only when the caller's working directory resolves to a valid
  binding whose project equals the applied project; otherwise nothing is
  touched and nothing is printed.
- The refresh rewrites repository files, so it requires approval before it
  runs: an interactive `[y/N]` answer, or the client-only
  `--refresh-guidance` flag for non-interactive callers (never sent to the
  Runtime). Without approval the revision stays committed, the files stay
  untouched, and the recovery command is printed. Once approved it reuses
  `install`, which plans and applies for the bound root exactly like a manual
  install. Outcomes are reported on stderr: reconciled (exit 0), finished with
  warnings (exit 2, or a user-owned skill that is preserved, decided from the
  skill file with the adapter's own ownership predicate), or failed.
- The `office:apply` exit code is never changed by the refresh.

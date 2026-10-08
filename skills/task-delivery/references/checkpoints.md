# Checkpoints

A checkpoint is the machine-readable half of execution continuity: the
implementation context writes one at every gate it passes, and a fresh
context resuming the work reads the latest one instead of reconstructing
state from prose. The handoff packet stays the human map; a handoff cites
the latest checkpoint's id, and the checkpoint carries the machine state.

## Layout

All paths are inside the task worktree, under the repository's shared Git
exclude (`$(git rev-parse --git-common-dir)/info/exclude`), per task so
successive tasks sharing a worktree never share state:

```text
.task-delivery/<task>/handoff.md              context-handoff packet
.task-delivery/<task>/checkpoints/<seq>-<gate>.json   published, immutable
.task-delivery/<task>/checkpoints/index.json          latest-valid pointer
.task-delivery/<task>/checkpoints/.tmp-<uuid>         in flight, ignored
```

`<task>` is the task identifier, or the branch name when there is no task
identifier - the same rule as the handoff packet. `<seq>` is a six-digit,
1-based sequence; `<gate>` is the gate id (`preflight`, `design`,
`implementation`, `pull_request`, `review`, `second_review`, `qa`,
`external_review`, `ready_for_merge`, `post_merge`).

## Schema, version 1

```json
{
  "schemaVersion": 1,
  "id": "uuid-or-equivalent",
  "run": { "task": "id-or-null", "milestone": "id-or-null", "branch": "b", "base": "main" },
  "head": { "sha": "full-sha", "dirty": false, "dirtyPaths": [], "capturedAt": "iso" },
  "stage": { "gate": "design", "seq": 1 },
  "profile": "full",
  "evidence": [{ "claim": "...", "ref": { "kind": "command", "value": "..." } }],
  "openFindings": [{ "id": "R1", "severity": "major", "status": "open" }],
  "decisions": [{ "what": "...", "authorizedBy": "authorizer" }],
  "unresolvedDependencies": ["..."],
  "knownLimitations": ["..."],
  "nextAction": "single next step",
  "knowledgeReferences": ["..."],
  "supersedes": "previous-checkpoint-id-or-null",
  "publishedAt": "iso"
}
```

- `evidence[].ref` is `command`, `link`, or `file`; a `file` reference always
  carries the content `sha256`. Output is never pasted into the checkpoint.
- `head.dirtyPaths` holds relative in-repository paths; `dirty` is exactly
  `dirtyPaths.length > 0`.
- A reader rejects any `schemaVersion` it does not support and any unknown
  key, so a newer or damaged document fails loudly instead of reading as a
  partial state.

## Storage rules

- Writes are atomic: a unique temp file in the same directory, fsync, then
  rename, so readers never see a partial checkpoint. A crash between the
  checkpoint rename and the index rename loses the update, never the store:
  the reader rebuilds the index by scanning published files.
- Publishing uses exclusive create on the sequence name. A concurrent
  publisher loses with a typed error and retries with a fresh read; an
  existing checkpoint is never overwritten.
- Published checkpoints are immutable. The only changes are new checkpoints
  (`supersedes` points at the previous one) and retention pruning.
- Retention keeps the latest checkpoint plus the most recent ones under an
  explicit cap, pruning the oldest superseded files after each publish and
  on demand. The latest checkpoint and any checkpoint a handoff cites are
  never pruned.

## Resume validation

Resuming from a checkpoint is an assessment, never a trust decision:

- Missing, corrupt, hash-mismatched, or unsupported-version checkpoint:
  resume proceeds without it, from the task statement and live state.
- Live HEAD differs from the recorded one: the evidence recorded in the
  checkpoint no longer binds to the head; the per-gate invalidation rules of
  this skill apply, and verification always runs again on the live head.
- Dirty working tree: the dirty paths are reported and handled explicitly
  before work continues.
- Under every outcome, no checkpoint can validate a passed gate. A gate is
  passed only by its own evidence under the lifecycle rules.

The reference implementation lives in the repository's
`scripts/skills/checkpoint-store.ts` and is what the repository's own
validation tests exercise.

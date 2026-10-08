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
.task-delivery/<task>/checkpoints/<seq>.json          published, immutable
.task-delivery/<task>/checkpoints/index.json          latest-valid pointer
.task-delivery/<task>/checkpoints/.tmp-<uuid>         in flight, ignored
```

`<task>` is the task identifier, or the branch name when there is no task
identifier - the same rule as the handoff packet. `<seq>` is a six-digit,
1-based sequence. The file name is the sequence alone, so the
exclusive-create reservation is per sequence whatever the gate; the gate
lives in the document and in the index.

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
- Timestamps are strict ISO-8601 UTC (`...T...Z`); a reader rejects any
  `schemaVersion` it does not support and any unknown key, so a newer or
  damaged document fails loudly instead of reading as a partial state.

## Storage rules

- A publisher validates the document with its own reader before writing it,
  so a checkpoint the reader would reject is refused at publish time, not
  discovered as "corrupt" at resume.
- Writes are atomic: a unique temp file in the same directory, fsync, atomic
  rename, then a directory fsync, so readers never see a partial checkpoint
  and the rename survives a crash.
- Publishing reserves the sequence with an exclusive create. A concurrent
  publisher loses the reservation, re-reads, and retries; losing can stall
  a sequence but never fork it. A colliding file that does not validate as
  a checkpoint is a crashed or corrupt artifact once it is older than a
  short grace period (a younger file may be a live publisher's in-flight
  reservation and is never deleted); it is removed on the retry path under
  that age rule, as is a zero-byte file left by a crash between the
  reservation and the rename, which the next publish sweeps first.
- Readers cross-check the index against a scan of published files. A crash
  between the checkpoint rename and the index rename leaves a stale-but-valid
  index; the scan reveals the newer checkpoint, so the crash loses the
  update, never the store. An index that does not parse falls back to the
  same scan; an indexed checkpoint file that fails the recorded hash is a
  tamper signal and stops the reader. The index is always made durable
  before retention pruning runs, so no index ever references a pruned file.
- Publishing may still lose the reservation race on every internal attempt
  under heavy contention (a live competitor's reservation is never
  deleted). The failure is the typed `CheckpointExistsError`: retry the
  publish call.
- Published checkpoints are immutable. The only changes are new checkpoints
  (`supersedes` points at the previous one) and retention pruning.
- Retention runs after each publish and on demand; its failure never fails
  the publish. It keeps the latest checkpoint plus the most recent ones
  under an explicit cap, pruning the oldest superseded files. The latest
  checkpoint, any checkpoint a handoff cites, and anything that does not
  validate (not a checkpoint) are never pruned.

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

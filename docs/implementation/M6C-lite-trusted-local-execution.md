# M6C-lite trusted local controlled execution

## Scope and threat model

M6C-lite enables approved local filesystem mutations while preserving the M6B
authorization and sandbox boundary. AI Office is currently a local, single-user
application operating in the same trust domain as its user.

The implementation protects agents from accidental or unauthorized access,
path escape, sensitive paths, stale simulations, stale capabilities, replay,
and mutations without an explicit approval. It does **not** claim protection
against a hostile local process with the same Unix credentials and concurrent
rename/unlink authority in the same directory.

Accepted residual risks are:

- portable path-based TOCTOU between final validation and Node/Bun mutation;
- same-user hostile concurrent filesystem writers;
- the crash gap between the committed SQLite execution lease, filesystem
  mutation, and SQLite completion transaction.

The hardened native design, approval authentication options, and audit-chain
research remain in the M6C assessment, ADRs, and native spike. They are deferred
to M10 and are not linked into production packages by M6C-lite.

## Approval model

`ActionApproval` is separate from M5 governance reviews and from
`ActionRequest`. It binds exactly:

- project and action request;
- authorization payload hash;
- simulation and artifact hash;
- trusted connector ID and version;
- operation;
- decision timestamp and actor audit identity.

The lifecycle is `pending -> approved | rejected`. Binding fields and decided
approvals are immutable at both domain and SQLite boundaries. A rejected action
becomes terminal. The `actor` value is an audit identity supplied by the local
operator; it is not a cryptographically authenticated human identity. Strong
authentication and user presence are M10 scope.

Every filesystem v2 mutation requires an approval:

| Operation | Risk | Simulation | Real execution |
| --- | --- | --- | --- |
| `filesystem.create` | medium | required | approval required |
| `filesystem.write` | medium | required | approval required |
| `filesystem.move` | medium | required | approval required |
| `filesystem.delete` | high | required | approval required |

Filesystem v1 history remains readable but is never executable. A real mutation
must be requested and simulated under the trusted v2 descriptor.

## Execution lease and replay prevention

`action_executions` is a separate one-shot ledger. A composite project/action
foreign key and `UNIQUE(project_id, action_request_id)` enforce at most one
attempt. There is no lease timeout, reacquisition, or automatic retry.

The short `BEGIN IMMEDIATE` lease transaction reloads the action, simulation,
approval, resource, agent, role, and grants; reruns policy at the current clock;
checks descriptor, decision, risk, grant IDs, effective constraints, action
payload hash, and artifact hash; inserts the execution row; compare-and-swaps
the action to `executing`; and appends sanitized audit metadata. Filesystem I/O
runs only after commit and never holds the SQLite transaction open.

The execution lifecycle is:

```text
approval_pending -> executing -> completed | failed | execution_unknown
```

`failed` means the connector attests that no target mutation committed.
`execution_unknown` means a namespace mutation may have happened or durability
is ambiguous. Both are terminal, as is `completed`.

## Pragmatic filesystem commits

The executor repeats M6B effective-path, containment, sensitive-path, symlink,
hard-link, regular-file, UTF-8, size, source hash, and destination absence
checks immediately before committing.

- Create writes and fsyncs an exclusive unpredictable sibling staging file,
  then uses a no-overwrite hard-link commit and removes the reserved staging
  name. Newly created files use an explicit `0600` mode; ACLs, ownership, and
  extended attributes are not synthesized or preserved. This avoids Node's
  overwriting `rename` behavior for create.
- Write writes and fsyncs a sibling staging file, revalidates the source hash,
  applies the verified source's ordinary permission bits (`mode & 0777`) to the
  staging file, and atomically renames it over the target. Setuid, setgid,
  sticky bits, ACLs, ownership, and extended attributes are not preserved.
- Move revalidates source hash and destination absence, then renames without a
  copy/delete fallback. `EXDEV` is a definite pre-mutation failure.
- Delete revalidates source hash and unlinks the regular file directly. M6C-lite
  does not introduce a durable tombstone journal.

Parent directories are fsynced where the supported POSIX API permits. The
reserved `.ai-office-txn-*` namespace is denied to normal read, listing,
search, simulation, and requested mutation operands.

Node/Bun path APIs cannot eliminate a final same-user rename race for write,
move, and delete. This is an explicit deployment constraint, not a kernel
sandbox guarantee.

## Crash semantics

The unavoidable sequence is:

```text
DB execution lease commit
filesystem mutation
DB outcome commit
```

A process crash after the first commit never causes automatic execution retry.
If the process observes a post-commit error it records `execution_unknown`.
If it crashes before outcome persistence, the action and ledger remain
`executing` for later observation and future M6D-lite recovery tooling.
If the normal outcome transaction fails while the process remains alive after
a successful or potentially committed mutation, a separate best-effort
transaction records `execution_unknown` with `OutcomePersistenceFailed`. If
that fallback also fails, the one-shot ledger remains `executing`; the mutation
is never retried automatically.

## Audit and data handling

M6C-lite reuses `audit_event` and records sanitized approval requested,
approved, rejected, execution started, completed, failed, and unknown events.
Audit and state mutations share the same short SQLite transaction.

Audit and execution projections exclude absolute roots, raw content, complete
diffs, credentials, and raw filesystem errors. Mutation content remains part of
the immutable authorization input inherited from M6B, but `action:show` redacts
it. No audit hash chain, action budget, batch, or simulated identifier model is
introduced.

## CLI flow

`action:request` remains authorization-only and `action:invoke` performs reads
or mutation simulation. Daemon-backed commands add local approval and one-shot
execution:

```text
action:approve --project <id> --action <id> --actor <audit-identity>
action:reject  --project <id> --action <id> --actor <audit-identity>
action:execute --project <id> --action <id>
```

Hashes are never accepted from CLI input. They are always reloaded and
recomputed from SQLite state.

## Deferred to M10 or later

- Rust/openat2 production containment and mount identity binding;
- cryptographic or hardware user-presence approvals;
- hostile-local-process guarantees;
- durable mutation journal and advanced crash reconciliation;
- tamper-evident audit chain and external anchoring;
- native supply-chain hardening and hardened multi-platform execution;
- connector budgets, action batches, and simulated identifiers.

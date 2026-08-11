# M6C.0 native filesystem spike results

> **Roadmap note (M6C-lite):** this spike remains preserved research for M10
> Security hardening. M6C-lite deliberately uses the existing Node/Bun sandbox
> under a trusted-local threat model and does not import or package this native
> boundary in the production connector.

## Status and scope

Date: 2026-08-11

Result: **conditional GO for implementing M6C.4; NO-GO for enabling product
mutation at M6C.0**.

The disposable spike lives at `spikes/m6c-native-filesystem`. It is outside the
Bun workspaces and has no imports or registration in the connector SDK,
filesystem connector, daemon, CLI, application, domain, or storage packages.
Its N-API surface exports only `probeCapabilities()`. Mutation functions are
Rust test fixtures and operate exclusively in temporary directories.

M6C.0 adds no migration, approval table, execution ledger, filesystem version-2
production descriptor, lifecycle transition, or callable production executor.
The production version-1 descriptor remains `supportsExecution=false` for
create, write, move, and delete.

## Environment

| Dimension | Observed value |
| --- | --- |
| Host | macOS Darwin 25.5.0, arm64 |
| Linux runtime | OrbStack container, aarch64 |
| Kernel | `7.0.11-orbstack-00360-gc9bc4d96ac70` |
| Build image | Debian 12 bookworm / glibc (`rust:1.89-bookworm`) |
| Rust | `rustc 1.89.0`, Cargo 1.89.0 |
| Bun bridge image | `oven/bun:1.3.6`, Bun 1.3.6 |
| Ordinary fixture filesystem | overlayfs under `/tmp` |
| Bind-mounted source tree | fuseblk |
| Cross-device fixture | tmpfs under `/dev/shm` |
| Privileged mount fixtures | tmpfs and bind mounts in an isolated container mount namespace |
| Tested architecture | Linux aarch64 only |

The kernel version records the evidence environment; it is not used as the
capability decision. Linux x86_64, musl, older kernels, other filesystems, and
non-container hosts were not tested and are not implied PASS.

## Capability probe

The probe invokes the primitives and checks their behavior rather than parsing
the kernel version. The Bun/N-API run returned:

```json
{
  "platform": "linux",
  "architecture": "aarch64",
  "supported": true,
  "openat2": true,
  "requiredResolveFlags": true,
  "renameat2": true,
  "renameNoreplace": true,
  "statx": true,
  "mountIdentity": "statx_mnt_id_unique",
  "directoryFsync": true,
  "unlinkat": true,
  "closeOnExec": true,
  "noFollow": true,
  "exclusiveCreate": true,
  "failures": []
}
```

### Syscall and flag matrix

| Capability | Method | Result in evidence environment |
| --- | --- | --- |
| `openat2` | direct syscall with `open_how` | PASS |
| `RESOLVE_BENEATH` | normal descendant plus `..`/absolute denial | PASS |
| `RESOLVE_NO_SYMLINKS` | final symlink denial | PASS |
| `RESOLVE_NO_MAGICLINKS` | `/proc/self/fd/<fd>` denial | PASS |
| `RESOLVE_NO_XDEV` | `/proc`, child tmpfs, and child bind mount | PASS |
| bounded `EAGAIN` | injected syscall closure | PASS: exactly two attempts maximum |
| `statx`/`STATX_INO` | descriptor with `AT_EMPTY_PATH` | PASS |
| `STATX_MNT_ID` | requested and evaluated | available, superseded by unique ID |
| `STATX_MNT_ID_UNIQUE` | requested and returned in `stx_mask` | PASS; selected candidate |
| `renameat2` | direct syscall | PASS |
| `RENAME_NOREPLACE` | pre-existing destination | PASS: `EEXIST`, destination untouched |
| cross-device rename | overlayfs to tmpfs | PASS: `EXDEV`, source retained |
| `unlinkat` | parent fd plus basename | PASS |
| file `fsync` | staging `File::sync_all` | PASS |
| directory `fsync` | opened directory fd | PASS on overlayfs/tmpfs fixtures |
| `O_CLOEXEC` | `fcntl(F_GETFD)` | PASS |
| `O_NOFOLLOW` | symlink open | PASS: `ELOOP` |
| `O_CREAT|O_EXCL` | second staging create | PASS: `EEXIST` |
| unknown required resolve flag | intentionally invalid flag | PASS: `EINVAL`, no fallback |

The required production capability set is every row above that is relevant to
an enabled operation. Missing capability means `unsupported`; the probe never
selects a path-based fallback. A minimum kernel version is intentionally not
declared from one environment. M6C.4 must derive its published Linux baseline
from a target matrix while retaining the runtime behavioral probe.

## Root identity findings

The candidate version-2 identity is:

```text
FilesystemRootIdentityV2 {
  deviceMajor
  deviceMinor
  inode
  mountIdentityKind = statx_mnt_id_unique
  mountIdentity
}
```

All wide integer fields must be canonically represented without JavaScript
precision loss. Simulation obtains the identity from the held root descriptor,
stores it in the canonical version-2 artifact, and includes it in the artifact
hash. Approval binds the artifact hash. Execution opens the configured root,
obtains the same fields from the fd, and exact-compares before any mutation.

Observed tests:

- reopening the same root matched;
- renaming the registered directory away and replacing the pathname with a
  different directory produced a mismatch;
- replacement still mismatched when both roots contained identical target-file
  bytes;
- privileged unmount/remount of tmpfs produced a stale identity;
- child tmpfs and bind-mount traversal failed with `EXDEV` under
  `RESOLVE_NO_XDEV`.

This separates two controls: root identity detects replacement of the root
pathname itself; `RESOLVE_NO_XDEV` rejects mount crossings below the accepted
root fd. Reboot or remount may legitimately invalidate outstanding simulations.
The absolute root is not part of public output or audit.

## Independent path boundary

The Rust validator, independently of TypeScript, rejects:

- empty and absolute paths;
- NUL and backslash;
- `.` and `..` components;
- empty/repeated/trailing components;
- paths over the byte limit or segment limit;
- any component in the reserved `.ai-office-txn-*` namespace, case-insensitively;
- an empty, dot, or reserved final basename.

Public operands are split into a verified relative parent and one basename. The
helper opens the parent through `openat2(rootFd, parent, ...)`, holds the parent
fd, and uses `renameat2`/`unlinkat` with that fd and basename. Root, parent,
source, staging, and tombstone descriptors are close-on-exec and owned by Rust
RAII values. Error branches close them automatically. Internal cleanup first
matches reserved name, execution ID, random identity, device, and inode; uncertain
ownership returns an error and leaves the entry untouched.

## Primitive mutation findings

All mutation fixtures used temporary directories only.

### Create

Demonstrated exclusive reserved staging creation, exact-byte write, staging
fsync, SHA-256 re-read, `RENAME_NOREPLACE`, and parent fsync. When a racing file
appeared before commit, rename returned `EEXIST`; the racing destination remained
unchanged and the owned staging entry was removed only after identity proof.

### Write

Demonstrated source regular-file/single-link inspection, expected content hash
and inode revalidation, same-directory staging, staging fsync/hash, atomic
replacement rename, and parent fsync.

This does **not** solve conditional replacement against a hostile concurrent
writer. There remains a window between final target revalidation and rename in
which another process with same-directory rename/unlink authority can exchange
the name. Production support therefore requires daemon-exclusive namespace
mutation authority; kernel containment alone is not advertised as solving this
race.

### Move

Demonstrated exact source identity/content, verified held source/destination
parents, destination absence, same-device check, `RENAME_NOREPLACE`, and parent
fsync. An overlayfs-to-tmpfs attempt returned `EXDEV`; no destination appeared,
the source remained, and no copy/delete fallback ran.

The source-name conditional race has the same daemon-exclusive namespace
contract as write.

### Delete

Demonstrated exact source verification, no-replace rename to
`.ai-office-txn-<execution-id>-<random>`, parent fsync, tombstone device/inode
verification, `unlinkat(parentFd, basename)`, and final parent fsync.

Collision and hostile cases covered pre-created reserved names, wrong execution
identity, wrong random/name binding, inode substitution, and cleanup with
unproven ownership. Every uncertain case left the entry untouched. The literal
production namespace format remains versioned design work; ordinary connector
surfaces must deny the complete prefix recursively.

### Hard links and special files

The authoritative opened descriptor check rejected a regular file after its
link count became greater than one. FIFO replacement was opened with
`O_NONBLOCK`, classified non-regular, and rejected without blocking. Symlinks
were rejected through no-follow/resolve policy. Device/socket tests should be
added to the production target matrix where fixture creation is safely
available; no PASS is claimed for those fixture types by this run.

## Committing points and crash classification

The spike returns a future-helper-compatible certainty classification:

| Operation | Before committing rename | After committing rename, before/during parent fsync | After all required fsyncs and normal return |
| --- | --- | --- | --- |
| create | `definite_no_mutation` | `mutation_may_have_occurred` | `definite_success` |
| write | `definite_no_mutation` | `mutation_may_have_occurred` | `definite_success` |
| move | `definite_no_mutation` | `mutation_may_have_occurred` | `definite_success` |
| delete | `definite_no_mutation` before target-to-tombstone rename | `mutation_may_have_occurred` from tombstone rename through tombstone unlink and final fsync | `definite_success` |

Owned staging may remain after a pre-rename process crash, but the target
namespace is unchanged; this still maps to future `failed`, with conservative
owned-entry handling. Any error after a namespace rename can no longer attest
that no target mutation occurred and maps to `execution_unknown`, including an
error after an fsync where success cannot be durably reported to the application.
Only a normal return after all required directory fsyncs maps to `completed`.

Fault injection covered before rename, after rename, before parent fsync, after
parent fsync, before tombstone unlink, and after tombstone unlink. No SQLite was
used; the unavoidable database-lease/filesystem/completion crash gap remains as
documented in the M6C assessment.

## N-API and Bun feasibility

The spike uses napi-rs 3 with N-API 8 and a Rust `cdylib`. A multi-stage Docker
build produced a Linux aarch64 `.node` artifact and copied it into the pinned
Bun 1.3.6 image. Bun loaded the module and received a typed JavaScript object
from Rust via `probeCapabilities()`.

Feasibility result: **PASS on Linux aarch64/glibc**.

Packaging consequences:

- build and sign one native artifact per supported architecture/libc target;
- verify N-API loading and behavioral probe on every published target;
- propagate typed/redacted native errors, never raw absolute paths;
- keep mutation entrypoints unavailable until M6C.4 production integration;
- retain a subprocess helper only as a reviewed alternative if N-API lifecycle
  or packaging later fails. The spike found no reason to switch automatically.

macOS host loading was not attempted because the production execution decision
is Linux-only. Linux x86_64 and musl packaging remain unverified.

## Automated evidence

Unprivileged Linux suite:

```text
7 Rust unit tests passed
14 Rust security/integration tests passed
1 privileged mount test explicitly ignored in this invocation
```

Privileged isolated mount invocation:

```text
1 privileged mount/remount/bind-mount test passed
```

Together, 22 tests executed and passed across the two invocations. The ignored
line in the ordinary run is not counted as a pass; the separate privileged run
is the evidence for that case.

## Unsupported and residual risks

- only Linux aarch64/glibc and the recorded kernel/filesystems were exercised;
- write/move cannot be made conditional against an out-of-contract hostile
  same-directory namespace writer with the tested primitives;
- SQLite and filesystem commits are not atomic; `execution_unknown` and M6D
  reconciliation remain necessary;
- crash cleanup and tombstone retention are not implemented;
- the helper prototype hashes whole test files in memory and does not define
  production streaming limits;
- metadata/ACL/xattr preservation is unresolved and outside M6C.0;
- device/socket fixtures, power-loss durability, real ext4/xfs/btrfs matrices,
  x86_64, musl, packaging signatures, and native artifact supply-chain controls
  require later qualification;
- approver key lifecycle from ADR-0003 remains unimplemented;
- no production audit, budget, batch, approval, or execution storage exists.

## Recommendation

**GO for M6C.4 implementation work** on a Linux Rust/N-API boundary, provided it
retains the exact capability probe, statx unique-root binding, complete
`openat2` policy, parent-dirfd/basename commits, no-fallback behavior,
daemon-exclusive namespace contract, certainty classification, and all
application/storage gates defined by the M6C assessment.

**NO-GO for production mutation enablement at the end of M6C.0.** The current
filesystem connector remains version 1 and simulation-only. Do not expose a
native mutation entrypoint until M6C.1–M6C.4 supply authenticated approval,
version-2 artifact binding, one-shot lease/ledger, lifecycle, persistence,
audit, and controlled application orchestration.

# ADR-0004: Use a Linux native boundary for controlled filesystem mutation

- Status: Deferred to M10
- Date: 2026-08-11

## Context

M6B performs real reads but only simulates filesystem mutations. M6C needs to
execute an approved create, write, move, or delete without allowing traversal,
symlink/magic-link escape, child mount crossing, hard links, special files, or
destination replacement. Portable Node/Bun path APIs cannot keep resolution and
namespace mutation attached to verified directory descriptors.

M6C also binds approval to the exact filesystem root simulated. Opening the same
canonical pathname later is insufficient because the root itself can be
renamed, replaced, bind-mounted, unmounted, or remounted.

The disposable spike in `spikes/m6c-native-filesystem` exercised direct Linux
syscalls on Linux aarch64 kernel `7.0.11-orbstack-00360-gc9bc4d96ac70`, Debian
12/glibc, overlayfs fixtures, tmpfs cross-device fixtures, and privileged tmpfs/
bind-mount fixtures. It also loaded a Rust N-API module from Bun 1.3.6. The
detailed evidence is in `docs/implementation/M6C-native-filesystem-spike.md`.

## Spike findings

- `openat2` accepted the complete required policy:
  `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV`.
- traversal, absolute paths, symlinks, magic links, `/proc` crossing, child
  tmpfs, and child bind mounts failed closed.
- `statx` returned `STATX_INO` and `STATX_MNT_ID_UNIQUE`; root reopen matched,
  while pathname replacement, byte-identical directory replacement, and
  unmount/remount produced a different identity.
- `renameat2(RENAME_NOREPLACE)` preserved an existing destination during a
  race, and cross-device rename returned `EXDEV` without copy/delete fallback.
- parent directory `fsync`, `unlinkat`, `O_CLOEXEC`, `O_NOFOLLOW`, and exclusive
  staging create behaved as required on the tested filesystems.
- the parent-dirfd/basename create, write, move, and tombstone-delete fixtures
  passed; fault injection distinguished pre-rename no-target-mutation failures
  from post-rename ambiguity.
- Bun loaded the Linux aarch64 N-API artifact and received a structured
  capability result.

The spike does **not** close conditional replacement against a hostile process
with concurrent rename/unlink authority in the same directory. `renameat2`
does not compare the replaced destination with an expected inode. SQLite and
filesystem durability also remain separate commit domains.

## Decision

Initial real controlled filesystem execution is Linux-only and uses a Rust
native boundary. Production M6C.4 may proceed only under all of these rules:

1. Filesystem execution uses a new trusted connector descriptor version 2.
   Version-1 actions and artifacts remain historical and never execute.
2. Every version-2 mutation is newly requested/simulated and requires a valid
   authenticated `ActionApproval`.
3. Version-2 simulation captures a lossless root identity containing device
   major/minor, inode, and `STATX_MNT_ID_UNIQUE`. The canonical artifact/hash
   binds it; execution compares it against `statx` on the held root fd.
4. The helper resolves parents using `openat2` with `RESOLVE_BENEATH`,
   `RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS`, and `RESOLVE_NO_XDEV`, then
   commits using held parent dirfds and validated single basenames.
5. The helper independently rejects absolute/NUL/dot/empty/oversized paths,
   excess segments, invalid basenames, and the reserved AI Office transaction
   namespace. TypeScript normalization is not trusted as a security boundary.
6. Required descriptors use `O_CLOEXEC`; sources and internal entries also use
   no-follow/exclusive semantics appropriate to their role. Every error path
   closes descriptors and removes only provably owned internal entries.
7. `openat2` receives at most one immediate retry after `EAGAIN`; a second
   `EAGAIN` fails closed.
8. Missing or behaviorally incompatible `openat2`, resolve flags, `statx` unique
   mount identity, `renameat2`, `RENAME_NOREPLACE`, `unlinkat`, or directory
   fsync makes mutation execution unsupported. There is no Node/Bun fallback.
9. Runtime support is selected by behavioral capability probe, not a kernel
   version string. The production support matrix needs separate Linux
   architecture/libc/filesystem qualification; only Linux aarch64/glibc on the
   recorded environment is proven by this spike.
10. Deployment grants the daemon exclusive namespace-mutation authority for
    every affected directory. Kernel containment remains mandatory, but M6C
    does not claim conditional replacement safety against an out-of-contract
    same-directory writer.
11. Move is same-filesystem only. `EXDEV` fails closed; there is no copy/delete
    fallback.
12. Delete first renames to a uniquely owned reserved tombstone, fsyncs the
    parent, verifies ownership, unlinks, and fsyncs again. Uncertain ownership
    never permits cleanup.
13. No multi-file atomicity is claimed. A successful namespace syscall followed
    by any error maps to future `execution_unknown` unless the helper can attest
    definite durable success. `failed` is reserved for definite no-target-
    mutation outcomes.

## Production gate

The spike is a **GO for implementing** the Linux native adapter in M6C.4 under
the rules above. It is a **NO-GO for enabling real product mutation now**.
Production execution remains disabled until approval authentication, exact
version-2 artifact binding, execution ledger/lease, lifecycle, persistence,
audit, and application orchestration are implemented and reviewed in later
M6C slices.

If another supported Linux target lacks any required capability or the native
adapter cannot preserve these properties, that target is unsupported rather
than downgraded to a weaker implementation.

## Consequences

- Rust becomes a narrowly scoped security boundary justified by measured
  syscall requirements, without changing the TypeScript-first domain.
- Packaging must publish and verify platform/architecture-specific N-API
  artifacts.
- macOS and other platforms remain simulation-only for filesystem mutation.
- Daemon-exclusive namespace authority becomes a deployment/security contract.
- General restart reconciliation, tombstone retention, and unknown-execution
  recovery remain M6D work.
- This ADR adds no production import or callable mutation entrypoint.

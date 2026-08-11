# M6B connector SDK and filesystem sandbox assessment

## Purpose and scope boundary

M6A established deterministic, deny-by-default authorization for project-scoped
resources. M6B should add the first real connector boundary without weakening
that model. Read-only filesystem operations may access local files only after a
successful capability decision. Mutating operations may inspect current state
and produce a deterministic simulation, but must not create, modify, move,
delete, rename, or temporarily write any real file in this milestone.

M6B includes:

- a common connector contract and immutable registry;
- trusted operation descriptors covering risk, execution mode, simulation,
  reversibility, and approval requirements;
- one `filesystem` provider for `filesystem_scope` resources;
- canonical filesystem-root registration;
- real `filesystem.list`, `filesystem.read`, and `filesystem.search` operations;
- simulated `filesystem.create`, `filesystem.write`, `filesystem.move`, and
  `filesystem.delete` operations;
- typed filesystem constraints, path sandboxing, sensitive-path denial, text and
  size limits, deterministic unified diffs, source hashes, and preconditions;
- an immutable persisted simulation artifact suitable for later approval
  binding;
- a pure atomic-mutation plan and precondition verifier, but no mutation
  executor.

M6B explicitly excludes approval decisions, mutation execution, one-shot or
replay enforcement, action batches, audit hash chaining, GitHub/SQLite/shell
connectors, agent-executor integration, and UI work. Full execution-time
revalidation remains M6C work. M6B must not call an LLM.

## Current architecture and M6A baseline

The implemented design has five relevant layers:

- `packages/domain` owns resources, grants, policy decisions, action requests,
  simulation artifact value types, canonical JSON, and the action state machine;
- `packages/connector-sdk` owns trusted connector/operation contracts and the
  immutable registry without importing filesystem, SQLite, CLI, or daemon code;
- `packages/application` owns capability use cases and repository, clock, ID,
  transaction, agent-runtime, and audit ports;
- `packages/storage-sqlite` implements project-scoped persistence and
  compare-and-swap action transitions;
- the daemon-backed CLI composes adapters and serializes ordinary commands on a
  single-writer queue.

M6A on `main` registered only a policy-only fake provider. M6B replaces its
hard-coded descriptor lookup with an injected registry containing `fake` and
`filesystem`. The domain depends only on a narrow structural policy-registry
port; it does not import the SDK. Resource validation, grant validation, policy
evaluation, action hashing, and invocation all resolve the same frozen trusted
descriptor rather than agent-provided connector metadata.

Migration `0012_capability_policy.sql` intentionally constrains both resources
and action requests to fake connector version 1. Because M6A is now on `main`,
M6B must not edit `0012`. A new `0013_filesystem_connector.sql` must preserve all
M6A data while widening those checks and adding simulation persistence.

The daemon protocol limits command request bodies to 64 KiB and individual
arguments to 16 KiB. Connector result limits must be stricter than or compatible
with the transport rather than relying only on the daemon limit.

## M6A components to reuse

The following M6A components remain authoritative:

- project-scoped `Resource`, `CapabilityGrant`, and `ActionRequest` identities;
- project, agent, role, resource, and grant ownership checks;
- deny-by-default matching, validity windows, expiry, and revocation;
- critical-operation exact-grant behavior and controlled wildcard syntax;
- canonical JSON normalization and SHA-256 action payload hashing;
- immutable decision/status relationship;
- conditional action-state updates;
- `RequestControlledAction` as the authorization and persistence boundary;
- `audit_event`, `RecordAuditEvent`, and sanitized append-only audit payloads;
- daemon request IDs, command queue, payload limits, and stable CLI error
  formatting;
- the short SQLite transaction runner. Filesystem I/O must not occur inside its
  transactions, consistent with ADR-0001.

## Components to generalize

M6B should make these focused changes:

1. Replace the hard-coded descriptor lookup and separate handler map with an
   injected connector registry. The policy engine depends only on the
   policy-facing registry interface; it still remains pure and deterministic.
2. Expand `OperationDescriptor` with explicit `effect`, `simulation`,
   `reversibility`, and `approval` metadata. Policy decisions are derived from
   trusted descriptor fields, with risk retained as a non-reducible floor.
3. Let `RegisterResource` ask the selected connector to prepare and validate its
   resource scope before persistence. The filesystem implementation resolves and
   stores the canonical root; the application service itself never imports
   `node:fs`.
4. Let grant validation and constraint combination route through the same
   registered connector definition used for invocation.
5. Extend the action lifecycle only as required for real read-only operations:
   `authorized -> executing -> completed|failed`. Existing simulation transitions
   remain `authorized -> simulating -> simulated`; an approval-required
   simulation additionally becomes `approval_pending`. No approved-to-executing
   mutation transition is added in M6B.
6. Persist immutable simulation artifacts separately from immutable action
   requests. The original action payload hash remains the authorization hash;
   the simulation artifact receives its own canonical hash over result,
   preconditions, and action ID. M6C can bind approval to both values.

The fake descriptor and constraint evaluator remain registered as a policy-only
fixture so all M6A tests and behavior remain available.

## Existing filesystem code that must not be reused as a sandbox

`apps/cli/src/local-project-scanner.ts` uses ordinary `stat` and recursive path
walking. It is suitable for explicit project onboarding, but it follows paths
without capability authorization, a denylist, no-follow semantics, or bounded
connector output. It must not be called by the filesystem connector.

`apps/cli/src/atomic-file.ts` uses a predictable sibling `.tmp` path and performs
no canonical-root, symlink, source-hash, exclusive-create, permission, fsync, or
precondition checks. It must not be reused for future controlled writes. M6B
will produce an atomic-write plan only; M6C will implement and revalidate it.

The in-memory worktree abstraction is also unrelated to filesystem scope
authorization and must not become an implicit connector grant.

## Proposed connector SDK

A new `packages/connector-sdk` package should contain the common contract and
registry. It may import domain connector/resource types, but it must not import
SQLite, CLI, daemon, or concrete filesystem APIs.

The registry stores immutable connector definitions with:

- one trusted descriptor;
- one connector-specific constraint evaluator;
- one resource-registration preparer;
- an optional operation handler. The fake connector has no handler; filesystem
  has a handler.

Construction rejects duplicate provider IDs, duplicate operation IDs, empty or
inconsistent versions, a constraint handler whose connector ID differs from the
descriptor, and handlers advertising operations absent from the descriptor.
Connector callbacks are formally context-free: their TypeScript signatures use
`this: void`, built-ins are stateless functions, and implementations must not
close over caller-mutable state. The registry captures each function slot and
invokes it explicitly with an `undefined` receiver; it never binds a callback to
the original definition or constraint-handler object. It freezes the trusted
descriptor/adapter and every policy definition returned to the domain engine.
Replacing a method slot or mutating receiver properties after construction
therefore cannot affect registered policy, preparation, or invocation behavior.
Stateful plugins are not an M6B-supported API; a future stateful contract would
need an explicit immutable state snapshot rather than receiver binding. Unknown
providers and operations produce typed errors.

The application maps a domain `Resource` to a read-only connector scope. A
connector never receives repositories, grants, credential references, audit
writers, project objects, or database handles. Its invocation contains only:

- resource ID, provider, type, canonical external reference, and sanitized
  configuration;
- operation ID and normalized typed arguments;
- effective constraints already produced by policy;
- an output budget and optional abort signal.

The connector returns either a read result or a simulation result. It cannot
transition or persist an action itself.

## Trusted operation model

Recommended descriptor metadata and filesystem operations:

| Operation           | Effect   | Risk   | Simulation | Reversibility  | Approval    |
| ------------------- | -------- | ------ | ---------- | -------------- | ----------- |
| `filesystem.list`   | read     | low    | none       | not applicable | none        |
| `filesystem.read`   | read     | low    | none       | not applicable | none        |
| `filesystem.search` | read     | low    | none       | not applicable | none        |
| `filesystem.create` | mutation | medium | required   | reversible     | none in M6B |
| `filesystem.write`  | mutation | medium | required   | conditional    | none in M6B |
| `filesystem.move`   | mutation | medium | required   | conditional    | none in M6B |
| `filesystem.delete` | mutation | high   | required   | irreversible   | required    |

The descriptor ID is `filesystem` and the initial connector version is `1`.
The canonical action payload always receives both values from that descriptor.
No argument or CLI option can set or override connector version, risk, effect,
simulation, reversibility, or approval metadata.

Recommended typed argument/result shapes:

- `filesystem.list`: `{ path?: string; recursive?: boolean }`; returns sorted
  entries with canonical relative path, kind, and size. Directories may be
  listed; symlinks and sensitive entries are omitted.
- `filesystem.read`: `{ path: string }`; returns UTF-8 content, byte size, and
  SHA-256 source hash for one regular text file.
- `filesystem.search`: `{ path?: string; query: string; caseSensitive?: boolean }`;
  performs literal text search only and returns matches sorted by path, line,
  and column. Regex is excluded to avoid ReDoS and cross-runtime ambiguity.
- `filesystem.create`: `{ path: string; content: string }`; requires an existing
  non-symlink parent and an absent destination.
- `filesystem.write`: `{ path: string; content: string }`; targets one existing
  regular text file.
- `filesystem.move`: `{ sourcePath: string; destinationPath: string }`; targets
  one existing regular file and an absent destination under an existing parent.
- `filesystem.delete`: `{ path: string }`; targets one existing regular file.

Directory creation, recursive directory move/delete, metadata changes,
permissions, ownership, hard-link creation, sparse files, devices, FIFOs, and
socket files are excluded. This keeps simulations exact and makes the future
atomic executor tractable.

All argument validation occurs at runtime before policy matching. Unknown keys,
prototype-sensitive keys, empty strings, unsupported flags, and non-canonical
values are rejected rather than ignored.

## Filesystem resource scope

A filesystem resource uses:

- `type = filesystem_scope`;
- `provider = filesystem`;
- `externalRef = <canonical absolute root>`;
- sanitized configuration containing only optional restrictive limits and extra
  denied relative-path prefixes.

At registration the filesystem adapter requires an absolute existing directory,
rejects a symlink at the supplied root, resolves it with `realpath`, verifies
device/inode identity and directory type, and stores only that canonical path as
the immutable external reference. Canonical roots are internal resource data and
stay out of CLI list/invocation output and audit payloads.

Resource configuration may reduce, never increase, built-in ceilings. It uses
the same typed fields as filesystem grants: allowed/denied path prefixes,
allowed extensions, file/output/result/visited/depth/path/diff/inline maxima,
and `allowMutation`. Unknown fields or unsafe values fail registration. The
built-in sensitive denylist cannot be disabled through configuration or grants.

## Filesystem capability constraints

The filesystem constraint handler should accept:

```ts
interface FilesystemConstraints {
  allowedPathPrefixes?: readonly string[];
  deniedPathPrefixes?: readonly string[];
  allowedExtensions?: readonly string[];
  maxFileBytes?: number;
  maxOutputBytes?: number;
  maxResults?: number;
  maxVisitedEntries?: number;
  maxVisitedFiles?: number;
  maxVisitedDirectories?: number;
  maxDepth?: number;
  maxPathBytes?: number;
  maxPathSegments?: number;
  maxDiffBytes?: number;
  maxInlineContentBytes?: number;
  allowMutation?: boolean;
}
```

Paths are canonical relative prefixes, not arbitrary globs or regular
expressions. Combination is restrictive:

- allowed prefixes: intersection by containment, retaining the narrower prefix;
- denied prefixes: deterministic union;
- numeric maxima: minimum across resource configuration and matching grants;
- `allowMutation`: logical AND, with absence false for mutation operations;
- empty or non-overlapping allowed sets: deny;
- unknown, invalid, or non-combinable fields: deny.

Built-in hard ceilings remain in force even when all grants omit maxima. The
implemented ceilings are 1 MiB per source file, 48 KiB canonical output, 1,000
results, 10,000 visited directory entries, 5,000 visited files, 1,000 visited
directories, depth 8, 1,024 UTF-8 path bytes, 128 path segments, 48 KiB complete
diff, and 16 KiB inline mutation content. Resource and grant values may only
lower them. After combination, policy revalidates every requested path against
the effective `maxPathBytes` and `maxPathSegments`; both move endpoints are
checked, while the empty list/search root remains valid. The sandbox repeats the
same validation before any operation or precondition filesystem access, so a
direct connector invocation cannot bypass policy-level limits. List and search
may return deterministic
`truncated: true`; read and mutation simulation fail rather than return partial
content or a partial diff.

## Path and symlink strategy

Every operation accepts portable relative paths only. The sandbox rejects:

- POSIX absolute paths, Windows drive paths, and UNC paths;
- NUL bytes, backslashes, empty segments, `.` or `..` segments, and repeated
  separators;
- paths whose native `resolve`/`relative` containment check leaves the canonical
  root;
- non-regular final targets for file operations;
- any symbolic-link component, including the final component.

Denying all symlink traversal is intentionally stricter than merely allowing
symlinks whose current target is inside the root. It removes ambiguous
retargeting behavior and guarantees static symlink escape tests fail closed.
List and search never follow symlinks and omit them from output; direct access
through one returns a typed sandbox error.

For existing paths, the sandbox walks components with `lstat`, performs a final
`realpath` containment check, and opens regular files read-only with no-follow
and non-blocking flags where the platform provides them. `fstat` rejects FIFO,
device, directory, hard-link, and inode/device substitution without waiting for
a writer. For a non-existing create/move
destination it validates every existing ancestor, requires the immediate parent
to exist, and requires the destination to remain absent.

M6B enables these guarantees on the verified Linux and macOS targets. Other
platforms, including Windows junction/reparse-point environments and unverified
POSIX variants, fail closed with a typed unsupported-platform error. Before
opening a file the implementation walks every component with `lstat`, verifies
the final `realpath`, opens with `O_NOFOLLOW`, and compares the descriptor's
`fstat` device/inode to the inspected object. It then re-walks and rechecks the
path both before consuming bytes and after the bounded read; the hard-link check
uses the opened descriptor's `nlink`. Directory enumeration similarly rechecks
the directory device/inode after bounded `opendir` iteration, and every discovered
entry is fully
revalidated before it is returned or opened. Deterministic adversarial hooks
exercise file replacement, intermediate-directory replacement, directory escape,
symlink retargeting, hard-link insertion, and device/inode mismatch.

Node/Bun do not expose a portable descriptor-relative `openat` walk or
descriptor-based recursive `readdir`, so an irreducible path-race window remains.
Exploitation requires a local actor able to rename or rewrite entries within the
registered root concurrently with the daemon. For read/search, an opened file is
never consumed unless its descriptor still matches the inspected path and the
path remains contained before and after the read. A same-inode, same-size in-place
rewrite with restored metadata remains theoretically possible; the result hash
still describes the exact bytes returned, and that actor already controls the
authorized file. For list, a sufficiently precise repeated directory swap could
at worst disclose relative entry metadata from an external directory during the
remaining API window; content is not opened through the listing path. This is an
accepted M6B limitation on the supported POSIX hosts, not a claim of a kernel-
enforced sandbox. M6C must additionally revalidate every approved mutation
precondition immediately before execution.

Every regular file with `nlink > 1` is rejected before read, search, or mutation
simulation. List omits such entries. This deliberately fail-closed rule prevents
an internal hard-link name from exposing an inode also reachable outside the
registered root. M6B neither creates nor accepts hard links.

Allowed prefixes use three explicit classifications: `inside_allowed`,
`ancestor_of_allowed`, and `denied`. A regular file must always be
`inside_allowed`; only a directory may be traversed while it is an
`ancestor_of_allowed`. Discovered entries are inspected before applying the
type-dependent decision, preventing an ancestor directory replaced by a file
from inheriting traversal permission.

Directory traversal uses `opendirSync`/`Dir.readSync` rather than materializing
an unbounded directory. Every dirent consumes the global entry budget before
denylist, extension, or type filtering. A directory is processed only if all
names read within the remaining budget fit; exhaustion returns a conservative
deterministic `truncated` result and discards that directory's partial set. Names
from a bounded directory are sorted before processing. The work queue is bounded
by 10,000 inspected entries and 1,000 opened directories; search retains at most
5,000 file paths. With the 1,024-byte path ceiling, raw retained path/name data is
bounded to approximately 10 MiB plus JavaScript object/string overhead, alongside
the separate 1 MiB file and 48 KiB result/diff limits. `AbortSignal` is checked
before traversal, between entries and files, before open, during read loops, and
during diff construction; abort uses a redacted connector-specific error.

## Sensitive-path denylist

The denylist is connector-owned, immutable for a descriptor version, recursive,
and compared case-insensitively to fail safely on case-insensitive filesystems.
Every path component is evaluated: a sensitive directory name, `.env`/`.env.*`
name, credential basename, or private-key extension makes its complete subtree
unavailable. The two-segment `.config/gcloud` rule likewise covers every
descendant. Resource registration applies these built-in rules to every segment
of the canonical absolute root and rejects a sensitive root with the same
redacted connector error. Capability `deniedPathPrefixes` remain relative to the
registered root and are deliberately not interpreted against that absolute root.
It should at least deny:

- `.ai-office/**`, including the project database and daemon socket;
- `.git/**`, `.ssh/**`, `.aws/**`, `.kube/**`, and `.config/gcloud/**`;
- `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
  `git-credentials`, and common `credentials`/`secrets` files;
- private-key and certificate-secret extensions such as `.key`, `.pem`, and
  `.p12`.

Callers may add denied prefixes but cannot remove built-ins. Direct read or
simulation returns a typed denial without including file content. List and
search omit denied entries so an agent cannot use them as an enumeration side
channel. Audit records only action/resource IDs, operation, counts, byte sizes,
and hashes; it never records roots, query results, content, or unified diffs.

## Text, binary, and output handling

The connector checks `lstat` size before opening, reads at most the effective
limit plus one byte, and verifies size again. Binary content is rejected when it
contains NUL bytes or cannot be decoded by a fatal UTF-8 decoder. Files changed
during a read fail with a typed concurrent-source-change error rather than
returning a mixed result.

Source hashes are lower-case SHA-256 over exact raw bytes. UTF-8 decoding does
not normalize Unicode or line endings. Output budgets are measured over the
canonical serialized structured result, not only the content string.

Search walks directories in sorted order, never follows symlinks, applies the
denylist before opening entries, and accounts for every returned preview against
the output budget. Error messages must not disclose sensitive content or an
outside-root canonical target.

## Unified diff and simulation artifacts

Unified diff generation is a pure deterministic component. The implemented M6B
strategy emits one bounded whole-file replacement hunk rather than computing a
minimal edit script. This avoids quadratic work and external commands while
remaining valid, stable unified-diff text. Output uses LF separators, stable
`a/<path>` and `b/<path>` labels, no timestamps, and standard no-newline markers.
CRLF is normalized only for diff presentation; source hashes always cover the
original bytes.

- create: `/dev/null` to `b/<path>`;
- write: `a/<path>` to `b/<path>`;
- delete: `a/<path>` to `/dev/null`;
- move: deterministic deletion of the source followed by deterministic creation
  of the destination.

Diff generation never truncates. If a complete diff exceeds the effective
output budget or the bounded algorithm work limit, simulation fails. The
connector must not invoke `git diff` or another subprocess.

Each simulation returns canonical preconditions:

- create: destination expected absent;
- write/delete: source expected regular file with exact SHA-256 and byte size;
- move: source expected regular file with exact SHA-256/size and destination
  expected absent;
- connector version is bound in the artifact hash; parent existence and
  no-symlink status are validated during simulation and will be revalidated by
  M6C before execution.

Precondition identity is the normalized path alone. Duplicate `file`, duplicate
`absent`, or mixed `file`/`absent` entries for the same path are contradictory
and rejected by both the domain normalizer and the SQLite insert trigger.

The persisted immutable artifact contains its project/action identity,
authorization payload hash, connector/version, operation, canonical
preconditions, complete diff and hashes, and timestamp. Its artifact SHA-256 is
computed from canonical JSON and binds the action ID, authorization hash,
connector ID/version, operation, preconditions, and diff hash. It contains no
credential reference. The implemented read-only precondition verifier reports
stale state but performs no mutation.

## Atomic-write design, without execution

M6B defines a pure `AtomicMutationPlan` only. The future M6C executor must:

1. revalidate project/resource state, grants, approval, action and simulation
   hashes, canonical root, denylist, and all source preconditions;
2. re-walk path components with no-follow semantics;
3. for create/write, create a random sibling temporary file with exclusive
   creation, restrictive permissions, and no-follow flags;
4. write the exact approved bytes, fsync the file, revalidate source/destination,
   rename atomically inside the same directory/filesystem, then fsync the parent;
5. for move, require same-filesystem rename and revalidate source/destination;
6. define a recoverable tombstone/rename strategy before implementing delete;
7. clean up only the uniquely owned temporary file on failure.

No part of that sequence, including temporary-file creation, is implemented or
called by M6B.

## Application orchestration and lifecycle

A small `InvokeControlledConnectorAction` service implements:

1. call the existing `RequestControlledAction` service;
2. return immediately for deny;
3. resolve the same connector definition/version used by the action payload;
4. for read operations, transition to `executing`, perform bounded connector I/O
   outside a SQLite transaction, then atomically record `completed` or `failed`
   with sanitized audit;
5. for mutations, transition to `simulating`, perform read-only simulation
   outside a SQLite transaction, atomically persist the artifact and transition
   to `simulated`, then move approval-required actions to `approval_pending`;
6. never call a mutation executor.

The existing CAS repository remains the only status-update path. New DB triggers
must permit read-only `authorized -> executing -> completed|failed` while
preserving decision/status invariants and terminal states. M6B does not add
`approved -> executing`.

`action:invoke` can either request and invoke atomically at the application level
or invoke a previously authorized action by ID. Immediately before connector I/O,
inside the same `BEGIN IMMEDIATE` transaction that acquires the lifecycle lease,
the service reloads the action and resource, requires status `authorized`, resolves
the descriptor from the current registry, checks connector ID/version, provider,
resource type and ownership, and reruns the deterministic policy with the current
clock and grants. The recomputed decision, risk, matched grant IDs, effective
constraints, and canonical payload hash must exactly match the stored
authorization. Revocation, expiry, resource disablement, connector removal, or a
more permissive/different current constraint set therefore fails closed before
opening a file or creating a simulation. The transaction then performs the CAS
`authorized -> executing|simulating` and appends its audit event. Revocation or
disablement committed before this CAS prevents lease acquisition. Once the CAS
commits, the in-flight read or simulation owns an authorization lease; a later
revocation applies to future actions and does not cancel work already in flight.
A successfully invoked action is no longer `authorized`, so a second invocation
is rejected. A stale authorization
remains stored as `authorized` because M6B introduces no `authorized -> expired`
transition; it is nevertheless not irrevocable and every retry repeats the same
checks.

M6B does not hold a SQLite transaction over filesystem I/O. State transitions use
compare-and-swap, while artifact insertion, the `simulating -> simulated`
transition, and their audit event share one transaction. Any simulation error is
recorded through `simulating -> failed`. If artifact persistence or the subsequent
transition/audit fails, the artifact transaction rolls back and the service makes
a second transactional attempt to mark the action failed. That recovery attempt
is intentionally not described as infallible: a second CAS or audit failure can
leave the observable action in `simulating`, but never leaves an artifact. General
recovery of that state is M6D scope; errors and audit remain metadata-only and
redacted.

## Persistence and migration strategy

`migrations/project/0013_filesystem_connector.sql` is added without editing prior
migrations. SQLite cannot relax the provider/version `CHECK` clauses in place,
so `0013` rebuilds the three related tables inside the migration runner's
per-file transaction:

1. create widened replacement `resources`, `capability_grants`, and
   `action_requests` tables with all existing ownership, JSON, immutability, and
   transition constraints;
2. copy all M6A rows without changing IDs, timestamps, hashes, or decisions;
3. explicitly drop the four `agent`/`role` triggers that reference
   `capability_grants`, then drop old child tables before the old resource table;
4. rename replacements in parent-before-child order;
5. recreate every index and trigger, including the four external M6A grant
   guards with their exact prior semantics, adding connector/resource matching
   and M6B lifecycle rules;
6. create immutable project-scoped `action_simulations` with a unique action
   reference and indexes by project/action/created time;
7. require a matching artifact before any future `simulating -> simulated`
   transition.

M6A could already contain fake actions in `simulated` or `approval_pending`
without a simulation artifact, and its generic transition trigger could leave
descriptor-incompatible actions in `simulating`. M6B deliberately rejects such
an upgrade rather than synthesizing unverifiable artifacts or importing an
unrestorable lifecycle state. The only preserved legacy `simulating` rows are
the descriptor-valid pairs `fake.write/allow_simulation_only` and
`fake.delete|fake.admin/allow_with_approval`. All other `simulating`
operation/decision pairs fail the upgrade. A temporary migration guard on the
`schema_migration` insert raises the stable message
`M6B upgrade requires remediation of legacy simulated action requests`; because
that insert occurs in the same runner transaction, the complete table rebuild is
rolled back. M6A rows in `requested`, `authorized`, and `denied` are preserved;
compatible `simulating` rows are restored through the M6B repository after the
upgrade. Operators must remediate or archive incompatible rows while still on
M6A before retrying.

The migration runner already wraps each file with `Database.transaction` and
opens databases with foreign keys enabled. `0013` therefore does not issue
`PRAGMA foreign_keys=OFF` (which would be ineffective inside the transaction).
It creates replacements under temporary names, copies and drops child-first,
renames parent-first, and recreates every table-bound M6A trigger and index. A
simulated failing migration verifies that the rebuild and schema-version insert
roll back together.

An isolated Bun/SQLite reproduction against the populated real M6A schema
evaluates the previous intermediate rebuild after `capability_grants` is dropped
and produces `no such table: main.capability_grants` from the external agent
guard. With the explicit drop/recreate sequence, `0013` succeeds, the recreated
agent/role deletion and identity guards retain the exact M6A messages,
`foreign_key_check` is empty, and `integrity_check` returns `ok`.

Allowed resource pairs become `fake/filesystem_scope` and
`filesystem/filesystem_scope`. Allowed action connector/version pairs become
`fake/1` and `filesystem/1`. An insert trigger must also verify that the action
connector equals its referenced resource provider.

Migration tests must cover a fresh database, upgrade from M5 through M6B, and an
upgrade from a populated M6A database containing fake resources, grants, action
requests, and audit events. `PRAGMA foreign_key_check` must remain empty after
the rebuild. The implemented matrix covers status, operation, and decision
combinations legally constructible through M6A transitions. It restores every
accepted row through the M6B repository, verifies byte-for-byte timestamp/ID
preservation, confirms incompatible `simulating`, `simulated`, and
`approval_pending` rows roll back schema and data fully, and runs both
foreign-key and integrity checks.

## Audit model

Continue using `audit_event`; do not create a connector-specific audit log.
Add sanitized events for read execution started/completed/failed and simulation
started/completed/failed. State changes and their audit append are atomic where
both are SQLite writes. Filesystem I/O occurs between short transactions.

Audit payloads may include action ID, resource ID, operation, result kind,
counts, byte sizes, source/simulation hashes, and typed failure code. They must
not include canonical roots, credential references, arguments, search queries,
file content, result previews, diffs, or outside-root paths.

## Implemented files and deviations from the initial plan

### New files

- `docs/implementation/M6B-filesystem-connector-assessment.md`
- `migrations/project/0013_filesystem_connector.sql`
- `packages/connector-sdk/package.json`
- `packages/connector-sdk/src/connector.ts`
- `packages/connector-sdk/src/connector-registry.ts`
- `packages/connector-sdk/src/errors.ts`
- `packages/connector-sdk/src/fake-connector.ts`
- `packages/filesystem-connector/package.json`
- `packages/filesystem-connector/src/filesystem-descriptor.ts`
- `packages/filesystem-connector/src/filesystem-arguments.ts`
- `packages/filesystem-connector/src/filesystem-constraints.ts`
- `packages/filesystem-connector/src/filesystem-sandbox.ts`
- `packages/filesystem-connector/src/sensitive-paths.ts`
- `packages/filesystem-connector/src/source-preconditions.ts`
- `packages/filesystem-connector/src/unified-diff.ts`
- `packages/filesystem-connector/src/atomic-mutation-plan.ts`
- `packages/filesystem-connector/src/filesystem-connector.ts`
- `packages/filesystem-connector/src/default-connector-registry.ts`
- `packages/domain/src/capability/action-simulation.ts`
- `packages/application/src/capability/action-simulation-hash.ts`
- `packages/application/src/capability/invoke-controlled-connector-action.ts`
- `tests/unit/action-simulation.test.ts`
- `tests/unit/connector-registry.test.ts`
- `tests/unit/filesystem-connector.test.ts`
- `tests/integration/filesystem-connector.test.ts`
- `tests/integration/filesystem-migration.test.ts`

### Existing files to modify

- `tsconfig.json` for the two workspace import aliases;
- domain capability descriptor, policy engine, errors, and action state machine;
- application resource/grant validation, controlled-action services, capability
  errors, repository port, and CLI command context;
- SQLite capability repository;
- CLI capability handler/help and daemon composition root;
- migration fresh/upgrade tests and existing M6A policy/storage tests.

The initial plan suggested separate text, sandbox, diff, storage, and daemon test
files. The implementation keeps text opening/verification next to the sandbox
and consolidates related tests to reduce surface area. It also adopts a bounded
whole-file unified diff instead of a minimal Myers diff and rejects hard links
strictly, following the confirmed security decisions. No filesystem
implementation belongs in domain, application services, SQLite repositories,
CLI handlers, or the agent runtime.

## Test plan

### Unit tests

- registry uniqueness, immutability, unknown connector/operation, descriptor and
  handler consistency;
- trusted risk/simulation/approval classification for all seven operations;
- runtime argument validation and prototype-key rejection;
- portable relative-path parsing, traversal, absolute/drive/UNC paths, NUL,
  separators, prefix boundary cases, and deterministic normalization;
- filesystem constraint intersection across two and three grants, unknown keys,
  empty intersections, and maximum ceilings;
- sensitive denylist case variants and nested paths;
- binary and invalid UTF-8 detection;
- source hashes and absent/file preconditions;
- deterministic create/write/move/delete unified diffs, line-ending cases,
  no-newline markers, work/output bounds;
- action lifecycle for read completion/failure and mutation simulation only;
- atomic plan purity: producing a plan creates no file.

### Integration and security tests

- canonical root registration, non-existing root, file-as-root, and symlink root;
- list/read/search strictly within root with stable ordering;
- no capability, revoked capability, disabled resource, wrong project/resource,
  and wrong operation cause no filesystem access;
- lexical traversal and absolute escape denial;
- direct, intermediate, dangling, and outside-root symlink denial;
- sensitive files omitted from list/search and rejected on direct read;
- binary, special-file, file-size, entry-count, search-match, and response limits;
- simulated create/write/move/delete leave a complete before/after tree and inode
  snapshot unchanged, including absence of temporary files;
- deterministic simulation artifacts and hashes;
- changing a source after simulation makes precondition verification stale;
- audit contains hashes/counts but no roots, queries, content, diff, or secrets;
- CAS conflict and connector failure leave legal terminal/intermediate state;
- fresh migration, populated M6A upgrade, M5-to-M6B upgrade, foreign-key check,
  and preservation of existing fake actions.

### Daemon/CLI tests

- daemon-backed registration and generic invocation round trip;
- stable JSON output and request IDs;
- malformed JSON, unknown provider/operation, invalid paths, and oversized input;
- output remains inside connector/daemon limits;
- read and search return only authorized safe content;
- all four mutation simulations return a diff/hash but produce no filesystem
  change.

## Principal risks

1. **SQLite table rebuild:** all M6A triggers and ownership checks must be
   reproduced exactly. Populated-upgrade and `foreign_key_check` tests are
   mandatory.
2. **TOCTOU and symlinks:** JavaScript path APIs cannot offer portable `openat`
   descriptor-relative traversal. Denying every symlink, using no-follow opens,
   bounding I/O, and source preconditions reduce but do not eliminate hostile
   local races.
3. **Sensitive-data exfiltration:** list and search can leak names/previews even
   without direct read. Deny rules must run before metadata/content is returned,
   and audit must never capture outputs.
4. **Diff amplification:** otherwise-small inputs can produce large or expensive
   diffs. File, line/work, and complete-output limits must fail closed.
5. **Lifecycle split around I/O:** SQLite transactions cannot span filesystem
   work. Connector errors or process crashes can leave `executing` or
   `simulating` records; recovery is M6D, while M6B must keep states observable
   and never falsely mark completion.
6. **Transport mismatch:** daemon arguments currently cap inline mutation
   content at 16 KiB. Direct application calls may exercise larger connector
   limits, but the initial CLI cannot transport a full 1 MiB write simulation.
7. **Cross-platform behavior:** Windows reparse points and atomic rename semantics
   require dedicated verification; the initial sandbox should fail closed on
   unsupported platforms.

## Decisions to confirm before implementation

The recommended defaults are:

1. Add a generic daemon-backed `action:invoke` command while retaining
   `action:request` as authorization-only. This avoids changing M6A automation.
2. Persist immutable simulation artifacts in `action_simulations`; do not store
   read contents or search results.
3. Extend lifecycle only for read execution and simulation; do not add any
   approved mutation execution transition.
4. Restrict mutation simulation to regular files with existing parents; exclude
   directory mutations.
5. Deny every symlink component rather than allowing verified internal symlinks.
6. Use literal search only, with no regex support.
7. Treat POSIX as the verified M6B platform and fail closed where equivalent
   Windows junction/no-follow guarantees are unavailable.
8. Use inline UTF-8 mutation content for M6B. Raising daemon transport limits or
   adding upload/blob transport is deferred rather than hidden inside M6B.

These decisions keep M6B independently testable and leave approval, mutation
execution, replay protection, recovery, and agent integration to M6C/M6D.

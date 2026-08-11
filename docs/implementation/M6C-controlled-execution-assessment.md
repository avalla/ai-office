# M6C approval and controlled execution assessment

> **Roadmap note (M6C-lite):** the MVP now adopts a reduced trusted-local threat
> model. The hardened design assessed below remains valid research and is
> deferred to M10 Security hardening; M6C-lite does not integrate its native,
> cryptographic-approval, audit-chain, or advanced-recovery recommendations.
> References below to a hardened filesystem v2 predate M6C-lite: the lite
> implementation uses connector v2, so any future hardened executor must use a
> newly versioned descriptor and require fresh simulation and approval.

## Assessment status and conclusion

This assessment is based on `main` at `5fcd6ad`, the merge commit for PR #8
(`M6B — Connector SDK and filesystem sandbox`). It is a design assessment only.
It does not add an approval model, an executor, a migration, a command, or a
test.

M6B provides a sound authorization and simulation base: immutable action
payload hashes, immutable filesystem simulation artifacts, current-grant
revalidation before invocation, descriptor-bound lifecycle transitions, and
one simulation per action. Those guarantees are necessary but are not enough
to execute a real mutation safely.

Two decisions block a responsible M6C implementation:

1. **There is no authenticated action approver identity.** The daemon socket is
   owner-only, but action commands do not establish a human identity or prove
   that an approval did not originate from an agent running as the same OS
   account. M5 governance approvals accept a caller-supplied actor string and
   are not suitable as execution authority.
2. **Portable Node/Bun APIs cannot provide both race-free mutation containment
   and crash-atomic coordination with SQLite.** Node/Bun do not expose the
   descriptor-relative `openat`/`openat2`, `renameat2`, and `unlinkat`
   primitives needed to keep path resolution attached to a verified root while
   names are being changed. Even with a native helper, SQLite and a filesystem
   rename do not share a transaction. A crash after the mutation and before the
   completion commit leaves an unavoidable uncertainty window.

The recommended direction is therefore gated, not implicit:

- use a dedicated action-approval aggregate bound to the existing action and
  simulation hashes;
- define an authenticated local-operator boundary before exposing approval;
- adopt an at-most-once execution lease: a committed lease is never silently
  reacquired or replayed;
- add the explicit terminal security state `execution_unknown` for every
  post-commit or durability ambiguity and never make it automatically retryable;
- introduce filesystem connector version 2 for execution; version-1 actions and
  simulations remain history and must be requested and simulated again;
- require an authenticated `ActionApproval` for every real filesystem version-2
  mutation, including create, write, and move as well as delete;
- bind a Linux filesystem root identity captured during version-2 simulation
  into the artifact and approval, then require an exact helper-side match at
  execution;
- use a Linux native descriptor-relative spike with independently validated
  inputs, `openat2`, no-cross-device resolution, and daemon-exclusive
  namespace-mutation authority before enabling production mutations;
- fail closed, without a weaker Node/Bun fallback, when any required native or
  kernel capability is unavailable;
- reserve an internal, connector-denied namespace for staging files and delete
  tombstones;
- do not claim multi-file atomicity for action batches.

A deterministic exactly-once mutation with an always-correct final database
status is not achievable across the current SQLite and filesystem boundaries.
M6C can provide deterministic authorization, exact approval binding, one-shot
attempts, and fail-closed recovery posture; it cannot make the two storage
systems one atomic resource.

## Scope boundary

The roadmap assigns the following work to M6C:

- action approval requests, decisions, expiry, rejection, and invalidation;
- exact binding of approval to immutable authorization and simulation data;
- execution-time revalidation of grants, constraints, resource status,
  connector metadata, approval, and budget;
- one-shot controlled mutation execution and replay prevention;
- real `filesystem.create`, `filesystem.write`, `filesystem.move`, and
  `filesystem.delete`;
- deterministic action batches, dependency ordering, and simulated identifier
  resolution;
- connector/action dimensions in existing usage and cost accounting;
- a local tamper-evident extension of the existing audit log.

M6C must not absorb M6D responsibilities. In particular, general restart
recovery, agent-executor integration, scheduling of long-running agent work,
and a complete agent-to-action gateway remain M6D. GitHub, SQLite, and shell
connectors, a web approval UI, distributed execution, and multi-tenant
isolation remain outside M6C.

## Implemented M6B baseline on `main`

### Reusable domain invariants

`packages/domain/src/capability` currently owns:

- project-scoped resources and grants;
- deterministic policy decisions;
- canonical JSON and the version-1 authorization payload;
- `ActionRequest`, including immutable decision data and a typed state machine;
- `ActionSimulation`, including canonical file preconditions and artifact
  identity.

The authorization payload hash binds:

- project, agent, and resource;
- connector ID and connector version;
- operation;
- normalized arguments;
- effective constraints.

The simulation artifact hash separately binds:

- action request ID;
- authorization payload hash;
- connector ID and version;
- operation;
- normalized preconditions;
- complete diff hash.

The separation is important. Approval must bind both hashes. Approving only the
action payload would omit the simulated diff and source preconditions;
approving only the artifact would make the relationship to the original agent,
resource, arguments, and effective constraints indirect and harder to verify.

### Current lifecycle

M6B enforces these flows in both the domain and SQLite:

```text
deny:
requested -> denied

read:
requested -> authorized -> executing -> completed | failed

mutation without approval:
requested -> authorized -> simulating -> simulated

mutation requiring approval:
requested -> authorized -> simulating -> simulated -> approval_pending
```

`approved`, `rejected`, `cancelled`, and `expired` are present in the status
union and the database `CHECK`, but M6B deliberately provides no transitions
into or out of them. `approval_pending` is terminal under the current trigger.
M6C will rebuild `action_requests` because this assessment fixes the additional
status `execution_unknown`; the historical M6B schema itself remains unchanged.

The M6B transition trigger additionally ties lifecycle to trusted descriptor
semantics: reads can execute only with `decision='allow'`; mutation simulation
must match `allow_simulation_only` or `allow_with_approval`; only operations
whose descriptor requires approval can enter `approval_pending`.

### Current invocation lease

`InvokeControlledConnectorAction` already has a useful authorization-lease
pattern for reads and simulations. Inside one `BEGIN IMMEDIATE` transaction it:

1. reloads the authorized action;
2. reloads the resource, agent, role, and current grants;
3. resolves the current trusted connector descriptor;
4. reruns policy using the injected clock;
5. compares decision, risk, matched grant IDs, effective constraints, connector
   version, and the canonical payload hash;
6. uses compare-and-swap to acquire `executing` or `simulating`;
7. appends a sanitized audit event.

I/O occurs after that short transaction. Revocation or disablement committed
before the CAS prevents acquisition. A change committed after the CAS does not
cancel the in-flight read or simulation. M6C should retain this cutover model,
but a mutation needs a **final execution lease**, distinct from the M6B
simulation lease.

### Current simulation persistence

`action_simulations` is project-scoped and append-only. It has:

- one artifact per action through a composite unique constraint;
- a composite foreign key to the action request;
- triggers matching project, action hash, connector, version, operation, and
  `simulating` state;
- canonical precondition validation;
- a trigger requiring the artifact before `simulating -> simulated`;
- update and delete denial.

Artifact insertion, `simulating -> simulated`, approval-pending transition when
needed, and audit append share one SQLite transaction. Read results are not
persisted. Mutation content remains present in the immutable action arguments
and, as diff text, in the simulation artifact; CLI projections redact inline
write/create content from action display. The version-1 artifact does not bind
the kernel identity of the registered root. Filesystem version 2 must add that
binding rather than treating the persisted canonical root pathname as a stable
security identity.

### Current connector and filesystem boundaries

The connector registry freezes context-free definitions and has no fallback.
`filesystem` version `1` is the trusted source for operation mode, risk,
simulation, execution, and approval metadata. M6B declares real execution only
for list/read/search; all four mutations advertise `supportsExecution=false`.

The filesystem sandbox supplies:

- canonical POSIX roots and fail-closed unsupported-platform behavior;
- portable relative paths and effective path/work limits;
- recursive sensitive-path denial;
- all-symlink denial and hard-link denial;
- bounded, strict UTF-8 reads;
- source hashes over original bytes;
- deterministic whole-file unified diffs;
- read-only verification of `file` and `absent` preconditions.

Its path safety is strong for reads but intentionally not described as a
kernel-enforced sandbox. It repeatedly uses path-based `lstat`, `realpath`,
open, `fstat`, device/inode comparison, and containment checks. M6B documents
the remaining race because Node/Bun cannot walk and mutate relative to a held
directory descriptor.

### Existing approval, audit, and budget systems

M5 governance `review`/`approval` records must not be reused directly as action
approval authority:

- review subjects exclude action requests;
- decisions bind a review ID, actor, rationale, and timestamp, but no action or
  artifact hash;
- there is no expiry or invalidation state;
- the CLI accepts a self-asserted `--actor` string;
- the model is intended for governance records, not time-sensitive execution.

M6C should reuse the conventions and actor value object where appropriate, not
the aggregate or repository.

`audit_event` is the single append-only audit log. SQLite blocks update/delete,
but events have no sequence, previous hash, or event hash. The application
currently computes no chain.

M4 budget accounting is monetary and LLM-specific. `model_usage` requires
provider/model/token dimensions, and `cost_event` references `model_usage`.
`budget_reservation` already provides the useful
`authorize -> reserve -> consume|release` pattern, but its repository starts its
own immediate transaction. It cannot be called from a final execution-lease
transaction without refactoring transaction participation. Filesystem actions
also have no pricing or monetary estimate today, so the meaning of an action
budget must be decided before schema work.

## Threat model

M6C should make its trust assumptions explicit.

### In-scope threats

- an agent controls operation arguments and attempts path traversal, constraint
  bypass, connector/version substitution, approval substitution, or replay;
- grants expire or are revoked and resources are disabled after simulation or
  approval;
- a connector definition changes between simulation and execution;
- the registered canonical-root pathname is renamed, replaced, bind-mounted, or
  remounted onto a different filesystem identity after simulation;
- two callers concurrently approve, reject, expire, or execute the same action;
- an action, artifact, approval, batch, or execution record is substituted from
  another project;
- the source or destination changes after simulation;
- a local process able to modify the registered root races path checks;
- the daemon crashes or loses power before, during, or after a filesystem
  mutation;
- audit rows are modified offline after the daemon stops;
- budgets are consumed concurrently;
- errors attempt to disclose absolute roots, content, diffs, or credentials;
- a deployment lacks, partially implements, or changes the behavior of a Linux
  syscall/flag on which native mutation containment depends.

### Trusted components

- domain canonicalization and hashing;
- the immutable connector registry and selected descriptor version;
- application orchestration and injected clocks/ID generators;
- SQLite foreign keys, triggers, and short `BEGIN IMMEDIATE` transactions;
- the Linux native mutation boundary after its required spike passes;
- an authenticated approver identity source that does not yet exist.

### Limits of the threat model

A process with unrestricted access to both the daemon database and its signing
or chain-anchor material can rewrite data and recompute a local hash chain. A
local hash chain detects accidental corruption and unsophisticated offline
tampering; without an external anchor or protected signing key it is not proof
against the machine owner or a fully compromised daemon account.

Likewise, if arbitrary processes retain mutation permission on the registered
root, no application-level check can provide a general atomic
"replace this exact inode only if unchanged" operation for every filesystem
mutation. M6C therefore fixes the initial deployment contract as
**daemon-exclusive namespace mutation authority** for every directory touched
during controlled execution. The daemon serializes its own mutations, and the
deployment must prevent or operationally exclude another process with
concurrent `rename`/`unlink` authority over those directories. A same-owner
hostile process violates this supported deployment contract.

This contract does not replace kernel containment. The native helper must still
enforce root and parent identity, symlink and magic-link denial, child
mount/bind-mount denial, hard-link and special-file denial, and destination
no-replace semantics. M6C does not claim conditional replacement safety against
a hostile process that simultaneously has full namespace-mutation authority.

### Security clock and rollback

M6C should not treat the wall clock as silently trustworthy. The fixed minimal
design is a persisted project security-time watermark. Every M6C
security-sensitive state transaction—approval creation/decision/expiry/
invalidation, execution lease, completion/failure/unknown classification, and
batch transition—loads the last accepted UTC instant:

- if `clock.now()` is earlier than the watermark, the security operation fails
  closed with a typed clock-rollback error;
- otherwise the same transaction advances the watermark to `clock.now()` when
  it is later;
- expiry remains half-open (`now < expiresAt`) after the floor check;
- a large forward jump may expire work early, which is fail-closed;
- restart does not reset the floor.

This is a logical wall-clock floor, not a true monotonic hardware clock. It
detects rollback relative to previously accepted security operations, including
across daemon restarts. A database owner can rewrite it, which is outside the
local chain's stated protection boundary. Tests must inject backward, equal,
and forward times at transaction boundaries.

## Approval model

### Separate action-approval aggregate

Introduce a dedicated action approval model rather than expanding M5 reviews.
The conceptual records are:

- `ActionApprovalRequest`: immutable subject, binding hash, creation and expiry;
- `ActionApprovalDecision`: immutable approve/reject decision, authenticated
  actor, decision timestamp, rationale, and the exact binding hash seen by the
  approver;
- an approval status projection: `pending`, `approved`, `rejected`, `expired`,
  or `invalidated`.

Approval is necessary for an approval-required descriptor, but it is never a
capability. A valid approval cannot override a revoked grant, disabled resource,
changed constraint set, stale connector version, failed budget check, or stale
filesystem precondition.

One approval request per action is the simplest safe M6C rule. A rejected,
expired, or invalidated action must be requested and simulated again; reopening
or replacing a decision on the same immutable action creates ambiguity about
which payload was approved. Historical decisions remain append-only.

### Exact approval binding

Use the existing canonical JSON implementation and a new, versioned approval
subject. A recommended conceptual payload is:

```ts
interface CanonicalApprovalSubjectV1 {
  schemaVersion: 1;
  projectId: string;
  approvalRequestId: string;
  actionRequestId: string;
  actionPayloadHash: string;
  authorizationDecisionHash: string;
  simulationId: string;
  simulationArtifactHash: string;
  connector: string;
  connectorVersion: string;
  operation: string;
  resourceId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  approvalRequirement: "required";
  approvalPolicyVersion: string;
  expiresAt: string;
  batchHash: string | null;
}
```

Do not change historical authorization payload version 1. Add a separate
approval-level authorization-decision hash over a canonical value containing at
least:

```ts
interface CanonicalAuthorizationDecisionForApprovalV1 {
  schemaVersion: 1;
  actionPayloadHash: string;
  decision: "allow_with_approval";
  matchedGrantIds: readonly string[];
  effectiveConstraints: unknown;
  riskLevel: "low" | "medium" | "high" | "critical";
  connector: string;
  connectorVersion: string;
  operation: string;
  approvalRequirement: "required";
}
```

Grant IDs are sorted and constraints use existing canonical JSON. The trusted
descriptor supplies risk, connector identity/version, operation, and approval
requirement; an agent or CLI cannot provide them. The approval subject repeats
`riskLevel` and `approvalRequirement` so the security classification shown to
the approver is directly bound as well as covered by the decision hash.

The approval binding hash is SHA-256 of this canonical subject. Explicit `null`
for a non-batch action prevents ambiguity with an omitted field. Binding the
approval request ID and expiry prevents a decision from being copied to another
request or validity window. The action payload hash transitively covers agent,
normalized arguments, and the originally authorized effective constraints. The
new decision hash directly binds decision, matched grants, effective
constraints, risk, and trusted descriptor classification. The artifact hash
covers the complete diff hash and preconditions. Connector, operation, risk,
and approval requirement are repeated as defence-in-depth and must match every
source record.

The approval decision stores the binding hash exactly. At decision time and
again at lease acquisition, the application recomputes the subject from
persisted immutable rows and constant-time compares all hashes. Neither the CLI
nor an agent may supply a connector version, artifact hash, action hash, or
approval subject.

The approver-facing projection should show sanitized operation, relative paths,
complete diff, preconditions, risk, resource display name, expiry, and binding
hash. It must not show the canonical root, credential reference, or unredacted
action JSON outside the controlled diff projection.

### Approval lifecycle and action relationship

`ActionApproval` is the sole authority for approval state. Its transitions are:

```text
pending -> approved
pending -> rejected
pending -> expired
pending -> invalidated
approved -> invalidated   (only before execution lease)
```

Rejected, expired, and invalidated are terminal. Approval decisions are
append-only; expiry and invalidation should be explicit immutable events plus a
CAS projection, not deletion or mutation of the decision content.

`ActionRequest` must not gain an `approved` state as a second source of truth.
The generic domain may continue to represent a future connector operation that
does not require approval, but that path is not available to the initial
filesystem version-2 executor. The generic and filesystem-specific transitions
are therefore:

```text
generic future non-approval operation only:
simulated -> executing -> completed | failed | execution_unknown

every filesystem v2 mutation:
simulated -> approval_pending
approval_pending -> executing -> completed | failed | execution_unknown
```

The trusted filesystem version-2 descriptor marks all four real mutations as
approval-required. Their risk remains operation-specific:

| Operation | Risk | Real execution gate |
| --- | --- | --- |
| `filesystem.create` | medium | authenticated `ActionApproval` required |
| `filesystem.write` | medium | authenticated `ActionApproval` required |
| `filesystem.move` | medium | authenticated `ActionApproval` required |
| `filesystem.delete` | high | authenticated `ActionApproval` required |

Without a valid authenticated approval, no real filesystem namespace mutation
is permitted. Allowing a low- or medium-risk filesystem mutation without human
approval is deferred; it requires a new security and policy decision and
appropriate connector/policy versioning, not a runtime flag.

`approval_pending -> executing` is legal only inside the final execution-lease
transaction when a separate approved, unexpired, non-invalidated
`ActionApproval` exactly matches the recomputed binding. Approval is checked by
foreign key, hashes, domain rules, repository CAS, and SQLite triggers.

When approval is rejected, expires, or is invalidated before lease acquisition,
the approval aggregate records the authoritative terminal reason and the same
transaction moves the action from `approval_pending` to generic `cancelled`.
`cancelled` is only a derived execution-eligibility projection: it means the
action is terminal and non-executable, not that it is the source of approval
truth. Lists may join the approval aggregate to show the precise reason. The
action can never return from `cancelled` to an executable state.

M6C definitively adds `execution_unknown`. The existing `approved` status stays
unused for action execution and may remain only as a historical reserved enum
value. Adding `execution_unknown` requires rebuilding `action_requests` in
`0014` and recreating all M6A/M6B checks and triggers.

Approval expiry uses an injected clock and a half-open interval: approval is
valid only while `now < expiresAt`. The persisted security-time watermark
defined in the threat model detects rollback; a time earlier than the watermark
is rejected rather than merely described as fail-closed.

### Approver identity blocker

The owner-only Unix socket authenticates only possession of the OS account. Bun's
HTTP-over-unix abstraction does not currently give the application a portable
peer credential suitable for a durable user identity, and the existing CLI
accepts arbitrary actor text. Therefore a command such as
`action:approve --actor alice` would not be a security control.

Before implementation, choose one of these models:

1. **Restricted local operator:** approvals are accepted only through a
   dedicated interactive process, identity is derived from trusted OS account
   configuration, and agents are assumed unable to invoke that process. This is
   the smallest scope but must be an explicit threat-model restriction.
2. **Authenticated approval credential:** a local signing key or WebAuthn-like
   operator credential signs the approval binding hash. The daemon verifies the
   signature and stores key ID/signature. Key storage, revocation, and recovery
   enlarge M6C.
3. **Defer real approval:** implement approval subjects and pending projections,
   but do not permit any filesystem version-2 mutation until an authenticated
   channel exists.

The recommended minimum is option 1 only if the product explicitly accepts the
same-account trust boundary; otherwise option 3 is safer. Caller-supplied actor
strings must never authorize execution.

## Execution-time authorization and final lease

### Revalidation requirements

Immediately before acquiring the final execution lease, rerun and compare:

- action status and project ownership;
- enabled persisted agent and current role membership;
- active resource, immutable canonical root, provider, and type;
- current connector descriptor ID, version, operation metadata, execution
  support, risk, and approval requirement;
- current matching grants, including validity, expiry, and revocation;
- normalized arguments and effective constraints;
- action payload hash recomputed from persisted fields;
- approval-level authorization-decision hash, including exact decision,
  matched-grant set, effective constraints, risk, descriptor identity/version,
  operation, and approval requirement;
- simulation row, preconditions, diff hash, artifact hash, project/action
  relationship, and the canonical version-2 root identity bound by that
  artifact;
- approval request, decision, binding hash, actor authority, expiry, and
  invalidation status when approval is required;
- batch manifest/hash and dependency readiness when the action belongs to a
  batch;
- hard budget availability and reservation;
- security-time watermark and approval-expiry floor;
- absence of any prior execution record or lease for the action.

Every comparison is exact. A newly issued grant, a different set of matched
grant IDs, a stricter constraint, or a new connector version makes the old
action stale; M6C must not silently broaden, narrow, or re-simulate it under the
same identity.

For filesystem version 2, execution authority is the conjunction of the current
capability over the registered resource and the exact root identity captured by
its approved simulation. Authorization of the same resource ID or pathname is
not authorization of a replacement mount or inode.

### Final execution-lease transaction

The final lease should be one `BEGIN IMMEDIATE` transaction on the project
database:

1. load action, simulation, approval, batch, resource, agent, and current grants;
2. recompute policy and every binding hash using the current clock;
3. check and reserve the hard budget;
4. insert exactly one execution record with an immutable execution ID and
   `lease_acquired` state;
5. CAS `approval_pending -> executing` for every filesystem version-2 mutation
   with a separately valid `ActionApproval`; the generic
   `simulated -> executing` branch is reserved for a future descriptor whose
   reviewed policy explicitly does not require approval;
6. append the lease-acquired audit event and its chain link;
7. commit.

All participating repository methods must use the caller's transaction. The
current cost adapter's private `BEGIN IMMEDIATE` cannot be invoked here because
`SqliteTransactionRunner` rejects nested transactions. M6C needs a
transaction-participating budget method or one repository operation that
performs lease, reservation, and audit writes on the same connection.

No filesystem I/O belongs inside this transaction. Holding SQLite while waiting
for filesystem operations would violate ADR-0001, block the single writer, and
still would not make the filesystem mutation transactional.

Required native features are probed before lease acquisition. The authoritative
comparison with the live root identity necessarily occurs after lease commit,
inside the native helper that holds the root descriptor used for the mutation.
A root mismatch is a definite pre-commit stale-simulation failure: the helper
attests that no committing namespace mutation occurred, the action may move to
`failed`, and the lease is never reused. This preserves the short transaction
without weakening the approval binding.

### Authorization lease semantics

Recommended cutover:

- revocation, expiry, disablement, descriptor replacement, approval
  invalidation, or budget exhaustion committed before the lease blocks it;
- once the final lease commits, the action owns one in-flight attempt;
- changes after that commit affect future actions and do not cancel the
  already-started native mutation;
- the lease is never expired and reacquired automatically;
- a second caller always loses the unique insert/CAS and performs no filesystem
  operation.

This is at-most-once attempt semantics, not exactly-once completion semantics.
The cutover must be documented because a revocation racing just after commit
cannot reliably stop a syscall already in flight.

## One-shot execution and replay prevention

Replay prevention requires enforcement in the domain, repository, and SQLite:

- one execution record per project/action through a composite unique key;
- composite ownership links to action, simulation, approval, resource, and
  batch item;
- immutable action, simulation, approval, and execution binding hashes;
- CAS from the only descriptor-valid pre-execution status;
- only `executing -> completed|failed|execution_unknown`; none of
  `completed`, `failed`, `execution_unknown`, `cancelled`, rejected, expired, or
  invalidated can return to an executable state;
- no lease TTL that permits automatic takeover;
- no API accepting raw arguments for an existing action execution;
- a new action ID, new simulation, and new approval for every retry after a
  definite `failed` result; `execution_unknown` is never automatically
  retryable, even when observed postconditions appear unchanged.

An idempotency key supplied by an agent is not sufficient. The authoritative
key is the persisted action/execution identity and its unique database
constraint.

## Controlled filesystem mutation executor

### Connector boundary

Do not extend the current generic `invoke` callback so that it sometimes mutates
based on caller flags. Prefer a separate trusted execution contract, for
example an `executeMutation` adapter available only for descriptor operations
that advertise real execution. The application constructs its input from the
persisted action, simulation, approval, and execution lease; CLI arguments are
never passed directly to it.

The connector may return a sanitized execution result and postcondition hashes.
It must not access repositories, change action status, consume budgets, or
append audit events.

Changing filesystem operations from `supportsExecution=false` to `true` changes
trusted descriptor semantics. M6C fixes the execution descriptor as filesystem
connector version `2`. Version-1 actions and simulation artifacts remain valid,
immutable history but are never executable. Every mutation intended for
approval or execution must be requested and simulated again under version 2;
the system must not reinterpret or upgrade an old artifact in place.

The initial version-2 descriptor sets `approvalRequirement=required` for
`filesystem.create`, `filesystem.write`, `filesystem.move`, and
`filesystem.delete`. Create/write/move retain medium risk and delete retains
high risk. The domain and SDK may remain generic enough for a future connector
to declare a non-approval operation, but no filesystem version-2 production
execution path may use that capability.

For these operations, trusted `approvalRequirement=required` makes the policy
decision `allow_with_approval` even when the descriptor risk is medium. Risk
classification and approval requirement are separate trusted dimensions: the
approval gate raises the required control without relabeling medium operations
as high risk. Caller arguments cannot select either dimension.

### Common execution rules

All real mutation operations remain regular-file-only and must:

- accept only canonical relative paths already bound by the action hash;
- reopen the canonical root and verify it is the registered directory;
- enforce built-in denylist and effective constraints again;
- resolve paths relative to a held root/parent descriptor;
- deny every symlink, magic link, hard link, special file, and child mount or
  bind-mount boundary;
- verify exact source bytes and destination absence immediately before the
  committing namespace operation;
- use random, exclusively created, daemon-owned temporary/tombstone names;
- use fixed restrictive permissions independent of umask unless an explicitly
  approved metadata policy says otherwise;
- fsync written files and affected directories in a documented order;
- clean up only temporary entries owned by that execution ID;
- never infer executable content from the diff text; the exact normalized
  action content is the source, and its hash is checked against the action
  payload.

### Reserved internal transaction namespace

Staging files, replacement temporaries, durable receipts, and delete tombstones
must use a basename namespace reserved exclusively to AI Office. The final
literal belongs to the version-2 connector contract; conceptually it is a
prefix such as `.ai-office-txn-*` followed by an execution ID and unpredictable
random identity.

The ordinary filesystem connector treats every segment matching that namespace
as built-in sensitive and unavailable for:

- direct read;
- list and search, including omission of existence;
- mutation simulation;
- requested create/write/move/delete source or destination;
- allowed-prefix traversal;
- simulated identifier production or resolution.

This denial is recursive, case-safe for supported filesystems, cannot be
overridden by resource/grant constraints, and applies to entries left after a
crash. Agents never see an internal basename, relative path, content, or
metadata.

The native helper creates internal entries with exclusive/no-follow semantics
and unpredictable names. The execution ledger stores the execution ID and a
non-agent-visible ownership identity sufficient to recognize an owned entry.
Cleanup may remove only an entry whose parent/root identity, reserved basename,
execution ID, random identity, type, and expected inode/content metadata all
match. If ownership cannot be proven, cleanup fails closed and quarantines the
entry; it never removes a merely prefix-matching file.

### Operation-specific plan

`filesystem.create`:

1. open the destination parent relative to the verified root;
2. require destination absence;
3. create a random sibling temporary file with exclusive/no-follow flags and
   fixed mode;
4. write the exact approved UTF-8 bytes with bounded loops;
5. fsync and re-hash the temporary file;
6. atomically install with no-replace semantics;
7. fsync the parent.

Linux `renameat2(RENAME_NOREPLACE)` is preferred. A plain precheck followed by
`rename` is not an adequate absence guarantee.

`filesystem.write`:

- require the current file's type, link count, size, and byte hash to match the
  artifact;
- stage and fsync exact replacement bytes in the same directory;
- replace atomically and fsync the parent;
- record the old and new hashes.

There is no portable atomic "replace this path only if it still names inode X"
primitive in Node/Bun. Even native `renameat2` does not generally compare the
destination inode to an expected identity. A hostile concurrent writer can
swap the name after validation and before replacement unless the daemon has
exclusive mutation authority over the directory. That ownership/locking
assumption must be approved.

`filesystem.move`:

- verify source hash/size/type/link count and destination absence;
- require both parents beneath the same held root and the same filesystem;
- use no-replace rename semantics where available;
- fsync both parent directories in deterministic order;
- record source absence and destination content hash as postconditions.

The source-name identity has the same last-moment race as write unless directory
mutation is exclusive.

`filesystem.delete`:

- verify the exact approved source;
- rename it to a unique same-directory tombstone first;
- fsync the parent;
- verify tombstone identity, unlink it, and fsync again;
- record the source hash and final absence.

The tombstone makes some crashes observable, but does not make SQLite and the
filesystem atomic. Retention, visibility, and recovery of tombstones require an
explicit policy.

### Metadata semantics

M6B preconditions bind content hash and size, not mode, owner, ACLs, xattrs, or
timestamps. Replacing a file through a temporary inode can change metadata.
M6C must choose between:

- fixed safe mode/ownership for every controlled create/write; or
- binding approved metadata to a version-2 simulation and preserving only a
  narrowly defined portable subset.

Implicitly copying all metadata is unsafe and non-deterministic. ACLs, xattrs,
sparse layout, flags, and platform-specific attributes should remain excluded
unless separately designed.

## Preconditions and postconditions

The M6B canonical preconditions are a good approval-level base:

```text
absent(path)
file(path, sha256, size)
```

They should remain immutable and path-unique. M6C needs two additional layers:

1. **Ephemeral resolved preconditions:** root/parent handles, device/inode,
   regular-file type, link count, and containment checked by the executor. These
   are execution facts, not portable approval data.
2. **Deterministic postconditions:** expected output hash/size or absence,
   derived from the exact action content and artifact. They support execution
   records and later reconciliation.

Recommended postconditions:

- create: destination has hash/size of approved content;
- write: destination has replacement hash/size;
- move: source absent and destination has the approved source hash/size;
- delete: source absent.

The execution envelope should have its own canonical hash binding action,
simulation, approval (or explicit no-approval policy), execution ID, connector
version, preconditions, and postconditions. This hash is distinct from the
authorization, simulation, and approval hashes.

### Filesystem version-2 root identity binding

The canonical root pathname is configuration, not a sufficient execution
identity. A rename, bind-mount substitution, unmount/remount, or other root
replacement can make the same pathname resolve to a different filesystem tree
after simulation. `RESOLVE_NO_XDEV` constrains traversal below an already-open
root dirfd; it cannot detect that the path used to obtain that dirfd now names a
different root.

Filesystem version-2 simulation must therefore acquire a structured Linux root
identity containing at least:

- device major and minor numbers;
- inode number;
- mount identity.

The M6C.0 spike must evaluate `statx` with `STATX_INO`, `STATX_MNT_ID`, and,
when the running kernel exposes it, `STATX_MNT_ID_UNIQUE`. Values that may exceed
JavaScript's exact integer range must use a lossless canonical representation,
such as unsigned decimal strings. The spike must choose and version one exact
identity scheme; `STATX_MNT_ID_UNIQUE` is preferred when the resulting supported
kernel baseline is acceptable. Falling back to a weaker identity is not an
implicit compatibility behavior.

The selected root identity is acquired from the opened root during simulation,
stored in the canonical filesystem version-2 simulation artifact, and included
in its artifact hash. The approval subject already binds that artifact hash, so
the root identity is transitively part of the exact human approval. Immediately
before any mutation, the native helper independently opens the registered root,
obtains the same statx identity fields from the held root descriptor, and
compares them exactly with the approved artifact.

Version-2 simulation therefore uses a read-only native identity operation even
though it performs no mutation. If the required statx identity cannot be
obtained, the system cannot produce an executable version-2 artifact and fails
closed; it must not emit an artifact with a pathname-only or partially populated
identity.

A mismatch is a stale simulation and fails closed before a committing namespace
operation. The executor must never update the artifact or accept the new root
implicitly. Root rename/substitution, reboot, remount, or mount-identity changes
can consequently require a new request and simulation even when the target file
bytes are identical. The absolute root remains absent from audit events, public
projections, approval output, and redacted errors.

## Filesystem TOCTOU blocker

The M6B read sandbox reduces races by reopening, comparing device/inode, and
rechecking containment. Mutation is categorically harder because the final
operation acts on a pathname and changes namespace state.

With current portable Node/Bun APIs, an attacker able to rename entries can:

- replace an intermediate directory with a symlink after validation;
- exchange the target name after its inode/hash was checked;
- redirect a path-based rename or unlink to a different directory entry;
- race destination-absence checks;
- change a parent between temporary creation and final rename.

Repeated `lstat`/`realpath` checks shrink but do not close those windows. M6C
therefore narrows the supported execution deployment to daemon-exclusive
namespace mutation authority and still uses native containment against escape,
mount, link, and special-file attacks. It explicitly does not claim safety when
a hostile process concurrently controls the same directory namespace.

Options:

| Option | Security and cost | Assessment |
| --- | --- | --- |
| Portable Node/Bun path APIs | Preserves macOS/Linux portability but cannot close mutation races | Not recommended under the current threat model |
| Daemon-exclusive namespace authority | Require no concurrent external rename/unlink authority during execution, while retaining native containment | Fixed initial deployment/security contract; it does not defend against a same-directory hostile writer outside that contract |
| Linux-only native helper | Rust/N-API or a tightly framed helper using root dirfds, `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV)`, `renameat2`, `unlinkat`, `O_NOFOLLOW`, and fsync | Fixed technical direction for the spike; packaging and Linux-only production enablement remain gated on results |
| Portable native POSIX helper | Component-wise `openat` walk on Linux/macOS with platform-specific rename behavior | Wider support but more code and still no universal conditional-rename primitive |

The registered resource root may itself be a filesystem mount root. The helper
opens and pins that root, then applies all four resolve flags to descendants.
`RESOLVE_NO_XDEV` makes every child mount point and bind mount fail closed; the
executor never crosses a mount boundary beneath the registered root, even when
the mounted target would otherwise remain lexically below it.

Root pinning during one helper call does not by itself bind execution to the
root that was simulated. Before descendant resolution, the helper must validate
the held root descriptor against the version-2 artifact's statx root identity.
This separately closes registered-root pathname substitution; descendant
`RESOLVE_NO_XDEV` then closes traversal across child mount/bind-mount boundaries.

Linux may return `EAGAIN` from `openat2` when it cannot prove a stable resolution
under concurrent changes. The helper performs at most one immediate retry (two
total attempts, no backoff or unbounded loop) and then returns a typed,
redacted containment error. A deployment may choose zero retries for an even
stricter fail-closed posture, but the configured bound is fixed by connector
version and never caller-controlled.

### Native capability gating and independent validation

The native helper is an independent security boundary. It does not trust that
TypeScript normalization, capability evaluation, persistence, or IPC decoding
was correct. For every public operand it repeats the security-critical checks:

- relative path only and no NUL;
- no `.`, `..`, empty, or otherwise invalid components;
- connector-version bounds on path bytes and segment count;
- recursive denial of the reserved transaction namespace;
- a validated single final basename.

For committing namespace operations, the preferred shape is to split each
validated operand into parent and basename, open the parent with
`openat2(rootFd, parentRelativePath, ...)` using the complete resolve policy,
hold that parent dirfd, and call `renameat2(parentFd, basename, ...)` or
`unlinkat(parentFd, basename, ...)`. The helper must not perform an avoidable
second path-based traversal for the final mutation. Source and destination
parents for move are held and verified independently.

Root, parent, source, staging, and tombstone descriptors use `O_CLOEXEC`. The
spike must define scoped descriptor lifetimes, close every descriptor on every
success and error path, and prove cleanup ownership before touching an internal
entry. Parse errors, syscall errors, identity mismatch, or incomplete cleanup
evidence fail closed and surface only typed, redacted failures.

M6C has no weak compatibility fallback. If `openat2`, the required resolve
flags, `statx` and the selected mount-identity field, `renameat2` semantics, or
another primitive required by an enabled operation is unavailable, native
mutation execution is unsupported and fails before lease acquisition. It must
not fall back to Node/Bun path-based mutation APIs. M6C.0 determines and
documents the minimum supported Linux kernel/filesystem baseline from the
actual primitive and root-identity scheme selected by the spike; the assessment
does not hardcode a baseline before that evidence exists.

The fixed technical spike is Linux-only Rust/N-API using this complete
`openat2` policy, statx-bound root identity, independent input validation, and
daemon-exclusive namespace mutation authority.
If the spike cannot meet the adversarial tests, M6C stops at approval and dry
lease acquisition rather than shipping path-based real writes under an
overstated sandbox guarantee.

## Atomicity and crash consistency

### The cross-system gap

The critical sequence is:

```text
SQLite: commit execution lease
              |
              v
filesystem: perform and durably fsync mutation
              |
              v
SQLite: commit execution completion, accounting, and audit
```

No SQLite transaction can include the filesystem mutation. Reversing the first
two steps is worse: a mutation could occur before the database has established
one-shot ownership. Holding a transaction open does not solve the crash gap and
violates the short-transaction guardrail.

Crash outcomes:

| Crash point | Filesystem | Database | Safe automatic action |
| --- | --- | --- | --- |
| Before lease commit | unchanged | pre-execution | acquisition may be retried |
| After lease, before helper attests no commit | probably unchanged | `executing` + lease | restart recovery moves to `execution_unknown`; never infer safety from absence of a receipt |
| Helper reports failure before any committing namespace mutation | unchanged; owned staging may exist | `failed` | clean only proven-owned entries; a new action may be requested |
| During temp/tombstone preparation and process crashes | may contain owned internal entry | `executing` | M6D marks `execution_unknown`; quarantine/reconcile; no replay |
| After namespace mutation may have occurred, before fsync | state/durability uncertain | `executing` or `execution_unknown` | ensure `execution_unknown`; never replay |
| After durable mutation, before completion commit | changed | `executing` | M6D marks `execution_unknown`; never replay |
| After completion commit | changed | `completed` | terminal |

A post-crash state equal to the expected postcondition is evidence, not proof,
that this execution performed it; another local actor could have produced the
same bytes or absence. A missing source after delete is especially ambiguous.

### Recommended M6C crash semantics

- make the execution attempt at-most-once;
- never automatically release or steal a committed lease;
- permit exactly `executing -> completed|failed|execution_unknown`;
- use `failed` only when the executor can attest that no committing namespace
  mutation occurred; staging cleanup may still be necessary;
- transition immediately to `execution_unknown` when an in-process error occurs
  after the committing point may have been crossed or durability is ambiguous;
- if the process disappears, leave the durable row `executing`; M6D recovery
  conservatively maps every unfinished execution to `execution_unknown` before
  any reconciliation and never retries it automatically;
- let the execution record distinguish definite no-mutation failure, reported
  success, and unknown mutation/durability outcome;
- emit no false `completed` event;
- reserve reconciliation and operator decisions for M6D; `execution_unknown`
  is its explicit input state, not a retry queue;
- ensure uniquely owned temporary/tombstone names can be recognized without
  deleting unrelated entries.

If product requirements demand an always-final status after restart or automatic
retry, M6C needs a durable mutation journal/receipt protocol and likely a native
helper. Even that protocol cannot create a true transaction with SQLite; it
provides recoverability and classification, not distributed atomic commit.

### Additional crash-consistency scope options

- **Reduced M6C:** approvals, one-shot lease records, budget/audit integration,
  and a non-mutating execution adapter. Real writes wait for the native design.
- **At-most-once real execution:** fixed baseline for M6C; observable `executing` rows
  after a crash are converted conservatively to `execution_unknown` by M6D and
  are never automatically retried.
- **Durable helper journal:** store intent, stage, receipt, and cleanup markers
  in a daemon-reserved namespace and reconcile them on restart. This expands
  M6C and requires a threat model for tampering with that namespace.
- **Content-addressed workspace/snapshot execution:** mutate an isolated tree
  and atomically publish a root reference. This is substantially larger than the
  current regular-file connector scope.

## Execution record

A project-scoped execution record should be the durable one-shot authority. A
recommended conceptual shape includes:

- ID, project ID, action request ID, and simulation ID;
- approval request/decision ID and approval binding hash when required;
- action payload, artifact, batch, and execution-envelope hashes;
- connector ID/version and operation;
- lease state and immutable attempt number `1`;
- reserved-namespace ownership identity for any staging/tombstone entry;
- budget reservation ID;
- acquired, started, and finalized timestamps;
- sanitized outcome code;
- expected and observed postcondition hashes/byte counts;
- an outcome certainty classification aligned to `completed`, definite
  no-namespace-mutation `failed`, or `execution_unknown`;
- no absolute root, raw content, complete diff, credentials, or secret error
  text.

Use `UNIQUE(project_id, action_request_id)` and composite foreign keys. Identity
and binding fields are immutable. Status transitions are monotonic and protected
by CAS/triggers. Update/delete bypass must be blocked. An append-only execution
event projection can capture milestones without making a second audit system;
security-significant milestones must also append to the existing chained audit
log. A completion result cannot overwrite uncertainty: once the ledger or
action reaches `execution_unknown`, it is terminal for automatic execution and
only M6D reconciliation may add a separate historical resolution record.

## Deterministic action batches

### Model and ordering

An action batch should be an immutable manifest, not an array accepted directly
by an executor. It needs:

- project, agent, batch ID, schema version, and canonical batch hash;
- immutable items referencing action request and simulation IDs;
- stable item IDs or ordinals;
- explicit dependency edges;
- required/optional dependency semantics;
- an approval binding to the whole batch when batch approval is used;
- a deterministic identifier-resolution table.

Validate unique item IDs, same-project ownership, connector/resource
compatibility, absence of cycles, and no dependency on an unknown item. Use a
stable topological sort with item ordinal/ID as the tie-break. Execution should
initially be sequential. Parallel scheduling makes failure ordering and budget
reservation harder to reproduce.

### Failure semantics

Filesystem batches are not atomic across files. A failure after earlier items
completed produces a partial batch. Do not claim rollback; delete and external
concurrent modifications make general compensation unsafe.

At minimum:

- a failed required dependency skips every dependent item;
- no item runs before all required dependencies have completed;
- skipped/blocked reasons are deterministic;
- independent items either continue in stable order or the batch globally
  stops, according to one documented policy;
- replaying the batch cannot reacquire leases for completed or interrupted
  items.

The roadmap wording permits independent branches to continue, but a global
stop-on-first-failure rule is a safer first slice. This is a decision requiring
approval.

### Simulated identifier resolution

Use typed simulated identifiers, not string substitution inside arbitrary JSON.
A producer item may expose a descriptor-declared output such as a future file
identity. A consumer references `{ producerItemId, outputName }`; the batch
planner resolves it to a canonical relative path through a connector-specific
resolver before authorization and simulation.

The resolution table must bind:

- producer item/action/artifact;
- output name and simulated identifier;
- resolved resource ID and canonical relative path;
- consumer item and argument field;
- resolution schema/version.

The table and its hash are part of the batch hash and approval subject. Unknown,
duplicate, cross-project, cyclic, type-incompatible, or path-changing
resolutions deny the batch. Resolution cannot discover a new real path at
execution time; it may only confirm the already-hashed mapping and producer
postcondition.

## Budget and usage integration

M6C must extend M4 rather than create an unrelated `action_budget` system.
However, the existing model prices LLM tokens and cannot represent a filesystem
operation without a semantic decision.

Required decisions are:

- whether action budgets are monetary, operation-count, byte/work quotas, or a
  combination;
- how connector operation estimates are priced/versioned;
- which existing scopes apply to actions lacking a task or agent run;
- the soft-warning threshold and whether warning is advisory only;
- how an interrupted execution consumes or retains a reservation.

Recommended architecture if monetary action pricing is required:

- generalize the usage ledger to a discriminated usage kind rather than
  recording fake zero-token `model_usage` rows;
- add connector, connector version, operation, action request, execution, batch,
  and purpose dimensions;
- retain the existing `budget`, `budget_reservation`, and `cost_event`
  lifecycle;
- add a versioned connector-operation pricing record or explicitly configured
  fixed estimate;
- reserve the hard estimate inside the final execution-lease transaction;
- emit a soft-budget warning audit event in that same transaction when the
  chosen threshold is crossed;
- consume actual cost with the completion transaction, release only on a
  definite no-mutation failure, and retain/quarantine the reservation for an
  `execution_unknown` until reconciliation.

If filesystem actions are not monetarily priced, do not pretend that the M4
currency budget enforces them. A separate work quota might be valid, but it must
be integrated as a new budget dimension in the existing aggregate and reporting
surface, not a hidden parallel limiter.

## Tamper-evident audit hash chain

Continue using `audit_event`; do not create a companion event stream whose
coverage can drift. The recommended schema rebuild stores the chain element on
the `audit_event` row itself, with chain epoch/scope, sequence, previous hash,
event hash, and schema version columns. A small `audit_chain_head` table stores
only the current head and genesis metadata; it is not an audit log.

The coverage invariant is:

```text
every audit_event in a post-genesis epoch
has exactly one complete chain identity on that same row
```

Post-genesis chain columns are all non-null or the insert fails. Legacy rows are
explicitly assigned to the legacy epoch; after a scope's genesis/head exists, a
trigger forbids inserting another legacy or partially chained event. A unique
constraint on `(chain_scope, chain_epoch, chain_sequence)` and a unique event
hash prevent duplicate links. Insert triggers require sequence `head + 1` and
`previous_hash = current_head`; the event insert and guarded head update happen
in the same transaction. Ordinary application code therefore cannot append an
unchained event, duplicate a sequence, or advance the head without the matching
event row.

Recommended canonical link fields:

- chain schema version;
- project/chain ID;
- monotonically increasing sequence;
- previous event hash (explicit genesis value for sequence 1);
- complete canonical audit event identity and sanitized payload;
- current event hash.

Hash order must use sequence, not timestamp. The chained event insert, guarded
head update, domain mutation, and relevant budget/execution writes must be one
transaction.
One project chain avoids unrelated projects blocking each other conceptually,
although SQLite remains a single writer. Global events with `project_id IS NULL`
need a separate named chain.

The verifier begins at the declared genesis and recomputes canonical payloads,
sequence continuity, previous hashes, event hashes, and the final head. It must
detect a missing event/link, duplicate sequence/link, sequence gap, insertion,
deletion, reorder, changed payload, changed metadata, changed previous hash, and
changed event hash. It reports the first invalid sequence without exposing event
secrets.

Migration is non-trivial. Existing rows cannot be updated while append-only
triggers are active, and SQLite has no built-in SHA-256 usable by the current
plain-SQL migration runner. Options are:

1. begin chaining only new events and store a documented genesis marker for the
   unchained legacy prefix;
2. enhance migration execution with a trusted SHA-256 scalar/data-migration
   hook and deterministically backfill legacy events ordered by
   `(occurred_at,id)`;
3. create a signed checkpoint over the legacy prefix outside SQL.

Option 1 is the smallest but does not make legacy events tamper-evident. A fully
local unsigned chain can still be recomputed by a database owner. An external
anchor or protected signing key is necessary if the requirement includes
tampering by the local owner.

## Future migration `0014`

No `0014` is created by this assessment. A likely migration needs:

- action approval requests and immutable decisions;
- one-shot execution records;
- version-2 simulation root-identity fields (or a versioned artifact table)
  whose canonical representation and hash preserve version-1 history;
- optional execution-event records;
- batch, item, dependency, and simulated-resolution tables;
- action/connector dimensions integrated into accounting;
- rebuilt `audit_event` rows with enforceable post-genesis chain columns and an
  `audit_chain_head` guard table;
- project security-time watermark;
- new indexes and domain-mirroring triggers;
- an `action_requests` rebuild adding `execution_unknown` and replacing the M6B
  lifecycle trigger;
- descriptor/version checks permitting historical filesystem version 1 and new
  version 2 actions, with approval required for every version-2 filesystem
  mutation.

Prefer additive tables where possible, but `execution_unknown` is now fixed and
therefore `0014` must rebuild `action_requests`. The rebuild preserves the
existing reserved `approved` value for historical schema compatibility but adds
no transition through it. It must carefully recreate every M6A/M6B ownership,
immutability, JSON, timestamp, artifact, descriptor-mode, and external
agent/role guard. New triggers enforce `executing -> completed|failed|
execution_unknown`, restrict `failed` to a definite no-commit execution-ledger
outcome, and require a separately valid approval for
`approval_pending -> executing`.

Existing M6B data needs an explicit strategy:

- completed reads and failed actions remain historical;
- version-1 simulated create/write/move/delete actions remain valid history but
  are never executable; approval/execution requires a new version-2 action and
  simulation;
- existing `approval_pending` delete actions have valid artifacts but no
  approval request. They remain immutable version-1 history and cannot receive
  an executable approval; the migration must not synthesize or reinterpret an
  approval silently;
- fake actions remain policy fixtures with no executor;
- existing audit events require the selected legacy chain strategy.

The current migration runner wraps each SQL file atomically. Any data backfill
requiring SHA-256 or signatures may require a narrowly designed migration hook;
do not hide application logic in ad hoc SQL or disable foreign keys.

Rebuilding `audit_event` is also required for the fixed same-row chain coverage
invariant. Legacy rows retain IDs, payloads, and timestamps byte-for-byte and
are explicitly marked as the pre-genesis epoch. Post-genesis inserts cannot use
that epoch.

Mandatory upgrade verification eventually includes fresh M6C, populated M6B,
all legal M6B action states, historical version-1 artifacts, approvals and
executions cross-project rejection, unique one-shot leases,
`foreign_key_check=[]`, `integrity_check=ok`, and full rollback on injected
failure.

## Transaction boundaries

| Boundary | Inside one SQLite transaction | Outside transaction |
| --- | --- | --- |
| Create approval request | validate action/artifact, insert request, action CAS if needed, audit-chain append | approver presentation |
| Decide approval | reload/recompute binding and decision hash, verify security-time watermark, authenticate actor evidence through a port, insert decision, approval CAS, audit-chain append; an approved decision leaves the action `approval_pending` | interactive authentication ceremony |
| Reject/expire/invalidate approval | approval CAS, derived action CAS `approval_pending -> cancelled`, immutable event, security-time watermark, audit-chain append | notification |
| Acquire execution lease | full fresh authorization, approval/batch/hash checks, hard budget reservation, execution insert, action CAS, audit-chain append | filesystem preflight that cannot be made authoritative |
| Execute mutation | none | native descriptor-relative precondition check, mutation, fsync, postcondition collection |
| Complete definite success | execution/action CAS `executing -> completed`, usage/cost consume, audit-chain append | none |
| Record definite no-mutation failure | executor attestation, execution/action CAS `executing -> failed`, reservation release, audit-chain append | owned staging cleanup |
| Record ambiguous result | execution/action CAS `executing -> execution_unknown`, quarantine reservation/owned entries, audit-chain append | no retry or destructive cleanup without proven ownership |
| Process crash | no automatic transaction | leave `executing` observable; M6D first maps it to `execution_unknown`, never to retryable |

Filesystem preflight before lease can reject obvious stale state and avoid
unnecessary leases, but the native helper must perform the authoritative
precondition check after lease acquisition and immediately adjacent to the
mutation.

## Layering

Maintain the established direction:

```text
domain
  approval subject/decision invariants, action lifecycle, execution/batch values

connector-sdk
  trusted execution descriptor and context-free simulation/execution contracts

filesystem-connector
  filesystem preconditions, native-helper adapter, mutation/postcondition logic

application
  approval, final authorization, budget, lease, execution and batch orchestration

storage-sqlite
  project-scoped persistence, CAS, triggers, migrations and audit-chain storage

apps/daemon + apps/cli
  transport, authenticated approval adapter, stable redacted projections
```

The domain must not import connector SDK, filesystem, SQLite, Bun, CLI, or
daemon code. Application services depend on ports, not concrete SQLite or native
helpers. Connectors never receive repositories or audit writers. CLI handlers
parse and render only; they do not decide approval validity, replay, budget, or
execution state.

Suggested focused application services are:

- `RequestActionApproval`;
- `DecideActionApproval`;
- `ExpireOrInvalidateActionApproval`;
- `AcquireActionExecutionLease`;
- `ExecuteControlledMutation`;
- `CompleteActionExecution`;
- `CreateActionBatch` and `ExecuteActionBatch`;
- `VerifyAuditChain`.

A dedicated controlled-execution repository port is preferable to indefinitely
expanding the M6A capability repository. Both adapters can share the same SQLite
connection and outer `TransactionRunner` so cross-aggregate writes remain
atomic.

## Audit and redaction requirements

Approval/execution audit may include IDs, hashes, operation, risk, decision,
actor key/identity, reason codes, byte counts, budget IDs/amounts, result hashes,
and certainty classification. It must exclude:

- canonical absolute roots;
- credentials and credential references;
- raw normalized arguments;
- inline mutation content;
- complete diffs and search/read output;
- temporary/tombstone absolute paths;
- unredacted native/system error messages.

Execution and approval CLI projections need the same redaction as action show.
The diff is intentionally approver-visible but should not be copied into audit
or ordinary action list output. Whether diffs/action content require encryption
at rest or retention limits is a separate decision; M6B currently persists
both.

## Fault-injection test strategy

M6C implementation should include deterministic hooks at every boundary rather
than relying only on happy-path end-to-end tests.

### Approval and hash tests

- action hash, authorization-decision hash, artifact hash, connector version,
  operation, resource, risk, approval requirement, expiry, approval policy
  version, or batch hash substitution;
- approval decision copied across request/project/action;
- reject/approve/expire/invalidate races with at most one winner;
- decision at the exact expiry boundary;
- persisted security-time watermark across equal, forward, backward, and
  post-restart clocks;
- untrusted/self-asserted actor rejection;
- approval does not override revoked grant or disabled resource;
- create, write, move, and delete version-2 actions all enter
  `approval_pending`, and none can acquire an execution lease without a valid
  authenticated `ActionApproval`;
- medium risk for create/write/move remains visible and hash-bound while their
  independent trusted approval requirement produces `allow_with_approval`.

### Lease and replay tests

- grant revocation, expiry, resource disable, role change, connector removal,
  and stricter constraint between approval and lease;
- budget consumption between preliminary check and lease;
- two concurrent execution calls, with exactly one lease and one executor call;
- second call after completed, failed, `execution_unknown`, or interrupted
  lease;
- failure of execution-row insert, action CAS, budget reservation, audit insert,
  or chain insert rolls back the whole lease transaction;
- revocation immediately after lease follows the documented cutover.

### Filesystem adversarial tests

- registered-root rename/replacement between simulation and execution;
- registered-root bind-mount substitution and unmount/remount;
- substitution with a different root containing identical target-file bytes,
  proving that byte equality does not satisfy the root-identity binding;
- source/destination/parent replacement at every executor hook;
- intermediate symlink, magic-link, path escape, child mount, bind mount, and
  mount-substitution attempts;
- a registered root that is itself a mount root remains usable while descendants
  on other mounts are denied;
- repeated `openat2 EAGAIN` stops after the fixed tiny retry bound;
- missing `openat2`, required resolve flags, `statx` mount identity, or
  `renameat2` support fails closed without invoking a Node/Bun fallback;
- forged inputs that bypass TypeScript validation are independently rejected by
  the helper for absolute paths, NUL, dot/empty components, limits, reserved
  namespace, and invalid final basename;
- hard link introduced before the authoritative check;
- FIFO/device/socket substitution;
- destination creation race;
- source inode swap before write/move/delete;
- reserved-namespace direct access, listing, search, simulation, allowed-prefix
  traversal, and simulated-identifier resolution all fail or hide existence;
- temp/tombstone collision, hostile precreation, guessed prefix, wrong execution
  ID/random identity, and cleanup ownership mismatch;
- crash-left internal entries remain invisible to agents and unproven entries
  are never removed;
- partial write, fsync, rename, unlink, and directory-fsync failure;
- content/hash mismatch after staging;
- `O_CLOEXEC`, descriptor closure, bounded descriptor lifetime, and owned-temp
  cleanup on every injected error;
- no absolute path or content in errors/audit.

Native-helper tests should run on the explicitly supported kernel/filesystem
matrix. Unsupported platforms fail before lease acquisition.

### Crash-consistency tests

Run execution in a child process and terminate it:

- before lease commit;
- after lease and before helper call;
- after temp write/fsync;
- before and after namespace rename;
- after directory fsync and before completion commit;
- during completion/audit/accounting commit.

After restart, verify no replay, correct observable lease state, bounded owned
artifacts, transition from unfinished `executing` to `execution_unknown`, chain
integrity, reservation disposition, and conservative classification. Verify
that `failed` is impossible whenever the committing namespace point may have
been crossed or durability is ambiguous. Do not mock away the process boundary
for these cases.

### Batch and migration tests

- post-genesis audit insert without complete chain columns is rejected;
- missing/duplicate links, gaps, insertion, deletion, reorder, payload mutation,
  hash mutation, and head mismatch are detected;
- stable topological ordering, tie-breaks, cycles, duplicates, unknown edges,
  and cross-project references;
- required-dependency failure and deterministic skipping;
- simulated identifier substitution and resolution changes;
- partial batch crash without replay of completed items;
- fresh and populated M6B upgrades, legacy pending approvals, version-1
simulations, `execution_unknown`, audit genesis/backfill, FK/integrity checks,
reserved namespace rules, and rollback at each
  rebuild/backfill step.

## Recommended implementation slicing

M6C should be split into reviewable gates. Do not start later slices until the
relevant decision gate is approved.

### Slice M6C.0 — Architecture decisions and native spike

- obtain the product decision for approver authentication and same-account
  user presence;
- prototype Linux root-dirfd mutation primitives with all four `openat2` resolve
  flags, bounded `EAGAIN`, reserved internal names, and mount/bind-mount tests;
- prototype `statx` root identity using device, inode, `STATX_MNT_ID`, and
  `STATX_MNT_ID_UNIQUE` where available; prove artifact binding and rejection of
  root rename, bind-mount substitution, remount, and byte-identical replacement;
- feature-probe every required native primitive and derive the minimum supported
  Linux kernel/filesystem baseline from the selected implementation, with no
  path-based fallback;
- verify independent helper-side operand validation, parent-dirfd plus basename
  mutation calls, `O_CLOEXEC`, descriptor cleanup, and redacted errors;
- validate the fixed daemon-exclusive namespace-mutation deployment contract;
- validate at-most-once and `execution_unknown` crash semantics;
- define filesystem v2 packaging and obtain the remaining metadata-policy
  decision.

No production mutation should be enabled in this slice.

### Slice M6C.1 — Approval subject and lifecycle

- canonical approval subject/hash;
- project-scoped request and immutable decision records;
- expiry, rejection, and invalidation;
- domain/SQLite lifecycle enforcement;
- sanitized approval projections and audit events.

Every filesystem version-2 mutation remains unavailable until approver
authentication exists, irrespective of its medium or high risk level.

### Slice M6C.2 — One-shot execution ledger and dry lease

- execution envelope/hash and record;
- final fresh authorization;
- unique CAS lease and replay denial;
- no-op/dry executor for fault-injection of transaction boundaries;
- interrupted-lease observability and terminal `execution_unknown`, without
  automatic recovery or lease reacquisition.

### Slice M6C.3 — Budget and audit-chain integration

- agreed action usage/pricing dimensions;
- transaction-participating reservation;
- soft warning and hard denial;
- audit chain with selected legacy/genesis strategy;
- atomic lease/accounting/audit tests.

### Slice M6C.4 — Controlled filesystem mutation

- Linux native helper/adapter with `RESOLVE_BENEATH`,
  `RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS`, `RESOLVE_NO_XDEV`, bounded
  `EAGAIN`, statx-bound root identity, independent path validation, held parent
  dirfds, `O_CLOEXEC`, and reserved transaction namespace;
- fail-closed native feature gating against the minimum Linux baseline proven
  by M6C.0, with no Node/Bun mutation fallback;
- create first, then write/move/delete only after their identity-race semantics
  pass adversarial review;
- fsync, postconditions, redaction, and crash fault injection;
- filesystem descriptor version 2; version-1 actions remain history and must be
  requested/simulated again; all four version-2 mutations require a valid
  authenticated `ActionApproval` before execution.

Each operation can be independently gated. If conditional replacement cannot be
made safe under the approved threat model, keep that operation simulation-only.

### Slice M6C.5 — Deterministic batches

- immutable batch manifest and hash;
- dependencies and stable sequential scheduler;
- simulated identifier resolver;
- stop/skip and partial-completion semantics;
- batch approval and replay tests.

Batches should follow a proven single-action executor, not precede it.

### Slice M6C.6 — Daemon/CLI and end-to-end hardening

- daemon-backed request/decide/execute/status commands;
- authenticated actor evidence and stable error mapping;
- no stack/root/content disclosure;
- full simulate/approve/execute workflow without agent-runtime integration;
- migration and platform matrix validation.

## Decisions now recommended/fixed

1. **Dedicated approval authority:** use a project-scoped `ActionApproval`
   aggregate; M5 governance approval and `ActionRequest.status` are not approval
   authorities.
2. **Exact security binding:** bind action payload hash, a new canonical
   authorization-decision hash, simulation artifact hash, risk, approval
   requirement, descriptor identity/version, expiry, and optional batch hash.
3. **Separate execution ledger:** persist one immutable-bound execution attempt
   per action with composite ownership and a unique one-shot constraint.
4. **At-most-once execution:** acquire one final lease, never automatically
   expire, steal, or reacquire it, and never replay an interrupted attempt.
5. **Explicit uncertainty:** add `execution_unknown`; only allow
   `executing -> completed|failed|execution_unknown`, with `failed` restricted
   to executor-attested no-namespace-mutation outcomes.
6. **Approval/action lifecycle separation:** an approved `ActionApproval` leaves
   the action `approval_pending`; only the final lease transaction may perform
   `approval_pending -> executing`. Terminal non-executability is a
   transactionally coupled `cancelled` projection.
7. **Connector version:** real mutation execution uses filesystem version 2.
   Version-1 actions/artifacts remain valid history and must be requested and
   simulated again before approval/execution.
8. **Native direction:** run a Linux Rust/N-API root-dirfd spike before enabling
   production mutation.
9. **Mount containment:** use `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`,
   `RESOLVE_NO_MAGICLINKS`, and `RESOLVE_NO_XDEV`; a registered root may be a
   mount root, but child mount/bind-mount crossings are denied. `EAGAIN` has one
   immediate retry at most, then fails closed.
10. **Reserved transaction namespace:** staging and tombstones use an
    unpredictable/exclusive AI Office namespace denied from every ordinary
    connector and agent surface; cleanup removes only provably owned entries.
11. **Concurrent-writer contract:** controlled execution requires
    daemon-exclusive namespace mutation authority for affected directories. It
    does not promise conditional replacement safety against a hostile process
    with simultaneous rename/unlink authority.
12. **Lease cutover:** revocation/disablement before lease commit blocks;
    changes after commit do not cancel an in-flight syscall and affect future
    actions.
13. **No multi-file atomicity:** batches are deterministic and one-shot per
    item, but partial completion is observable and no general rollback is
    claimed.
14. **Clock rollback floor:** persist a project security-time watermark and
    reject security operations whose wall time is earlier than the floor.
15. **Audit coverage invariant:** chain fields live on every post-genesis
    `audit_event`; schema/triggers enforce one complete chain identity per event
    and contiguous guarded head advancement.
16. **Approval for every filesystem mutation:** the initial filesystem
    version-2 descriptor requires an authenticated `ActionApproval` for create,
    write, move, and delete. Their risk remains medium/medium/medium/high;
    approval-free filesystem mutation is deferred to a future reviewed and
    appropriately versioned policy.
17. **Root identity binding:** every filesystem version-2 simulation artifact
    binds a lossless Linux root identity containing device major/minor, inode,
    and the selected statx mount identity. Execution requires an exact match;
    root replacement or remount makes the simulation stale.
18. **Independent native validation:** the Rust helper treats TypeScript and IPC
    input as untrusted, repeats path and reserved-namespace checks, validates the
    final basename, and commits through held parent dirfds with tightly scoped
    `O_CLOEXEC` descriptors.
19. **No weak native fallback:** missing `openat2` policy, statx mount identity,
    `renameat2` semantics, or another required Linux primitive makes mutation
    execution unsupported. M6C.0 derives the supported baseline empirically;
    Node/Bun path-based mutation is never substituted.

## Decisions still requiring product approval

1. **Approver authentication and user presence:** owner-only local operator
   assumption versus signed/WebAuthn-like approval, including how an agent under
   the same OS account is excluded.
2. **Action budget semantics:** monetary connector pricing versus work/byte/
   operation quotas, applicable scopes, soft threshold, and reservation handling
   for `execution_unknown`.
3. **Metadata preservation:** fixed safe mode/ownership versus a versioned,
   explicitly approved portable metadata subset.
4. **Audit external anchoring:** local genesis only, protected signing key, or
   external checkpoint; this determines which privileged tampering is detectable.
5. **Delete tombstone retention:** retention duration, quarantine location,
   inspection, operator cleanup, and treatment after `execution_unknown`.
6. **Batch continuation:** global stop-on-first-failure versus deterministic
   continuation of independent branches after required-dependency failure.
7. **Stored mutation content:** retention, encryption, access control, and
   deletion policy for inline content and complete simulation diffs.

Until approver authentication is chosen and the fixed Linux/native spike passes
the root-identity, native-feature, mount, race, ownership, and crash fault tests,
real filesystem mutation is not implementation-ready.

## Recommended outcome of this assessment

Proceed next with M6C.0 only: obtain the product decision on approver trust and
run the disposable Linux/native spike under the fixed containment,
root-identity, independent-validation, no-fallback, daemon-exclusive namespace,
reserved-name, and `execution_unknown` contracts. Approval/hash and one-shot
ledger work can then proceed without enabling mutations. If authentication or
the native spike is deferred, keep all filesystem mutations simulation-only and
do not represent M6C as controlled execution complete.

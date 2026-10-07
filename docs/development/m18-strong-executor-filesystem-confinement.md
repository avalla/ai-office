# M18 — Strong Executor Filesystem Confinement

Status: planned. This is a delivery plan, not an implemented capability. No
confinement provider, policy model or run root exists yet. The authoritative
milestone, requirement, task, task→requirement and task-dependency records live
in the AI Office Runtime; this document explains them.
Project milestone ID: `f298f414-f793-46f5-ad87-761a5fd115d0`.

## Why this milestone exists

PR #94 added the bounded Codex CLI worker and established, with the real
audited `codex-cli` 0.160.0, that restrictions applied by or through the
executor client do not give filesystem-read confidentiality. The client's
built-in `apply_patch` reads its target before the read-only sandbox refuses
the write, and its answer tells the model whether a host path exists, whether
it is readable, whether it is a file or a directory, whether a guessed whole
line is present, whether guessed lines are adjacent and in order, whether a
guess matches the end of the file, and whether the file is valid UTF-8. No
arbitrary content extraction was demonstrated. No supported client setting
removes the tool, and the calls are invisible to the Runtime. The evidence and
the worker's stated non-guarantees are in
[agent runtime](agent-runtime.md#filesystem-no-writes-no-read-confidentiality)
and `tests/integration/codex-apply-patch-oracle.test.ts`.

The objective of M18 is the boundary the client cannot provide:

> An executor can observe only filesystem paths explicitly exposed to that run
> by AI Office.

For a run that requires strong confinement, paths outside the allowed
namespace are not readable, their existence is not distinguishable, guessed
content reveals no host state, and the host HOME, projects, configuration and
secrets are absent from the executor's filesystem view. The boundary is built
by the Runtime around the executor process. It does not depend on Codex,
Claude Code, model prompts or client feature flags.

## Position and boundaries

M18 takes the next roadmap identifier after M17. Roadmap numbers record when a
milestone was planned, not a strict execution order: M18 depends only on the
existing bounded `WorkerRuntime` port (ADR-0017) and the two bounded workers,
so it can start before M12–M17 complete. It is a prerequisite for enabling
autonomous repository-write Developer roles in M14.

- **M10** hardens the hostile same-UID process, path-namespace races, approval
  presence and audit integrity for controlled *mutations*. M18 confines what an
  *executor* can read and where it can write. M18 does not make the Runtime
  host a boundary against another process of the same user, and it does not
  replace the controlled-action path: protected mutations still cross
  `request -> simulate -> inspect -> approve -> execute`.
- **M12** owns the complete worker-runtime port and adapter substitution. M18
  adds a confinement seam beneath the existing port and must be revised
  against whatever M12 has delivered when SFC-02 starts.
- **M16** owns pack contracts. Packs and roles *request* confinement
  capabilities (GP-16 is the request mechanism); the generic Runtime resolves
  them. No pack implements confinement.
- **M17** observes executor sessions. A hook or session never asserts a
  confinement level; SFC-11 records what the Runtime itself enforced.

## Architecture

Confinement is generic core. There is no Codex-specific Bubblewrap logic, no
Claude-specific Seatbelt logic and no development-pack filesystem security.

```text
Task / Stage / Role        (may request confinement capabilities)
        |
        v
     AgentRun
        |
        v
  Runtime admission  ── requested capability
        |               × provider capability (detected, attested)
        |               = effective admitted policy, or WORKER_UNAVAILABLE
        v
  Run filesystem root (Runtime-owned)
        |
        v
  ConfinementProvider port (application)
        |-- Linux native: Bubblewrap + namespaces
        |-- macOS native: Seatbelt or equivalent, at its real level
        `-- OCI container: Docker, Podman or another runtime
        |
        v
  Executor process (Codex, Claude Code, future)
```

Expected placement, to be confirmed by SFC-01 and SFC-02 against the code at
that time: level and policy value objects and the resolution rule in
`packages/domain`; the provider port, admission and run-root lifecycle in
`packages/application`; providers as infrastructure adapters composed by
`packages/runtime-host`; `packages/agent-runtime` workers consume an already
admitted policy and launch through the provider. The dependency direction
`apps/adapters -> application -> domain` is unchanged.

### Requested, provider and effective

Three records stay distinct:

1. **Requested capability**: what a role, stage or pack asks for, in terms of
   guarantees, never implementation flags.
2. **Provider capability**: what a provider detected on this host can enforce,
   established by detection and attestation, not by the presence of a binary.
3. **Effective admitted policy**: the resolved policy a run actually executed
   under, which becomes provenance.

The request is expressed by dimension. The shape below is illustrative; SFC-02
fits it to the existing capability and worker contracts.

| Dimension | Values to distinguish |
| --- | --- |
| filesystem confidentiality | none, strong |
| filesystem write | unrestricted, none, explicit mounts only |
| workspace | none, read_only |
| temporary state | shared host, private |
| credentials | ambient, explicit run copy |
| process | unowned, owned, owned with PID namespace |
| environment | inherited, explicit |
| network (optional) | unrestricted, provider-only |

### Confinement levels

Proposed machine-readable levels. Each includes the guarantees of the one
before it, and each is defined by enforcement the Runtime owns outside the
client. SFC-01 accepts or revises the names and definitions.

| Level | Guarantee |
| --- | --- |
| `none` | No confinement guarantee. |
| `process_owned` | The Runtime owns the executor's process tree and ends it, including detached children, on completion, cancellation and timeout within a bounded wait. Nothing about the filesystem. Requires the SFC-REQ-15 behavior; no current worker provides it. |
| `write_restricted` | The provider prevents writes outside explicitly writable mounts. Reads are not restricted. |
| `filesystem_confidential` | The "strong" level: only explicitly exposed paths are observable, and outside paths are indistinguishable. Includes private temp, explicit credentials and explicit environment. |

A restriction enforced by the client is recorded as client-enforced and never
raises the level. On that rule the current workers classify as follows until
they are migrated: both bounded workers are `none`. The Codex worker
additionally records a client-enforced read-only sandbox with no read
confidentiality, and the Claude worker records model-visible tool isolation.
Neither reaches `process_owned`: the process-group wait is unbounded where the
Runtime is not the reaper of orphans, and a process that starts a new session
is not owned (`agent-runtime.md`). They become `process_owned` only after
SFC-REQ-15 bounded detached-child handling is implemented and verified. Process
ownership (the Runtime ends the tree) and process isolation (a PID namespace)
are separate dimensions. A filesystem level does not provide either on its own;
`process_owned` is reached only through a verified provider, for confined runs.

### Fail-closed admission

A run whose required level has no available, verified provider fails with
`WORKER_UNAVAILABLE` before task content is dispatched and before any
executor process receives credentials. The Runtime does not run unconfined,
does not fall back to a client sandbox, does not reduce the level, does not try
another worker, and does not treat an installed executor as proof of
confinement support.

### Per-run filesystem root

The Runtime owns one root per AgentRun and constructs the executor's view from
it. Names inside the namespace are logical and independent of host paths.

| Logical path | Meaning | Default |
| --- | --- | --- |
| `/input` | explicit immutable input artifacts | read-only, empty |
| `/workspace` | optional repository or project mount | absent |
| `/output` | controlled artifact destination | writable, private |
| `/credentials` | minimal materialized executor credentials | owner-only, run copy |
| `/tmp` | private run-local temporary state | writable, private |
| `/cache` | optional Runtime-owned cache, never a repository path | absent |

Nothing is exposed because it exists. Hidden by default: the Runtime user's
HOME and other homes; SSH, Git, cloud and package-registry credentials;
unrelated repositories and AI Office projects; host `/tmp`, `/var` and
`/etc` beyond the minimum the provider documents; the operator's Codex and
Claude configuration; agent skills and instructions; other AgentRun roots;
Runtime secrets. Provenance records logical mount identities rather than host
paths.

Two profiles frame the range:

- **Analysis-only**: private HOME, private executor config home, private tmp,
  credential copy only, no repository, no writable host mount, provider
  networking as required. This is the target strong mode for the bounded Codex
  worker.
- **Development**: `/workspace` read-only, a selected `/cache`, `/output`,
  and the build tools the policy names, with the rest of the host invisible.
  The executor reads the repository and proposes changes; every repository
  mutation still crosses the controlled-action gateway
  (`request -> simulate -> inspect -> approve -> execute`) and is performed by
  the Runtime outside the executor namespace. A read-write `/workspace` would
  let the executor mutate the repository without an action, simulation,
  approval, execution-time revalidation or audit record, so it is not a value
  this plan defines. Admitting one is an architecture change that requires a
  revised accepted ADR first. M18 makes this profile expressible and testable;
  enabling repository-editing roles is M14 scope.

### Credentials, environment, process

Source operator credentials stay outside the namespace. The Runtime
materializes a minimal copy per run with owner-only permissions, never shares
a mutable credential directory between runs, never falls back to the operator
HOME, and removes the copy on every terminal outcome. The seam must admit
future Runtime-owned credentials. The Codex admission rules from PR #94
(personal-plan allowlist, refresh block, expiry margin, re-read before copy)
are unchanged.

The executor environment remains the one AI Office builds. Sandbox tools and
container images add their own defaults; those are enumerated and removed or
documented, never assumed safe.

Confinement composes with process ownership: children and detached children
end with the run, within a bounded wait, using a PID namespace where the
provider supports one. This is where the unbounded process-group wait recorded
from PR #94 (the Runtime as reaper of orphans) is resolved for confined runs.

### System metadata

`/proc`, `/sys`, device nodes, machine identity files, hostname, the mount
table and the process list can reveal host facts without any file read. Each
provider exposes the minimum the executor needs and documents what remains.
Residual metadata is stated separately from the filesystem confidentiality
guarantee and does not weaken or extend it.

### Path escape

Mount sources are canonicalized and validated before a provider sees them.
Symlinked sources or destinations, `..` traversal, bind-mount escape,
case-insensitive collisions, overlapping mount roots and host aliases must not
widen visibility; an exposed path never exposes a broader parent. A policy
that is ambiguous or overlapping is refused at admission.

### Stale run roots

PR #94 left a documented limitation: an abrupt Runtime host death can leave
temporary run state behind. Recovery identifies AI Office-owned run roots by
an ownership marker, distinguishes an active run from an abandoned one against
authoritative run state, removes stale credentials and run-local state, unmounts any surviving mount
point without traversing it, never follows symlinks while deleting, never
deletes anything outside an owned root, and records the cleanup as an audit
event. It follows the existing run-recovery contract (ADR-0016) and does not
resume or complete a run.

### Provenance

Each real external execution records provider, provider version, policy
version, requested level, effective level, logical mounts and capabilities,
workspace access mode, and whether enforcement was actually active. Secret
credential paths and unnecessary host paths are not persisted. Executions that
predate the record show confinement as not recorded; nothing is inferred
retroactively. The effective record is the machine-readable attestation later
admission decisions use, for example filesystem confidentiality, write scope,
host process access, credential scope and native delegation.

## Providers

**Linux native (SFC-04).** Bubblewrap with mount and user namespaces, a PID
namespace, private tmp, explicit binds, read-only binds for system libraries
and certificates, a hidden host filesystem and HOME, minimal `/proc` and
devices, an explicit working directory and an owned process tree. It needs no
root and no sudo, and fails closed if `bwrap` or a required namespace is
unavailable. Kernel and sysctl requirements (for example unprivileged user
namespaces and distribution AppArmor restrictions on them) are documented by
the task from tested hosts.

**macOS native (SFC-05).** Evaluate Seatbelt, the availability and behavior of
`sandbox-exec` and any equivalent native API on supported macOS versions:
explicit read roots, explicit write roots, default deny, private temp,
credential isolation and provider networking. No parity with Linux is assumed.
A deny profile that still lets a probe tell a missing path from a forbidden
one does not meet SFC-REQ-02; in that case the provider registers a lower
level, the container provider supplies strong mode, and strong-required runs
fail closed where neither is available.

**OCI container (SFC-06).** A runtime-neutral port with Docker, Podman or
another OCI runtime behind it; Docker is not a core abstraction. Ephemeral
environment, explicit mounts, no host HOME, no host root filesystem, no host
PID namespace, no privileged container, private temp, explicit environment,
credential injection, controlled network, deterministic cleanup and process
ownership.

**Windows (SFC-13).** Not implemented in M18. Detection reports strong
confinement as unsupported, strong-required runs fail closed, and the
assessment records the future provider as follow-up.

## Requirements

All requirements are `proposed` and belong to M18. Keys are stable.

| Key | Title | Verifiable requirement |
| --- | --- | --- |
| SFC-REQ-01 | Explicit filesystem visibility | Under the strong level, the executor process tree can open, stat or list only paths exposed by the admitted policy's logical mounts. Every exposed host path derives from an explicit Runtime policy entry or from the provider baseline: the minimum system libraries, certificates, device and process metadata a provider needs to start the executor. The provider declares that baseline in its capability record and it is recorded in provenance with the admitted mounts. The baseline is read-only, never overlaps the hidden-by-default set (HOME and other homes, credentials, repositories, other run roots, Runtime secrets), passes the SFC-REQ-07 canonicalization and overlap checks, and is never wider than the minimum each provider documents under SFC-04, SFC-05 and SFC-06; a baseline that fails any of these is refused at admission. Device and process metadata in the baseline are residual metadata under SFC-REQ-16. Nothing is exposed merely because it exists on the host. Verified by enumerating the namespace from inside a real backend and comparing it with the admitted mount list plus the declared provider baseline. |
| SFC-REQ-02 | Outside paths indistinguishable | From inside strong confinement, a host path outside the namespace produces the same observable result whether or not it exists on the host and whatever its type, permissions or content. Existence, type, access-state and guessed-content probes reveal no host state. Verified with paired synthetic fixtures (present/absent, matching/non-matching) on every provider that claims the level. |
| SFC-REQ-03 | No silent downgrade | When the confinement a run requires cannot be enforced by an available, verified provider, admission fails with WORKER_UNAVAILABLE before task content is dispatched and before any executor process receives credentials. No unconfined run, client-sandbox fallback, lower-level substitution or other-worker substitution occurs, and an installed executor never implies confinement support. |
| SFC-REQ-04 | Per-run isolation | Every external AgentRun admitted at any Runtime-enforced level above `none` receives its own run root, namespace and credential copy; runs that do not require confinement keep their existing behavior under SFC-REQ-19 and are not forced through a provider. Concurrent runs, including runs of the same executor, model and provider, cannot observe each other's workspace, temporary state, credentials or unpublished output. |
| SFC-REQ-05 | Credential confinement | Operator source credentials stay outside the executor namespace. Only a minimal, explicitly materialized per-run copy with owner-only permissions is visible; no mutable credential directory is shared between runs; there is no fallback to the operator HOME; the copy is removed on every terminal outcome; the materialization seam admits future Runtime-owned credentials. |
| SFC-REQ-06 | Workspace access policy | Repository or workspace exposure is an explicit policy value none \| read_only, mounted at a logical executor path independent of the host path. read_only is enforced by the provider, not by the client. No run receives a workspace by default; A read-write workspace is not a defined value: repository mutation stays on the controlled-action path. Cache and output mounts are separate explicit entries. |
| SFC-REQ-07 | Path escape resistance | Symlinked mount sources and destinations, '..' traversal, non-canonical paths, bind-mount escape, case-insensitive path collisions, overlapping mount roots and host aliases cannot widen visibility. Mount sources are canonicalized and validated before use, an exposed path never exposes a broader parent tree, and an ambiguous or overlapping policy is refused at admission. A cache source is Runtime-owned storage outside every repository and workspace path, with a stated access mode (per-run writable, or shared read-only); a writable cache is never shared between runs, only the Runtime fills a shared read-only cache and never from executor output, and a cache source inside a repository or workspace is refused. |
| SFC-REQ-08 | Deterministic cleanup | Success, failure, cancellation and timeout each remove the run's private state. After an abrupt Runtime host death, recovery identifies only AI Office-owned run roots by an ownership marker, safely distinguishes active from abandoned runs, removes stale credentials and run-local state, unmounts any surviving mount point without traversing it, never follows symlinks while deleting, never deletes a path outside an owned root, and records an auditable cleanup event. |
| SFC-REQ-09 | Confinement provenance | Every real external execution records confinement provider, provider version, policy version, requested level, effective level, logical mounts, the provider baseline and capabilities, workspace access mode and whether enforcement was actually active. No secret credential path or unnecessary host path is persisted. Executions that predate the record report confinement as not recorded; it is never inferred. |
| SFC-REQ-10 | Executor neutrality | Codex, Claude Code and future executors obtain confinement through one generic policy and provider port owned by the core. No executor adapter contains provider-specific sandbox logic, and no second executor-specific security architecture exists. |
| SFC-REQ-11 | Historical oracle regression | With the real audited Codex CLI under strong confinement, apply_patch probes against synthetic fixtures outside the namespace (nonexistent path, existing path, guessed line, correct line, symlink) return indistinguishable answers. The test touches no real host secret and fails if any probe distinguishes host state. |
| SFC-REQ-12 | Real backend verification | A platform or provider is reported as supporting a level only when real OS or container backend tests exercising that guarantee ran and passed in CI or in a named dedicated security validation environment. Fake-executor tests alone never support a claim, and a skipped confinement test is reported as unverified, not as passed. |
| SFC-REQ-13 | Machine-readable confinement levels | Versioned levels with precise semantics distinguish at least: no guarantee; process ownership and cancellation only; Runtime-enforced filesystem write restriction; strong filesystem confidentiality. Requested capability, provider capability and effective admitted policy are distinct records. A client-enforced restriction is never counted as Runtime-enforced, and the current bounded Codex and Claude workers stay classified at their actual level until migrated. |
| SFC-REQ-14 | Explicit executor environment | The confined process environment is exactly the one AI Office constructs. Nothing is inherited from the Runtime host, the sandbox tool or a container image default; variables a provider injects are enumerated and either removed or documented. |
| SFC-REQ-15 | Process boundary composition | Strong confinement composes with an owned process tree: children and detached children are terminated on completion, cancellation and timeout within a bounded wait, using a PID namespace where supported, and the unbounded process-group wait recorded from PR #94 is resolved for confined runs. Process isolation is reported as its own capability and is never implied by filesystem confinement. |
| SFC-REQ-16 | Bounded system metadata | Exposure of /proc, /sys, devices, machine identity files, hostname, mount table and process list is reduced to what the executor needs; host processes are not listed where a PID namespace is supported. Unavoidable residual metadata is documented per provider, separately from the filesystem confidentiality guarantee. |
| SFC-REQ-17 | Platform capability truthfulness | Each provider reports the level it actually enforces on the detected host. macOS native confinement is reported at a lower level if it cannot reliably meet strong; Windows reports strong as unsupported until a tested provider exists; no cross-platform parity is claimed; strong-required runs fail closed wherever the level is unsupported. |
| SFC-REQ-18 | Core-resolved pack requests | Roles, stages and domain packs can only request confinement capabilities through the generic contract. The Runtime resolves a request against provider capability into the effective policy; a request never grants a capability or resource. Development, legal and manufacturing example requests are test-supplied fixtures that resolve through the same generic path with no pack-specific confinement code; wiring pack-declared requests is outside M18 and follows pack execution (M16.5). |
| SFC-REQ-19 | Staged rollout without downgrade | Strong confinement is opt-in when introduced and leaves existing executions unchanged. Documented phases lead to requiring it for autonomous repository-write roles before those roles are enabled. A delegated child run's policy must be equal to or narrower than its parent's (contract only; delegation is not implemented). No phase permits a silent downgrade. |
| SFC-REQ-20 | Decision record and operator documentation | ADR-0029 is accepted or revised; the threat model states assets, trust boundaries, actors, guarantees and non-guarantees; operator documentation for host setup, kernel and sysctl requirements, dependencies, failure modes and troubleshooting matches delivered behavior; roadmap and architecture documents claim only delivered guarantees. |

## Delivery graph and tasks

Dependencies between SFC tasks are stored as typed task-dependency edges in
the Runtime; inputs from other milestones are plan references only. Task keys
are title prefixes. Every task is `pending`.

```text
SFC-01 threat model + ADR
  → SFC-02 policy model
      → SFC-03 run root
          → SFC-07 discovery + admission
              ├→ SFC-04 Linux   ┐
              ├→ SFC-05 macOS   ├→ SFC-10 adversarial suite ┐
              ├→ SFC-06 OCI     ┘        ↑                  │
              ├→ SFC-11 provenance → SFC-08 Codex, SFC-09 Claude (need SFC-04)
              └→ SFC-13 Windows assessment                  │
SFC-04..06 + SFC-08 + SFC-09 → SFC-12 operator docs         │
SFC-10 + SFC-11 + SFC-12 + SFC-13 → SFC-14 rollout gates and exit
```

| Task | Depends on | Linked requirements (SFC-REQ-) | Acceptance and review artifact |
| --- | --- | --- | --- |
| SFC-01 — Threat model and confinement contract | ADR-0017, PR #94 evidence, M12 worker port, ADR-0026 | 03, 10, 13, 15, 16, 18, 20 | Accept or revise ADR-0029 with assets, trust boundaries, threat actors, confinement levels, guarantees, non-guarantees, provider abstraction and admission semantics; classify the current bounded Codex and Claude workers; record rejected alternatives. No product change. |
| SFC-02 — Confinement policy model | SFC-01 | 01, 05, 06, 10, 13, 14, 18 | Versioned machine-readable request, provider-capability and effective-policy contracts in domain/application with no OS, container or executor import: filesystem capabilities, logical mount specs, workspace modes, credential exposure, environment, process and optional network requirements. Deterministic resolution and rejection tests. No provider. |
| SFC-03 — Per-run filesystem root | SFC-02 | 01, 04, 05, 06, 07, 08 | Runtime-owned run root with input, workspace, output, credentials and tmp (optional cache), ownership marker, owner-only modes, mount-source canonicalization and overlap validation, lifecycle and cleanup on every terminal outcome, and audited stale-root recovery after host death. Fault-injection tests; nothing outside an owned root is deleted; a cache source inside a repository or workspace is refused and a writable cache is not shared between runs. |
| SFC-04 — Linux Bubblewrap provider | SFC-03, SFC-07 | 01, 02, 04, 06, 07, 12, 14, 15, 16 | Unprivileged bwrap provider: mount and user namespaces, PID namespace, private tmp, explicit and read-only binds, hidden host filesystem and HOME, minimal /proc, devices and system libraries, explicit working directory, owned process tree. Fails closed without bwrap or required namespaces; no root or sudo; kernel and sysctl requirements documented; real-backend tests. |
| SFC-05 — macOS provider | SFC-03, SFC-07 | 01, 02, 04, 06, 07, 12, 14, 15, 16, 17 | Evaluate Seatbelt, sandbox-exec availability and behavior, and equivalent native APIs on supported macOS versions: explicit read and write roots, default deny, private temp, credential isolation, provider networking. Report the level actually enforced, including existence indistinguishability; if strong is not reliably met, register a lower capability and fail closed for strong. Real-backend tests. |
| SFC-06 — OCI container provider | SFC-03, SFC-07 | 01, 02, 04, 06, 07, 12, 14, 15, 16, 17 | Runtime-neutral OCI port with at least one implementation (Docker or Podman): ephemeral environment, explicit mounts, no host HOME, root filesystem or PID namespace, private temp, explicit environment, credential injection, controlled network, unprivileged container, deterministic cleanup and process ownership. Docker is not a core abstraction. Real-backend tests. |
| SFC-07 — Capability discovery and admission | SFC-02, SFC-03 | 01, 03, 07, 13, 17, 18, 19 | Confinement provider port, host detection, capability attestation, requested-versus-effective comparison and fail-closed admission with WORKER_UNAVAILABLE before dispatch; opt-in selection that leaves existing runs unchanged; unsupported platforms report it. Unix-socket end-to-end tests with a deterministic test provider. |
| SFC-08 — Codex worker integration | SFC-04, SFC-07, SFC-11 | 05, 10, 11, 14 | The bounded Codex worker runs under the analysis-only strong profile (private HOME, config home and tmp, credential copy only, no repository, no writable host mount, provider networking) through the generic abstraction. Auth admission, refresh protection, single-model admission, native delegation denial and CLI pinning are unchanged. The real-CLI apply_patch oracle regression passes. |
| SFC-09 — Claude Code integration | SFC-04, SFC-07, SFC-11 | 05, 10, 14 | The Claude Code worker uses the same policy, provider port and run root as Codex with no Claude-specific security architecture; its login is exposed only as an explicitly materialized run credential; existing tool isolation and provenance are unchanged. |
| SFC-10 — Adversarial confinement suite | SFC-04, SFC-05, SFC-06, SFC-08, SFC-09 | 01, 02, 04, 05, 07, 08, 11, 12, 15, 16 | Per-provider adversarial tests on synthetic fixtures: absolute-path, HOME, sibling repository, sibling AgentRun and credential probing; symlink escape; '../' traversal; mount overlap; procfs probing; detached child; temp leakage; crash cleanup; concurrent run isolation; cache source inside a repository and cross-run cache poisoning; the apply_patch oracle. Dedicated Linux, macOS and container CI jobs or a named security validation environment; skipped means unverified. |
| SFC-11 — Runtime observability and provenance | SFC-07 | 09, 13 | Forward migration and read surfaces record and show provider, provider version, policy version, requested and effective level, logical mounts, workspace mode and enforcement state for each real execution, with no secret or unnecessary host path. Historical runs show confinement as not recorded. Fresh and upgrade tests; SQLite and PostgreSQL where the run record lives. |
| SFC-12 — Operator installation and deployment | SFC-04, SFC-05, SFC-06, SFC-08, SFC-09 | 12, 20 | Tested operator documentation: host setup and dependencies per provider, kernel and sysctl requirements, capability detection output, failure modes, troubleshooting and the validation environment used for each platform claim. Documents match commands and tests. |
| SFC-13 — Windows confinement assessment (deferred) | SFC-07 | 03, 17 | Capability detection reports strong confinement as unsupported on Windows and strong-required execution fails closed there. A written assessment records candidate mechanisms and the future Windows provider as explicit follow-up. No Windows provider is implemented in this milestone. |
| SFC-14 — Rollout gates and milestone exit | SFC-10, SFC-11, SFC-12, SFC-13 | 03, 12, 19, 20 | Documented rollout phases with their gates; strong confinement recorded as a prerequisite for autonomous repository-write roles; the parent-or-narrower rule for delegated runs recorded as a contract; roadmap, architecture and ADR status updated to delivered behavior; every SFC requirement has verification evidence before milestone completion. |

### Requirement coverage

| Requirement | Tasks |
| --- | --- |
| SFC-REQ-01 | SFC-02, SFC-03, SFC-04, SFC-05, SFC-06, SFC-07, SFC-10 |
| SFC-REQ-02 | SFC-04, SFC-05, SFC-06, SFC-10 |
| SFC-REQ-03 | SFC-01, SFC-07, SFC-13, SFC-14 |
| SFC-REQ-04 | SFC-03, SFC-04, SFC-05, SFC-06, SFC-10 |
| SFC-REQ-05 | SFC-02, SFC-03, SFC-08, SFC-09, SFC-10 |
| SFC-REQ-06 | SFC-02, SFC-03, SFC-04, SFC-05, SFC-06 |
| SFC-REQ-07 | SFC-03, SFC-04, SFC-05, SFC-06, SFC-07, SFC-10 |
| SFC-REQ-08 | SFC-03, SFC-10 |
| SFC-REQ-09 | SFC-11 |
| SFC-REQ-10 | SFC-01, SFC-02, SFC-08, SFC-09 |
| SFC-REQ-11 | SFC-08, SFC-10 |
| SFC-REQ-12 | SFC-04, SFC-05, SFC-06, SFC-10, SFC-12, SFC-14 |
| SFC-REQ-13 | SFC-01, SFC-02, SFC-07, SFC-11 |
| SFC-REQ-14 | SFC-02, SFC-04, SFC-05, SFC-06, SFC-08, SFC-09 |
| SFC-REQ-15 | SFC-01, SFC-04, SFC-05, SFC-06, SFC-10 |
| SFC-REQ-16 | SFC-01, SFC-04, SFC-05, SFC-06, SFC-10 |
| SFC-REQ-17 | SFC-05, SFC-06, SFC-07, SFC-13 |
| SFC-REQ-18 | SFC-01, SFC-02, SFC-07 |
| SFC-REQ-19 | SFC-07, SFC-14 |
| SFC-REQ-20 | SFC-01, SFC-12, SFC-14 |

Every requirement has at least one task and every task has at least one
requirement.

## Adversarial tests

All fixtures are synthetic and created by the test outside the executor's
allowed namespace. No test reads a real host secret.

**Historical `apply_patch` oracle (SFC-REQ-11).** With the real audited
Codex CLI under strong confinement, repeat the PR #94 probes against outside
fixtures: nonexistent path, existing path, guessed line, correct line, and a
symlink to a fixture. The answers must not distinguish whether the fixture
exists or whether a guess matches. The existing recorded-answer test keeps
pinning the unconfined behavior of the audited version.

**Suite (SFC-10).** Absolute-path probe against a synthetic `/etc/passwd`
equivalent; HOME probing; sibling repository; sibling AgentRun; credential
probing; symlink escape; `../` traversal; mount overlap; procfs probing;
detached child; temp leakage; crash cleanup; concurrent run isolation; cache source inside a repository or workspace and cross-run cache poisoning; a provider baseline that overlaps the hidden set or is writable.

## CI

- **Linux**: a job that runs the real Bubblewrap provider.
- **macOS**: a job that runs the real native provider.
- **Container**: an OCI-provider job where the runner supports it.

A confinement test that is skipped is reported as unverified, and a platform
with unverified tests is not called supported. Where public runners cannot
exercise a guarantee (for example restricted user namespaces or no nested
containers), SFC-10 names a dedicated security validation environment and
SFC-12 documents it. Standard tests still call no paid provider; the real
Codex regression runs only in the environment that has an audited CLI and a
test login.

## Rollout

Strong confinement is not required for current executions when it is
introduced.

1. provider abstraction and policy model;
2. capability detection and attestation;
3. opt-in strong mode;
4. migrate the bounded Codex worker;
5. migrate the Claude Code worker;
6. require strong mode for autonomous repository-editing roles;
7. make strong mode the default where supported.

No phase permits a silent downgrade. Phases 6 and 7 change defaults and are
decided when their gates in SFC-14 are met, not by this plan.

## Relationship to autonomous development

Production autonomous Developer agents depend on M18 for a read-only
`/workspace` view in which everything else on the host is invisible. Their
repository writes remain controlled actions executed by the Runtime, not
direct writes by the executor. Delegated or hierarchical agents must inherit or narrow the parent
policy; a child AgentRun never receives broader filesystem access than its
parent, and no Runtime policy can widen it. M18 records that rule
as a contract. It does not implement child delegation.

## Exit

A run that requires `filesystem_confidential` is admitted only with a verified
provider and otherwise fails before dispatch; under it the real Codex and
Claude workers see only their run root; the oracle regression and the
adversarial suite pass on each platform claimed; provenance shows the
effective policy; stale roots are recovered; operator documentation matches
tested hosts.

## Non-goals

- implementing confinement in this planning change;
- Codex-, Claude- or pack-specific confinement logic;
- a boundary against another process of the Runtime user, or other M10 scope;
- replacing controlled actions, approvals or capability grants;
- child delegation, governed sub-agents or per-agent executor routing;
- enabling repository-editing Developer execution (M14);
- a Windows provider;
- microVM or distributed sandboxing;
- network egress enforcement beyond the optional provider-only mode a
  provider can attest;
- requiring strong confinement for every existing execution.

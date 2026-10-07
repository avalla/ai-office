# ADR-0029: Executor confinement and filesystem trust boundary

- Status: Proposed; SFC-01 must accept or revise before implementation
- Date: 2026-10-04
- Scope: M18 planning, compatible with ADR-0014/0016/0017/0019/0026/0027

## Context

ADR-0017 introduced bounded external workers whose limits are applied through
the executor client: flags, configuration and a private temporary directory.
It states that this is model-visible tool isolation, not process-level
resource isolation.

PR #94 added the bounded Codex CLI worker and measured what that leaves open.
With the real audited `codex-cli` 0.160.0 under the worker's exact flags, the
built-in `apply_patch` tool reads its target before the client's read-only
sandbox refuses the write. Its answer to the model distinguishes a missing
path, an unreadable path, a directory, a non-UTF-8 file, a guessed line that
is absent and a guessed line that is present; several guessed lines confirm
adjacency and order, and an end-of-file marker confirms the last line. No
arbitrary content extraction was demonstrated. The tool is offered because
provider-supplied model metadata declares it; no supported setting removes it;
the client emits no output item for these calls, so the Runtime cannot see
them. The worker therefore documents that it gives no filesystem-read
confidentiality (see
[agent runtime](../development/agent-runtime.md#filesystem-no-writes-no-read-confidentiality)).

The general finding is that a client's tool set, sandbox mode and metadata are
controlled by the client and its provider and can change without a change the
Runtime can detect. A confidentiality guarantee cannot rest on them.

## Proposed decision

1. **The boundary is outside the client.** Filesystem confidentiality for an
   executor is enforced by an operating-system or container boundary that the
   Runtime constructs around the executor process. Client sandbox modes,
   feature flags and prompts remain defence in depth and are never the
   guarantee.
2. **Confinement is generic core.** One confinement policy model and one
   application `ConfinementProvider` port serve every executor. Providers are
   infrastructure adapters. No executor adapter embeds provider-specific
   sandbox logic, and no domain pack implements confinement. Packs and roles
   request capabilities; the Runtime resolves them; a request grants nothing.
3. **Requested, provider and effective are separate.** A request states
   guarantees by dimension (filesystem confidentiality, write scope,
   workspace access, temp, credentials, process, environment, optional
   network). A provider capability is what detection and attestation show a
   provider can enforce on this host. The effective admitted policy is what a
   run executed under.
4. **Levels are precise and Runtime-enforced.** Proposed ordered levels:
   `none`; `process_owned` (the Runtime owns and ends the process tree);
   `write_restricted` (the provider prevents writes outside explicit writable
   mounts); `filesystem_confidential` (only explicitly exposed paths are
   observable and outside paths are indistinguishable). A client-enforced
   restriction never raises the level. The current bounded Codex and Claude
   workers are `none`, with their client-enforced restrictions recorded
   separately, until bounded detached-child handling (SFC-REQ-15) makes them
   `process_owned` for confined runs. Process ownership and process isolation
   are separate dimensions, and a filesystem level provides neither on its
   own.
5. **Admission fails closed.** If the required level has no available,
   verified provider, the run fails with `WORKER_UNAVAILABLE` before dispatch.
   There is no unconfined run, no client-sandbox fallback, no level reduction
   and no substitution of another worker. An installed executor is not
   evidence of confinement support.
6. **The Runtime owns a per-run filesystem root.** The executor's view is
   built from logical mounts (`input`, `workspace`, `output`, `credentials`,
   `tmp`, optional `cache`); everything else on the host is absent by default,
   apart from a per-provider baseline the provider declares and provenance
   records. The baseline is read-only, stays outside the hidden-by-default set
   and passes the same path validation as any mount.
   A cache source is Runtime-owned storage outside any repository or
   workspace path, never writable across runs.
   Workspace access is `none` or `read_only`; repository mutation stays on the controlled-action path. Credentials are a
   minimal per-run copy. The environment is the one AI Office constructs.
   Mount sources are canonicalized and overlapping or ambiguous policy is
   refused. Stale roots left by a host crash are recovered by ownership marker
   and authoritative run state, with an audit event.
7. **Providers report what they enforce.** Linux native uses Bubblewrap and
   namespaces without root. macOS native is evaluated and registered at the
   level it reliably enforces, which may be below strong. An OCI container
   provider sits behind a runtime-neutral port. Windows reports strong as
   unsupported. No cross-platform parity is claimed.
8. **Effective confinement is provenance.** Each real execution records
   provider, provider version, policy version, requested and effective level,
   logical mounts, workspace mode and whether enforcement was active, without
   secret or unnecessary host paths. Earlier executions are recorded as not
   recorded, never guessed.
9. **Claims need real backends.** A level is claimed for a platform only when
   tests against the real OS or container backend ran and passed, in CI or in
   a named security validation environment. A skipped test is unverified.
10. **Rollout is staged.** Abstraction, detection, opt-in strong mode, Codex
    migration, Claude migration, requirement for autonomous repository-write
    roles, then default where supported. No phase permits a silent downgrade.
    A delegated child run's policy is equal to or narrower than its parent's.

## Native versus container providers

| | Native (bwrap, Seatbelt) | Container (OCI) |
| --- | --- | --- |
| Host dependency | small, often present; no daemon | a container runtime and images |
| Privilege | unprivileged; depends on user-namespace policy | rootless possible; daemon models vary |
| Start cost | low | higher; image management |
| Executor toolchain | host binaries exposed read-only | image must carry or mount them |
| Portability | per-OS implementation and semantics | one model across hosts that have a runtime |
| Risk | kernel and distribution restrictions; macOS API status | image provenance; daemon is a privileged component |

Neither is preferred globally. Linux native is the first strong provider
because it needs no daemon and no image; the container provider is the strong
option where a native provider cannot meet the level.

## Decision gates for SFC-01 and SFC-02

- Confirm level names, ordering and the per-dimension request against the
  existing capability, worker-port and provenance contracts, including what
  M12 has delivered by then.
- Decide where the policy and resolution rule live (domain) and where the
  provider port and run-root lifecycle live (application), and how a worker
  adapter receives an admitted policy without importing a provider.
- State the threat model: assets, trust boundaries, actors (model following
  injected task content, executor client, provider), guarantees and
  non-guarantees, and the residual system metadata per provider.
- Decide how a pack or role request maps onto the contract without becoming a
  grant. Pack-declared requests are wired after pack execution (M16.5).
- Decide the persisted provenance shape and its storage parity obligations.
- Decide how the unbounded process-group wait recorded from PR #94 is bounded
  for confined runs.

## Consequences and exclusions

This is a proposed boundary, not an implemented provider, policy or run root.
Strong confinement adds host dependencies and platform-specific behavior; some
hosts will be unable to run strong-required work and will fail closed rather
than run it weakly. It does not make the Runtime host a boundary against
another process of the same user (M10), does not replace controlled actions or
grants, does not implement delegation, and does not enable repository-editing
execution, which remains M14 scope and depends on this boundary. ADR-0017
remains accurate for the workers as they are today.

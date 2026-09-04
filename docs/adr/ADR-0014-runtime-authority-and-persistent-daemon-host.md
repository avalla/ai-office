# ADR-0014: Separate Runtime authority from the persistent daemon host

- Status: Accepted
- Date: 2026-08-30

## Context

AI Office has one authoritative local process for mutable project state,
controlled actions, pipelines, runs, and audit. The first implementation called
that process and much of the surrounding architecture “the daemon.” This
blurred three distinct concepts:

- application authority and long-lived orchestration semantics;
- the current persistent local process and Unix-socket transport;
- client adapters such as the CLI, Codex, Claude Code, and future APIs.

The daemon is valuable because it owns mutable state, serializes concurrent
clients, and can keep workers, schedulers, retries, pipelines, connectors, and
event processing alive after a client exits. Its owner-only socket does not
authenticate one same-UID process against another. Executable names, TTY state,
protocol markers, and claimed identities cannot repair that limitation.

## Decision

The **AI Office Runtime** is the single application authority for stateful and
persistent AI Office operations. The local daemon is its current persistent
host and Unix IPC is its current client transport.

```text
CLI / Codex / Claude / future clients      apps/cli
                 |
           RuntimeClient                   packages/application
                 |
          local IPC transport
                 |
        PersistentRuntimeHost              apps/daemon
                 |
          AiOfficeRuntime                  packages/application
                 |
        ApplicationRuntime                 packages/runtime-host
                 |
 application services, policy, pipelines, connectors, audit, SQLite
```

Authoritative command execution and its composition belong to the Runtime, not
to a client, so they live in `@ai-office/runtime-host` rather than in
`apps/cli`. `apps/daemon` depends on that package and on application ports;
`apps/cli` holds the client adapter, the IPC client, offline-only operations,
and presentation. `apps/daemon` must never import `apps/cli`, and an
architecture test enforces it. `RuntimeClient` lives with the Runtime contract
in `packages/application` because every local client adapter implements the same
port.

The Runtime contract excludes transport request IDs, protocol versions, socket
paths, PID/process lifecycle, and serialization. The version-1 daemon protocol
remains compatible and the host maps it to Runtime commands.

Authoritative mutation never falls back transparently to an embedded Runtime or
direct SQLite access. If the persistent Runtime host is unavailable, stateful
commands fail with an actionable error. Exactly one selected Runtime owns
authoritative writes.

Offline behavior is narrow and explicit: help, `status --offline`, and the
exact-plan `runtime:purge` operation while the Runtime is stopped. Ordinary
`status` retains its existing read-only degraded inspection when the host is
unreachable for compatibility. Offline inspection may attest local repository
identity and deterministic client artifacts; it cannot claim authoritative
project, manifest, pipeline, task, run, policy, or audit state.

Offline inspection also cannot claim knowledge about the host it chose not to
contact. Three states are distinct and must stay distinct: the host was
contacted and answered, the host was contacted and failed, and the host was
deliberately not contacted. Reporting the third as the second is a false claim
about evidence, so project lifecycle status schema version 4 adds `not_checked`
to `runtime.daemon` and `runtime.authoritativeState`, and `unverified` to
`health`. Every value understood by version 3 keeps its meaning and clients
accept versions 2, 3, and 4. `status --offline` reports `not_checked` and never
recommends starting a Runtime; only the degraded fallback after a failed request
reports `unreachable` and recommends starting one.

`status` exit codes are the same in both modes: `0` when nothing needing
attention was found in what was actually inspected, `1` when a problem was found
or the repository is not installed.

Runtime-first lifecycle syntax is additive. `ai-office runtime start` and
`ai-office runtime status` are preferred; `ai-office daemon` and
`ai-office daemon:health` remain compatibility aliases. Stop/restart commands
are not introduced until a real service supervisor exists.

The Runtime is an authority inside AI Office, not an authentication or process-
isolation boundary against the local Unix user. AI Office remains trusted-local
and single-user. A same-UID shell-capable process can reach the same local
administrative interfaces unless a future worker sandbox or authenticated
human-presence boundary provides stronger isolation.

## Rejected alternatives

### Transparent embedded fallback

Rejected. A CLI-opened database could compete with the persistent owner and
bypass serialization, provenance, lifecycle audit, persistent work, and fresh
authorization orchestration.

### Rename every daemon symbol and protocol field

Rejected. Audit event names, schema fields, protocol types, filenames, and
public TypeScript exports carry compatibility value. Compatibility aliases and
clear boundaries communicate the new model without a flag-day rewrite.

The compatibility those aliases provide is stated rather than assumed.
`DaemonClient`, `DaemonUnavailableError`, `OfficeDaemon`, and
`DaemonAlreadyRunningError` are identity aliases of their Runtime-first names,
never subclasses or wrappers, so `instanceof` holds in both directions and no
parallel error hierarchy exists. Version-1 protocol behaviour and audit event
names are unchanged. `error.name`, `constructor.name`, and message text are
explicitly outside that contract: they now read in Runtime terms.

### One typed Runtime method per current CLI command

Deferred. The existing command contract already fronts application services.
Creating a second facade for every operation would duplicate a large surface
without changing authority. Typed API/MCP adapters can call application use
cases behind the same Runtime boundary as those adapters become real.

## Consequences

- clients do not access authoritative SQLite state directly;
- relative local filesystem semantics belong to the invoking client context; a
  persistent Runtime host must never infer client cwd from its own process cwd.
  Clients resolve caller-local path arguments against their own working
  directory before IPC, and the Runtime rejects a caller-local path that arrives
  relative instead of guessing. A path interpreted inside a root the caller
  already supplied as an absolute argument keeps its root-relative meaning;
- multiple clients share policy, provenance, lifecycle, and audit rules;
- work that must outlive a client remains in the persistent Runtime host;
- daemon IPC and process management remain replaceable infrastructure;
- version-1 socket/protocol, database schemas, existing commands, and security
  invariants remain unchanged;
- future in-process hosting is possible only as an explicit deployment mode
  with exclusive authority, never as availability fallback.

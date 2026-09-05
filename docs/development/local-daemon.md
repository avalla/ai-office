# Persistent local Runtime host (daemon)

Milestone M2 moves authoritative project access behind one local process. The
application authority is the **AI Office Runtime**; the daemon is its current
foreground local hosting mechanism. See ADR-0014.

```text
CLI / Codex / Claude / future clients
              -> RuntimeClient
              -> Unix IPC
              -> persistent daemon host
              -> AiOfficeRuntime
              -> application services and authoritative state
```

This persistence provides one mutable-state owner, concurrent-client
serialization, long-running work, centralized policy/provenance/audit, and a
home for workers, schedulers, pipelines, retries, connectors, and events. It
does not authenticate the local Unix user to itself.

## Lifecycle

The source-linked entry point selects a stable user Runtime home and can be
started from any directory after explicit operational opt-in
(`AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1`):

```bash
ai-office runtime start
```

`ai-office daemon` remains a compatibility alias. Both commands run the host in
the foreground; there is no service supervisor-backed stop/restart command yet.

It uses `AI_OFFICE_HOME` when explicitly set and otherwise `~/.ai-office`.
Development commands retain an explicit checkout-local compatibility mode:

```bash
bun run daemon
```

The persistent host:

- opens and migrates `<runtime-home>/project.sqlite`;
- removes an unreachable stale `<runtime-home>/daemon.sock`;
- refuses to start when a healthy daemon already owns the socket;
- creates the Unix socket with owner-only permissions;
- stops accepting new requests on SIGINT or SIGTERM;
- drains active requests before removing the socket and closing SQLite.

The linkable `ai-office` entry point resolves the same data and socket paths
regardless of distribution checkout or current repository. Moving or relinking
the program therefore does not select a new office. The legacy Bun development
commands and `dev:daemon` / `dev:cli` derive
`<source-checkout>/.ai-office` from their executable location, including global
memory, regardless of cwd or the user `AI_OFFICE_HOME`. Importing a different source repository does not move the
database or socket into that repository. Coding
client commands independently target their explicit `--root`; client
integration files there do not belong to the daemon runtime root unless the two
paths coincide.

## Source-distribution maintenance

`ai-office update [--approve <plan-hash>] [--json]` remains local to the source
executable's distribution. It is an offline lifecycle operation relative to
Runtime authority, though it uses Git network transport and a health preflight.
It checks the selected user home and that distribution's development home;
`AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE` is not required for these minimal
`GET /health` presence checks. Any listener or uncertain probe blocks planning
and apply. The check never opens SQLite or enables `/commands` or `/api` access.

Stop both relevant hosts and keep them stopped during maintenance. Checks are
point-in-time, not a startup lock. Custom homes selected in other terminals are
not discoverable and must be handled explicitly. See
[ADR-0011](../adr/ADR-0011-source-linked-program-update.md) for exact coverage,
approval binding, failure semantics, and trust assumptions. Restart a host only
after a complete update; its normal startup handles forward migrations.

`ai-office --help`, `ai-office help`, and `ai-office -h`, including the development
entry point, return shared command-support help before runtime path resolution,
IPC, SQLite, Git, or updater planning.

## Local protocol

The transport is HTTP over a Unix domain socket. No TCP port is opened.

```text
GET  /health
POST /commands
GET  /api/*        # read-only query surface
GET  /api/events   # invalidation stream
```

`/commands` is the command side and is unchanged. `/api` is a separate,
separately versioned read-only contract used by the operational dashboard; it
accepts `GET` only and adds no mutation path. See the
[operational dashboard](dashboard.md).

Requests and responses carry `protocolVersion: 1` and a caller-generated
`requestId`. The daemon validates requests before dispatch and returns captured
stdout, stderr, exit status, and optional interactive prompt metadata.
Requests are limited to 64 KiB, 64 arguments, and bounded argument/prompt sizes.
Protocol errors carry a stable code and never expose stack traces. Commands have
a server-side timeout in addition to the client timeout.

The production CLI is a Runtime client whose current transport is this daemon
protocol. Help remains available while the host is stopped; stateful product
commands return an actionable error instructing the user to run
`ai-office runtime start`. `runtime:purge` is the narrow destructive lifecycle
exception: it runs locally because it destroys the database that normally owns
command authority, refuses to operate while a healthy host is reachable, and
requires approval of the exact current purge-plan hash.

`status --offline` is the explicit read-only local path. Ordinary `status`
retains its compatible degraded behavior when the host is unavailable; neither
form mutates authoritative state. The CLI inspects the repository binding before
protocol dispatch and reports the portable repository identity separately from
an `unverified` runtime association, with repository-local client inspection
where possible. Deterministic host pointers and skills can still be classified
as missing, unmanaged, conflicting, or drifted. The manifest-derived
`AI-OFFICE.md` body cannot be attested without authority, so an otherwise intact
client integration is `unverified`. Identity existence and host reachability are
separate facts.

The two offline paths differ in what they know, and status schema version `4`
lets them say so:

| | host contacted | `runtime.daemon` | `runtime.authoritativeState` | `health` | issue |
| --- | --- | --- | --- | --- | --- |
| clean `status --offline` | no | `not_checked` | `not_checked` | `unverified` | `runtime_not_checked` (warning) |
| `status` with the host down | yes, and it failed | `unreachable` | `unavailable` | `needs_attention` | `daemon_unavailable` (error) |

A host that was never contacted is not a host proved unreachable, so explicit
offline inspection never emits `daemon_unavailable` and never tells the operator
to start a Runtime that may already be running. Only the degraded fallback,
which has evidence, does.

Explicit offline inspection parses the same `status [path] [--offline] [--json]`
grammar as ordinary `status`, before any request is made: unknown options,
repeated `--offline` or `--json`, and a second positional path are rejected as
usage errors without contacting the Runtime.

`status` exit codes mean the same thing in both modes: `0` when nothing needing
attention was found in what was actually inspected — `healthy` online,
`unverified` offline — and `1` when a problem was found or the repository is not
installed. Locally observed drift, conflicts, detected missing/unmanaged client
integration, and invalid bindings produce `needs_attention` and exit 1 even
when host and authoritative state remain `not_checked`. Online and offline
status share the application client-attention classifier; `runtime_not_checked`
alone never causes failure.

## Client-relative filesystem context

The host is persistent: it was started once, from some directory, and keeps
running while clients come and go from unrelated repositories. Its process
working directory therefore says nothing about what a client meant by a relative
path.

> Relative local filesystem semantics belong to the invoking client context; a
> persistent Runtime host must never infer client cwd from its own process cwd.

The CLI resolves every caller-local path argument against its own working
directory before building a request — the `install`/`status`/`next`/`uninstall`
and `project:import` paths, `project:backup --output`, the `project:restore`
archive and `--root`, `office:apply`/`office:validate --file`, `agent:sync
--directory`, and `client:* --root`. The shared `packages/command-support`
contract requires omitted caller-cwd defaults to be materialized too. The Runtime
refuses missing lifecycle/import paths, restore `--root`, sync `--directory`,
and relative caller-local paths, so
bypassing the client boundary fails loudly instead of answering about the wrong
directory. Handlers have no caller-cwd fallback.

Manifest containment is enforced by the Runtime on canonical file and root
paths, retaining regular-file and 256 KiB checks. `office:apply --project` uses
local checkout roots recorded for that project, rejecting outside absolute paths
and symlink escapes. `office:validate --file` accepts `--root`, defaulted by
the CLI to caller cwd and required at Runtime entry. Its nearest binding/Git root
is the boundary; without either, that explicit directory is the boundary.
A descendant invocation can therefore read a manifest at project root. Invalid
bindings fail closed, and the host composition root never selects eligibility.

Two things stay outside that rule: a path interpreted inside a root the caller
already supplied as an absolute argument, such as `client:plan --contract`
relative to `--root`, and a string that merely looks like a path, such as a task
title. Protocol version 1 is unchanged, because resolution happens before the
request exists.

For project-scoped commands without `--project`, the linkable CLI discovers the
nearest valid binding from its current working directory and appends that
project ID before protocol dispatch. Explicit `--project` always wins. Invalid
bindings fail closed rather than falling back to path or project-name
heuristics.

## Serialization and audit

Short commands enter an in-memory FIFO promise queue. `run:tick`, the current
long-running execution boundary, is dispatched outside that global queue so it
cannot structurally block unrelated commands. `run:schedule` remains a short
queued command that creates the run and lock before returning its ID. A failed
command does not block later commands. SQLite writes remain inside the existing short
application transactions; filesystem scans and user input remain outside them.
Portable `project:backup` and `project:restore` commands use the same daemon
boundary. Archive validation, source scanning, manifest assembly, and archive
file I/O happen outside SQLite transactions. A consistent semantic-state read
plus revision-observation update, and restored semantic-state changes, use
short application-owned transactions. Archive publication is a separate
no-clobber filesystem outcome: a failed write does not invalidate the observed
revision, and an identical retry reuses it.

The append-only `audit_event` table records daemon lifecycle and command
outcomes. Command arguments and answers are deliberately excluded from event
payloads so secrets are not copied into the audit trail.

## Current limitations

- Unix domain sockets target macOS and Linux; Windows named pipes are not yet supported.
- The daemon is foreground-only; service installation and background supervision are future work.
- AI Office is trusted-local and single-user. Owner-only socket permissions
  limit accidental cross-account access but do not authenticate one same-UID
  process against another. Executable names, TTY ownership, and protocol fields
  are not authentication. A same-UID shell-capable worker can reach the same
  administrative surface until stronger worker isolation or authenticated
  human presence exists.
- The Runtime host opens no TCP port. `ai-office dashboard` runs a separate
  foreground loopback host that serves the console and forwards `/api/*` to this
  socket; the port is released when that command stops. Its `Host` check blocks
  DNS rebinding and its per-process session token bars blind access, but the
  token travels in the opened URL, so it is not a secret from other local
  accounts; it authenticates no human and separates no same-UID process.
- Interrupted agent runs and expired budget reservations are discoverable and
  recoverable, but recovery is explicit: restart does not silently retry runs,
  remove worktrees, or finalize accounting records.

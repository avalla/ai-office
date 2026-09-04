# Local daemon

Milestone M2 moves authoritative project access behind one local process.

## Lifecycle

The normal installed entry point selects a stable user runtime home and can be
started from any directory:

```bash
ai-office daemon
```

It uses `AI_OFFICE_HOME` when explicitly set and otherwise `~/.ai-office`.
Development commands retain an explicit checkout-local compatibility mode:

```bash
bun run daemon
```

The daemon:

- opens and migrates `<runtime-home>/project.sqlite`;
- removes an unreachable stale `<runtime-home>/daemon.sock`;
- refuses to start when a healthy daemon already owns the socket;
- creates the Unix socket with owner-only permissions;
- stops accepting new requests on SIGINT or SIGTERM;
- drains active requests before removing the socket and closing SQLite.

The linkable `ai-office` entry point resolves the same data and socket paths
regardless of distribution checkout or current repository. Moving or relinking
the program therefore does not select a new office. The legacy Bun development
command derives `<cwd>/.ai-office` deliberately. Importing a different source repository does not move the
database or socket into that repository. Coding
client commands independently target their explicit `--root`; client
integration files there do not belong to the daemon runtime root unless the two
paths coincide.

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

The production CLI is a daemon client. Help remains available while the daemon
is stopped; stateful product commands return an actionable error instructing
the user to run `bun run daemon`. `runtime:purge` is the narrow lifecycle
exception: it runs locally because it destroys the database that normally owns
command authority, refuses to operate while a healthy daemon is reachable, and
requires approval of the exact current purge-plan hash.

`status` is the other local-aware exception, but it is not a stateful command.
The CLI inspects the repository binding before protocol dispatch. If the daemon
is unavailable, it returns schema-version `3` status with the portable
repository identity reported separately from an `unverified` runtime
association, authoritative state unavailable, and repository-local client
inspection where possible. Deterministic host pointers and skills can still be
classified as missing, unmanaged, conflicting, or drifted. The manifest-derived
`AI-OFFICE.md` body cannot be attested without authority, so an otherwise intact
client integration is `unverified`. Identity existence and daemon reachability
are separate facts.

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
- Authentication relies on local filesystem permissions and the owner-only socket mode.
- The daemon opens no TCP port. `ai-office dashboard` runs a separate foreground
  loopback host that serves the console and forwards `/api/*` to this socket;
  the port is released when that command stops. Its `Host` check blocks DNS
  rebinding and its per-process session token bars blind access, but the token
  travels in the opened URL, so it is not a secret from other local accounts; it
  authenticates no human and separates no same-UID process.
- Interrupted agent runs and expired budget reservations are discoverable and
  recoverable, but recovery is explicit: restart does not silently retry runs,
  remove worktrees, or finalize accounting records.

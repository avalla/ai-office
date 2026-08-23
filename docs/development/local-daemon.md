# Local daemon

Milestone M2 moves authoritative project access behind one local process.

## Lifecycle

Start the daemon from the intended runtime root. In a simple setup this may be
the repository being managed, but that is not required:

```bash
bun run daemon
```

The daemon:

- opens and migrates `.ai-office/project.sqlite`;
- removes an unreachable stale `.ai-office/daemon.sock`;
- refuses to start when a healthy daemon already owns the socket;
- creates the Unix socket with owner-only permissions;
- stops accepting new requests on SIGINT or SIGTERM;
- drains active requests before removing the socket and closing SQLite.

The linkable `ai-office` entry point pins the runtime to its
source/distribution checkout, so `ai-office install .` and `ai-office status`
can be invoked from another repository while reaching the same office daemon.
The legacy Bun development command derives the runtime root from its current
working directory. Importing a different source repository does not move the
database or socket into that repository. Coding
client commands independently target their explicit `--root`; client
integration files there do not belong to the daemon runtime root unless the two
paths coincide.

## Local protocol

The transport is HTTP over a Unix domain socket. No TCP port is opened.

```text
GET  /health
POST /commands
```

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
is unavailable, it returns schema-version `1` status with the binding marked
`unverified`, authoritative state unavailable, and repository-local client
inspection where possible. Binding existence and daemon reachability are
reported as separate facts.

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

The append-only `audit_event` table records daemon lifecycle and command
outcomes. Command arguments and answers are deliberately excluded from event
payloads so secrets are not copied into the audit trail.

## Current limitations

- Unix domain sockets target macOS and Linux; Windows named pipes are not yet supported.
- The daemon is foreground-only; service installation and background supervision are future work.
- Authentication relies on local filesystem permissions and the owner-only socket mode.
- Interrupted agent runs and expired budget reservations are discoverable and
  recoverable, but recovery is explicit: restart does not silently retry runs,
  remove worktrees, or finalize accounting records.

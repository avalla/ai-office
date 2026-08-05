# Local daemon

Milestone M2 moves authoritative project access behind one local process.

## Lifecycle

Start the daemon from the project root:

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
is stopped; stateful commands return an actionable error instructing the user
to run `bun run daemon`.

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

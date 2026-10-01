# Persistent Agent Knowledge deployment

This guide configures optional, secondary `AgentKnowledgeStore` on one machine.
SQLite or PostgreSQL remains authoritative for projects, tasks, runs, reviews,
approvals and audit. SurrealDB stores only scoped advisory knowledge. This guide
uses SurrealDB **3.3.0**, the version pinned by the dedicated restart CI job.
Install that version using the [official installation instructions](https://surrealdb.com/docs/running/installation),
then check `surreal version`. The test job runs the server with persistent
SurrealKV storage and verifies knowledge after a full process restart.

## Start a persistent local SurrealDB server

Use a dedicated, owner-only data directory and bind to `127.0.0.1:8000`.
`memory` loses records on restart. The [SurrealDB start reference](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/start)
documents `surrealkv://data` as a path relative to the process working
directory. Do not switch storage backends in the same directory.

Run the following setup in Bash (`bash` on macOS) to create the server's
protected password file.
Use a unique password; the input is neither an argument nor written into a
service definition. Do not run these commands with shell tracing enabled.

```bash
umask 077
mkdir -p "$HOME/.config/ai-office-surrealdb" "$HOME/.local/share/ai-office-surrealdb"
chmod 700 "$HOME/.config/ai-office-surrealdb" "$HOME/.local/share/ai-office-surrealdb"
read -rsp 'SurrealDB root password: ' AK_PASSWORD
printf '\n'
printf '%s' "$AK_PASSWORD" > "$HOME/.config/ai-office-surrealdb/root-password"
unset AK_PASSWORD
chmod 600 "$HOME/.config/ai-office-surrealdb/root-password"
```

Create `~/.config/ai-office-surrealdb/start` with this content. Replace the
absolute `surreal` path with the result of `command -v surreal`, then `chmod 700`
the wrapper. It deliberately keeps the password out of argv and the service
definition. The server still runs in the user's trust domain.

```sh
#!/bin/sh
set -eu
SURREAL_USER=root
SURREAL_PASS="$(cat "$HOME/.config/ai-office-surrealdb/root-password")"
export SURREAL_USER SURREAL_PASS
exec /absolute/path/to/surreal start --bind 127.0.0.1:8000 surrealkv://data
```

On Linux, save this user unit as
`~/.config/systemd/user/ai-office-surrealdb.service`:

```ini
[Unit]
Description=Local SurrealDB for AI Office Agent Knowledge
[Service]
Type=simple
WorkingDirectory=%h/.local/share/ai-office-surrealdb
ExecStart=%h/.config/ai-office-surrealdb/start
Restart=on-failure
[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload`, then
`systemctl --user enable --now ai-office-surrealdb.service`. Use
`systemctl --user restart ai-office-surrealdb.service` after changing its
wrapper or server credential. A user service starts after login; on a headless
machine, configure systemd lingering deliberately if it must run before login.

On macOS, save this LaunchAgent as
`~/Library/LaunchAgents/com.ai-office.surrealdb.plist`, replacing both
`/Users/you` occurrences with the absolute home path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ai-office.surrealdb</string>
  <key>ProgramArguments</key><array><string>/Users/you/.config/ai-office-surrealdb/start</string></array>
  <key>WorkingDirectory</key><string>/Users/you/.local/share/ai-office-surrealdb</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Run `launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.ai-office.surrealdb.plist"`.
Restart with `launchctl kickstart -k gui/$(id -u)/com.ai-office.surrealdb`;
inspect with `launchctl print gui/$(id -u)/com.ai-office.surrealdb`.
LaunchAgents run in the logged-in user session, not before login.

Check `curl --fail http://127.0.0.1:8000/health` before configuring AI Office.
The server's root account is supplied by its protected wrapper. AI Office's
connection initializes the selected namespace and database if needed; the
examples below use `ai_office` and `knowledge`.

## Configure the managed AI Office Runtime

Set `AI_OFFICE_HOME` to the same absolute home used by `ai-office service
install` (the default is `~/.ai-office`):

```bash
export AI_OFFICE_HOME="${AI_OFFICE_HOME:-$HOME/.ai-office}"
mkdir -p "$AI_OFFICE_HOME"
```

The file is JSON with exactly these
fields; it contains no username or password:

```json
{
  "provider": "surrealdb",
  "endpoint": "ws://127.0.0.1:8000",
  "namespace": "ai_office",
  "database": "knowledge",
  "tenantId": "local-office"
}
```

Write it to `<AI_OFFICE_HOME>/agent-knowledge.json` and set mode `0600`.
`tenantId` is mandatory
for SQLite and must be a trusted, stable identifier; do not derive it from a
model or repository path. **Omit `tenantId` for PostgreSQL**: the Runtime uses
its authoritative storage tenant and rejects a duplicate managed value. The
endpoint accepts loopback `ws://` or authenticated `wss://` without URL userinfo.
An absent file disables knowledge; invalid JSON, extra keys, wrong types and
invalid values are `misconfigured`. The file must be a regular file, not a
symlink, and no larger than 8 KiB.

Create two protected credential files. This reuses the owner-only loader and
its byte validation from the provider credential store, while leaving the
registered LLM provider-name allowlist unchanged. The `credential` command
therefore does **not** write or inspect these two names. A value must be 1–4096
visible ASCII bytes without whitespace; the directory must be owned by the
Runtime user and mode `0700`, and each file must be owned by that user and mode
`0600`.

```bash
umask 077
mkdir -p "$AI_OFFICE_HOME/credentials"
chmod 700 "$AI_OFFICE_HOME/credentials"
printf '%s' root > "$AI_OFFICE_HOME/credentials/AI_OFFICE_SURREALDB_USERNAME"
cp "$HOME/.config/ai-office-surrealdb/root-password" \
  "$AI_OFFICE_HOME/credentials/AI_OFFICE_SURREALDB_PASSWORD"
chmod 600 "$AI_OFFICE_HOME/credentials/AI_OFFICE_SURREALDB_USERNAME" \
  "$AI_OFFICE_HOME/credentials/AI_OFFICE_SURREALDB_PASSWORD"
```

Run `ai-office service install`, then `ai-office service status`. The generated
Runtime unit or plist carries only `AI_OFFICE_HOME` and the non-secret
`AI_OFFICE_AGENT_KNOWLEDGE_SOURCE=runtime_home` marker. It ignores any
`AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER` or `AI_OFFICE_SURREALDB_*` values in the
installing shell or service-manager environment. Reinstalling replaces outdated
definitions and preserves `agent-knowledge.json` and `credentials/`. After a
configuration or credential change, restart only the AI Office Runtime:

```bash
systemctl --user restart ai-office-runtime.service          # Linux
launchctl kickstart -k gui/$(id -u)/com.ai-office.runtime   # macOS
```

`ai-office runtime status` checks host availability. The daemon `/health`
endpoint reports only `knowledge.provider` and the startup observation
`knowledge.startup`; for example:

```bash
curl --silent --unix-socket "$AI_OFFICE_HOME/daemon.sock" \
  http://localhost/health | jq '.knowledge'
```

`disabled` means no selected provider; `misconfigured` means a selected file,
tenant or credential is missing, malformed or insecure; `unavailable` means a
valid configuration could not connect or authenticate (including a wrong
password). `connected` means startup connected. The observation is not a live
probe: restart the Runtime after fixing an outage. Both failure states leave
SQLite/PostgreSQL authority available. Existing `/health` and `service status`
show the safe operational state; a separate `knowledge:status` command is not
needed for AK-09. Inspect file presence and permissions locally to diagnose
`misconfigured`; no endpoint, username, password or secret-derived value is
included in Runtime diagnostics, errors or generated views.

To verify worker retrieval, admit a memory from a completed real worker run
using `knowledge:plan` and reviewed `knowledge:admit`, schedule a task whose
literal retrieval term matches it, and inspect `run:show` for the scoped
knowledge reference. A connected store does not bypass admission review.

Foreground `ai-office runtime start` retains the AK-03 environment variables
documented in [native knowledge](agent-knowledge.md). It never reads these
Runtime-home files without the managed source marker. Unset foreground provider
remains disabled. No ambient secret is copied into a file automatically.

## Backup, restore and upgrade

Back up the selected namespace/database with the
[SurrealDB export command](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/export).
Use a protected output directory and pass credentials through the process
environment rather than command arguments. The export contains knowledge text
and provenance and should be handled as sensitive data.

```bash
umask 077
SURREAL_USER=root \
SURREAL_PASS="$(cat "$HOME/.config/ai-office-surrealdb/root-password")" \
surreal export --endpoint http://127.0.0.1:8000 \
  --namespace ai_office --database knowledge \
  "$HOME/knowledge-backup.surql"
```

Restore with [SurrealDB import](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/import)
into a **fresh** namespace/database, then change the managed JSON, restart the
Runtime and verify known IDs with `knowledge:trace` and a worker retrieval.
Imports commit statement by statement, so do not retry a partially imported
target in place. An export from SurrealDB 3.3.0 includes the `OPTION IMPORT`
line required by its import endpoint. Keep the original database until the
restored scope and provenance have been checked.

Before upgrading SurrealDB, export a backup, record `surreal version`, stop the
SurrealDB service, and follow the [official version migration guidance](https://surrealdb.com/docs/build/migrating/from-old-surrealdb-versions/2x-to-3x)
for the source and target versions. Start the target version against a copied
data directory or restore into a fresh database; verify `/health`, AI Office
`knowledge.startup`, `knowledge:trace` and scoped worker retrieval before
retiring the old data. Do not assume a changed binary can safely open an old
data directory in place. A SurrealDB outage or failed upgrade affects advisory
knowledge only; the authoritative Runtime remains available.

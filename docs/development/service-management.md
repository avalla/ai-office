# Native service management

`ai-office service` installs the AI Office Runtime host and the read-only
dashboard as **per-user operating-system services**, so they are supervised and
restarted by the platform instead of held open by two terminals.

```bash
ai-office service install
ai-office service status
ai-office service uninstall
```

The public interface is exactly those three commands. `start`, `stop`,
`restart`, and `logs` are deliberately not part of it; the platform tools below
already do those jobs and are documented instead of wrapped.

## What it is not

Installing services does not create a privilege, operator, or security
boundary, and it does not change the trust model recorded in
[ADR-0014](../adr/ADR-0014-runtime-authority-and-persistent-daemon-host.md) and
the [dashboard threat model](dashboard.md#threat-model):

- services are **per-user**; nothing runs as root and nothing is installed
  system-wide;
- **no privilege escalation.** AI Office never runs `sudo`, and never asks the
  platform to;
- the dashboard stays bound to `127.0.0.1`, and the Runtime still opens no TCP
  port — it keeps its owner-only Unix socket;
- `systemd --user` and `launchd` supervise processes. They do not separate
  same-UID principals, so a supervised Runtime is exactly as reachable by other
  processes of the same user as a foreground one;
- installation is always an explicit operator action. `ai-office install`,
  onboarding, and `ai-office update` never install services implicitly.

## Platforms

| Platform | Mechanism              | Location                  |
| -------- | ---------------------- | ------------------------- |
| Linux    | `systemd --user`       | `~/.config/systemd/user/` |
| macOS    | `launchd` LaunchAgents | `~/Library/LaunchAgents/` |

Linux:

```text
~/.config/systemd/user/ai-office-runtime.service
~/.config/systemd/user/ai-office-dashboard.service
```

`$XDG_CONFIG_HOME` is honoured when it is set.

macOS:

```text
~/Library/LaunchAgents/com.ai-office.runtime.plist
~/Library/LaunchAgents/com.ai-office.dashboard.plist
```

The labels `com.ai-office.runtime` and `com.ai-office.dashboard` are stable.
`/Library/LaunchDaemons` is never used, and neither is the deprecated
`launchctl load` / `unload` workflow.

Windows services are not supported. `ai-office service` on Windows fails with
that explanation instead of installing something partial; run
`ai-office runtime start` and `ai-office dashboard` in the foreground there.

## Two services, not one

The Runtime and the dashboard stay separate processes, as they are when run by
hand. The dashboard talks to the Runtime over the same local socket a CLI
client uses, so:

- a dashboard crash or restart never takes the Runtime down with it;
- the Runtime keeps its socket-only transport and gains no TCP surface.

## AI_OFFICE_HOME

The generated definitions carry the AI Office home that the invoking program
already resolved — `AI_OFFICE_HOME` when set, otherwise `~/.ai-office`. There
is no second resolution rule for services, and no default is introduced here.

```ini
Environment="AI_OFFICE_HOME=/home/operator/.ai-office"
```

Because the value is written into the definition, a service starts against the
same authoritative home whatever environment the supervisor happens to give it.

## Absolute executable path

A per-user service inherits a minimal environment, so nothing in a generated
definition resolves a program name through an interactive shell `PATH`. The
definitions invoke the absolute interpreter and the absolute AI Office entry
point that was actually running when `install` was invoked:

```ini
ExecStart="/home/operator/.bun/bin/bun" "/home/operator/src/ai-office/bin/ai-office.ts" "runtime" "start"
```

Relinking or moving the program changes that path, so re-run
`ai-office service install` after `ai-office update` moves or relinks the
executable. Installation is idempotent, so re-running it is always safe.

## Source-checkout runtimes

The current distribution is a source checkout (including under `bun link`), and
its entry point refuses operational Runtime access without
`AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1`. That guard is unchanged and is
never relaxed globally. When the resolved executable is that source entry
point, the generated definitions set the variable deliberately, scoped to those
two services:

```ini
Environment="AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1"
```

A packaged executable that does not need the opt-in declares that, and the
variable is not written at all.

`ai-office service install` itself is an operational command, so running it
from the source CLI still requires the opt-in in your own shell.

## Startup ordering

On Linux the dashboard unit declares `Requires=` and `After=` against the
runtime unit, because systemd has those primitives. launchd has no equivalent
dependency contract, and the adapter does not pretend otherwise: install simply
bootstraps the Runtime before the dashboard.

**Correctness never depends on either.** `After=` orders _starts_; it does not
prove the Runtime socket is accepting connections. So the supervised dashboard
is launched with a bounded wait rather than a sleep:

```text
--await-runtime 60
```

It retries the Runtime health check for that long, then exits and lets the
supervisor restart it. Interactive `ai-office dashboard` is unchanged: without
`--await-runtime` it still reports a stopped Runtime immediately.

## Idempotence and file ownership

Every generated file begins with a deterministic ownership marker:

```text
# Managed by AI Office
```

and, in a plist, the equivalent comment:

```xml
<!-- Managed by AI Office -->
```

Install classifies each target path before writing anything:

| State                 | Meaning                                      | Action              |
| --------------------- | -------------------------------------------- | ------------------- |
| `missing`             | nothing at the path                          | create              |
| `managed_current`     | AI Office's file, byte-identical to the plan | leave alone         |
| `managed_outdated`    | AI Office's file, different from the plan    | update deliberately |
| `unmanaged_collision` | a file without the marker                    | **fail closed**     |

A file AI Office does not own is **never overwritten and never deleted**, by
install or by uninstall. A collision stops the whole installation before any
definition is written, and the error names the path; move or rename that file
yourself and run install again.

Running `ai-office service install` twice is safe: the second run reports
`unchanged` and does not restart healthy services.

## Install semantics

`install` detects the platform, preflights the per-user service manager,
resolves the executable and `AI_OFFICE_HOME`, renders both definitions, checks
for collisions, writes what changed, reloads or bootstraps the service manager,
starts the Runtime, starts the dashboard, and only then queries the platform
for authoritative state. The success banner is printed from that query, never
from the fact that the commands were issued.

```text
AI Office services installed

Runtime:   running
Dashboard: running

Definitions
  /home/operator/.config/systemd/user/ai-office-runtime.service (created)
  /home/operator/.config/systemd/user/ai-office-dashboard.service (created)

Dashboard
  http://127.0.0.1:4278
```

Partial installation is reported as such, on stderr, with exit code `1`:

```text
AI Office service installation incomplete

Runtime:   running
Dashboard: failed

Reasons
  systemctl --user enable --now ai-office-dashboard.service failed (exit 1: ...)
```

## Status semantics

`status` normalizes both platforms into one vocabulary:

```text
not_installed
installed_inactive
running
failed
unknown
```

`unknown` is a real answer, not a placeholder: it means the state could not be
established — the service manager was unreachable, or the platform reported a
transitional value. It is never treated as healthy.

```text
AI Office services

Platform: systemd --user
Runtime home: /home/operator/.ai-office

Runtime:
  installed: yes
  registered: yes
  enabled: yes
  state: running
  definition: managed_current
  path: /home/operator/.config/systemd/user/ai-office-runtime.service

Dashboard:
  installed: yes
  registered: yes
  enabled: yes
  state: running
  definition: managed_current
  path: /home/operator/.config/systemd/user/ai-office-dashboard.service
  endpoint: http://127.0.0.1:4278
```

`installed` is true only for a definition AI Office provably owns. `registered`
means the service manager knows the service (`LoadState=loaded`, or a
bootstrapped launchd label); `enabled` means it starts without an operator. On
launchd the two coincide, because a bootstrapped agent with `RunAtLoad` is what
enablement means there.

Exit code `0` means both services are installed and running with no issues;
`1` means anything else. Partial health is never reported as healthy.

`--json` prints the same normalized model with `contractVersion: 1`.

## Uninstall semantics

`uninstall` stops and unregisters the dashboard first and the Runtime second,
then removes **only the generated service definitions**.

It never removes:

```text
~/.ai-office (or $AI_OFFICE_HOME)
project.sqlite, global.sqlite
generated/ and drafts/
repository-local project bindings and project files
```

Repeated uninstall succeeds cleanly and does nothing. A definition AI Office
does not own is preserved, reported, and never disabled or booted out; the
command then reports an incomplete uninstall rather than claiming a clean one.

Only definitions AI Office owns are stopped. If you delete a generated unit or
plist by hand, uninstall has no proof of ownership left and will not touch a
service of that name; stop it with the platform commands below.

## Headless Linux and lingering

User services follow the login session. On a headless server they may not start
before login or survive logout. The platform fix is lingering, and it is
**yours to run** — AI Office prints it as guidance and never executes it:

```bash
sudo loginctl enable-linger <user>
```

Lingering is not required and is never enabled automatically.

## Reaching the dashboard remotely

The dashboard binds `127.0.0.1` and stays there. Forward the port over SSH:

```bash
ssh -L 4278:127.0.0.1:4278 user@server
```

then open `http://127.0.0.1:4278` locally. The dashboard's session token is a
capability against accidental access on a trusted local machine — it is not
authentication and is not suitable for Internet exposure. Do not publish the
port.

## Troubleshooting

Linux:

```bash
systemctl --user status ai-office-runtime
systemctl --user status ai-office-dashboard

journalctl --user -u ai-office-runtime
journalctl --user -u ai-office-dashboard
```

macOS:

```bash
launchctl print gui/$UID/com.ai-office.runtime
launchctl print gui/$UID/com.ai-office.dashboard
```

AI Office has no log directory of its own, and this change does not invent one.
On Linux the units log to the journal; on macOS launchd owns the process output
and `launchctl print` reports state, last exit status, and PID.

`ai-office service status` is the normalized view; the commands above are the
platform detail behind it.

## Architecture

```text
apps/cli/src/service-cli.ts                        presentation only
      |
      v
packages/application/src/service-management/       normalized model, outcomes
  manage-office-services.ts
  managed-definition.ts
      |
      v
packages/application/src/ports/
  office-service-manager.port.ts                   the port
      |
      v
packages/service-management/src/                   infrastructure adapters
  select-service-manager.ts                        platform selection
  systemd-user-service-manager.ts
  launchd-user-service-manager.ts
  service-command-runner.ts                        bounded argv execution
  service-definition-store.ts                      atomic definition writes
```

The CLI has no platform branch and renders no unit or plist text. The
application layer decides what a report _means_ — in particular, whether an
installation succeeded — from the adapter's authoritative post-install status,
so no adapter can print a success banner its own status contradicts. Unit and
plist rendering, `systemctl` and `launchctl` invocation, and every platform
parsing rule stay inside their adapter.

Process execution is argument-array only, with a bounded timeout. There is no
shell interpolation anywhere on this path, and no service identifier is
caller-supplied: the unit names and launchd labels are constants of the
adapters.

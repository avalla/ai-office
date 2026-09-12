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

Paths are rendered under systemd's own rules, not a shell's. Values are quoted
and backslash/quote-escaped because systemd word-splits and unescapes inside
double quotes, and every literal `%` is written `%%` because `%` introduces a
systemd specifier. A directory named `100%` is ordinary, and systemd must
receive the character rather than a substitution:

```ini
Environment="AI_OFFICE_HOME=/home/operator/100%%/.ai-office"
```

launchd has no specifier expansion, so plists carry the literal `%` and only
XML-escape `&`, `<` and `>`.

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

## Ownership evidence

Every generated file carries two header lines: the ownership marker, and the
identity of the service it defines.

```text
# Managed by AI Office
# Definition: ai-office/service/v1 runtime
```

```xml
<!-- Managed by AI Office -->
<!-- Definition: ai-office/service/v1 dashboard -->
```

Both must be present, **verbatim, as whole lines, within the file's header**,
before AI Office will treat a file as its own. Each part of that rule does
work:

- whole-line matching, because a substring test accepts
  `# Not Managed by AI Office`, which asserts the opposite of what it says;
- the header window, because a marker quoted inside somebody else's
  `Description=` or inside a plist string is not a claim of ownership;
- the service identity, because a runtime definition sitting at the dashboard
  path is not a file to silently replace — it is evidence that something is
  wrong.

Anything that fails any of those checks is an `unmanaged_collision`.

Install classifies each target path before writing anything:

| State                 | Meaning                                      | Action              |
| --------------------- | -------------------------------------------- | ------------------- |
| `missing`             | nothing at the path                          | create              |
| `managed_current`     | AI Office's file, byte-identical to the plan | rewrite not needed  |
| `managed_outdated`    | AI Office's file, different from the plan    | update deliberately |
| `unmanaged_collision` | a file without exactly the expected header   | **fail closed**     |

A file AI Office does not own is **never overwritten and never deleted**, by
install or by uninstall. A collision stops the whole installation before any
definition is written, and the error names the path; move or rename that file
yourself and run install again.

## Install semantics

`install` detects the platform, preflights the per-user service manager,
resolves the executable and `AI_OFFICE_HOME`, renders both definitions, checks
for collisions, writes what changed, reloads or bootstraps the service manager,
converges the Runtime, converges the dashboard, and only then queries the
platform for authoritative state. The success banner is printed from that
query, never from the fact that the commands were issued.

### Install restarts running services

**An explicit `ai-office service install` restarts AI Office services that were
already running.** This is deliberate, and it is what makes installation
meaningful rather than cosmetic.

A definition on disk says nothing about the process that is running. Neither
platform publishes a link from a running process back to the bytes of the file
it was started from:

- `systemctl --user enable --now` starts a stopped unit and does _nothing_ to a
  running one, so a rewritten unit would leave the old process running against
  the old launcher and environment while the new unit sat on disk;
- on launchd, a plist that is byte-identical to the plan proves only what is on
  disk. An earlier install whose `bootout` or `bootstrap` failed leaves a stale
  job loaded behind an already-current file.

So install converges both halves. On Linux it writes, `daemon-reload`s,
`enable`s and then **`restart`**s each unit. On macOS it re-bootstraps each
managed job — `bootout`, verify it left the domain, `bootstrap`, verify it came
back — whether or not the plist changed.

Idempotence here means _repeated execution safely converges to the same desired
state_. It does not mean process continuity: run install twice and the services
are restarted twice. Use it when you want the running configuration brought to
the definition; nothing else in AI Office calls it.

When convergence cannot be established — a `restart` that failed, a `bootout`
that did not unload — the affected service is reported as `unknown` rather than
`running`, because the process that is up may not be the one the definition
describes. A later install retries and recovers.

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

### What "healthy" requires

Running is not enough for a supervised service. A clean installation requires
_all_ of:

```text
serviceManagerAvailable == true
definition              == managed_current
installed               == true
registered              == true
enabled                 == true
state                   == running
```

Each one rules out a real, separately observable defect: a process running from
a definition that has since been rewritten; a unit that is up now and will not
return after a reboot; a process the manager does not acknowledge. `unknown`
and unreadable (`null`) values never count — a fact the adapter could not read
is a reason to report less, not to claim more.

Exit code `0` means both services meet all of that with no issues reported;
`1` means anything else. Partial health is never reported as healthy.

### Registration is read independently of the filesystem

Status separates two facts that are genuinely independent:

```text
filesystem  ownership and definition state
OS          registration and runtime state
```

The service manager is consulted **even when no definition exists at the target
path**. A missing file proves AI Office owns nothing there; it proves nothing
at all about whether a unit or label of that name is loaded and running. So a
definition deleted by hand surfaces as an orphan rather than as a clean
uninstall:

```text
Runtime:
  installed: no
  registered: yes
  enabled: no
  state: running
  detail: the unit remains registered but AI Office cannot prove ownership
  definition: missing
```

This is never healthy. AI Office does **not** stop or delete such a service —
ownership can no longer be proven, so acting on it would be acting on somebody
else's process — and instead reports the exact platform command to clean it up
yourself. The same applies to an unmanaged file collision whose unit name or
label happens to be loaded.

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
service of that name; it reports the orphan and the command to clean it up.

### Uninstall fails closed

The governing invariant is:

> A managed service definition may be deleted only after the adapter has
> authoritatively established that the corresponding service is no longer
> running or registered.

The definition file is the _only_ evidence that AI Office owns a service.
Deleting it while the process is still up converts a manageable service into an
orphan nobody can prove ownership of — so removal is gated on the service
manager's own post-operation answer, never on an exit code.

For each service, dashboard first and runtime second, the adapter inspects the
current state, issues the stop, **re-inspects**, and removes the file only when
the result is unambiguous:

| Platform | Removal requires                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| systemd  | `ActiveState` proves not running (`inactive`/`failed`, or `not-found`) **and** the unit is no longer enabled |
| launchd  | `launchctl print` positively answers that the label is not in the domain                                     |

Anything else preserves the file and reports a partial uninstall: a stop that
failed, a stop that reported success without taking effect, a unit that stopped
but is still enabled, a `bootout` that returned "operation now in progress", or
a state the manager would not report at all. `launchctl bootout` in particular
may return while removal is still in progress, so its exit code settles
nothing; registration is re-checked, with bounded retries, until it answers.

**If the service manager cannot be contacted at all, nothing is removed.**
Without it there is no way to establish that anything stopped, and a definition
deleted on that basis would destroy the ownership evidence for whatever is
still running.

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

Every `systemctl` and `launchctl` call runs under an absolute wall-clock bound
with `SIGTERM` → grace → `SIGKILL` escalation, so a wedged service manager
surfaces as a reported timeout rather than a CLI that never returns, and no
subprocess is left behind.

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

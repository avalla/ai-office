# ADR-0020: Managed Runtime provider credential boundary

Status: accepted, 2026-09-14. Amends [ADR-0019](ADR-0019-agent-model-routing.md)
for the location of provider credentials.

## Context

[ADR-0019](ADR-0019-agent-model-routing.md) made provider credentials host-only
but gave a managed Runtime (`ai-office service install`) no source for them.
The Runtime read `OPENAI_API_KEY` from its process environment, the generated
systemd unit and launchd plist deliberately carry no secret, and AI Office did
not manage the service manager's environment. A managed Runtime therefore could
not execute gateway runs, or did so only with whatever
`systemctl --user set-environment` or `launchctl setenv` happened to leave
behind: an implicit, unaudited and platform-specific source.

The credential source must be explicit, local to the Runtime host, owner-only,
provider-neutral, documented identically for systemd and launchd, and must never
put a value in service definitions, `model-routing.yaml`, SQLite, audit events,
logs, diagnostics, dashboard state or portable project state.

## Decision

### Credentials stay a separate concept

A provider credential is Runtime host configuration. It is not model policy,
model profile, resolved run model, project or agent state, a capability, a grant
or a controlled action. Model routing does not reference credential values, and
a credential change never changes a scheduled run's persisted model, provider,
profile, parameters or routing source.

### Canonical source

```text
<AI_OFFICE_HOME>/credentials/            0700, owned by the Runtime user
<AI_OFFICE_HOME>/credentials/OPENAI_API_KEY    0600, regular file
```

One file per logical credential name holds exactly the value; one trailing
`\n` or `\r\n` is tolerated. Only names declared by a registered provider
descriptor (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are read or written, so this
is not a general secret store. There is no `.env` or shell syntax: nothing is
parsed, quoted or expanded, and a file cannot set another variable.

A file is used only when all of the following hold, and otherwise the credential
is `invalid` with a sanitized code (fail closed, never `missing`):

| Check                                                                                       | Code                              |
| ------------------------------------------------------------------------------------------- | --------------------------------- |
| directory is a real directory, not a symlink, owned by the Runtime uid, no group/other bits | `CREDENTIAL_DIRECTORY_INSECURE`   |
| file opened with `O_NOFOLLOW` (a symlink is never followed)                                 | `CREDENTIAL_SYMLINK`              |
| opened descriptor is a regular file (`O_NONBLOCK`, so a FIFO cannot block the Runtime)      | `CREDENTIAL_NOT_REGULAR_FILE`     |
| file owned by the Runtime uid                                                               | `CREDENTIAL_WRONG_OWNER`          |
| no group/other permission bits                                                              | `CREDENTIAL_INSECURE_PERMISSIONS` |
| at most 4096 value bytes, bounded read                                                      | `CREDENTIAL_TOO_LARGE`            |
| 1..4096 visible ASCII characters, no whitespace, NUL or control characters                  | `CREDENTIAL_MALFORMED`            |
| any other I/O error                                                                         | `CREDENTIAL_UNREADABLE`           |

The loader lives in infrastructure (`packages/llm-gateway`); the location and
marker constants live in `packages/runtime-paths` so service rendering does not
depend on the gateway. The domain knows nothing of files, environment variables,
systemd or launchd.

### Source selection and precedence

The Runtime composition root loads credentials once, per declared name, into an
immutable in-memory snapshot:

| Runtime                                                       | Source                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| managed (`AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE=runtime_home`) | only the Runtime home file; the same name in the service manager environment is ignored and reported by name (`MANAGED_ENVIRONMENT_IGNORED`) |
| foreground (marker unset)                                     | the Runtime's own environment variable when set; otherwise the Runtime home file when present                                                |
| any other marker value                                        | every credential `invalid` (`CREDENTIAL_SOURCE_INVALID`)                                                                                     |

In the foreground an invalid Runtime home file is reported `invalid` and is not
treated as missing. An environment variable is higher precedence, not a
fallback, so it is used without consulting the file. This mirrors
`AI_OFFICE_MODEL_ROUTING_FILE` over `model-routing.yaml` in ADR-0019 and keeps
existing foreground `OPENAI_API_KEY` usage unchanged.

### Service management

`service install` renders a second non-secret marker next to the routing marker,
in the Runtime definition only and identically for both platforms:

```ini
Environment="AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE=runtime_home"
```

```xml
<key>AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE</key>
<string>runtime_home</string>
```

No value, credential name or credential path is rendered, passed in argv or
copied by `service install`; it only names credential variables present in the
invoking shell that the managed Runtime will not use. A Runtime definition
generated before this marker reports `managed_outdated`, and re-running
`service install` replaces it. Until then that Runtime keeps the previous
environment-only behavior. `service uninstall` removes definitions only and
leaves the credentials directory in place, like the rest of `AI_OFFICE_HOME`;
`runtime:purge` removes only its allowlisted Runtime artifacts and never the
credentials directory. `ai-office update` neither reads nor rewrites credentials.

### Operator command

```text
ai-office credential set <NAME>       value from non-terminal stdin only
ai-office credential status [--json]  present | missing | invalid <CODE>
ai-office credential remove <NAME>
```

`credential` is local host configuration, handled before Runtime dispatch like
`service` and `dashboard`: it neither needs nor contacts the Runtime, and no
value crosses IPC, the command protocol, audit or SQLite. Because it writes
host configuration that is not project state, it records no audit event, just
as editing `model-routing.yaml` does not. `set` refuses a terminal stdin (which
would echo), never accepts the value as an argument, never echoes arguments in
errors, creates the directory `0700` and a same-directory temporary file with
`O_CREAT|O_EXCL|O_NOFOLLOW` and mode `0600`, `fsync`s and renames it atomically,
and refuses (never repairs) an insecure directory or a symlink or non-file at
the name. `remove` unlinks a symlink without following it.

### Diagnostics

`model:check` reports, for each gateway-executable provider in use, each
credential by logical name with `present`, `missing` or `invalid`, its origin
(`environment` or `runtime_home`), an issue code, and whether the credential
source is `managed` or `foreground`. It never reports a value, length,
prefix/suffix, fingerprint, absolute path or file content. `run:tick --worker
gateway` refuses a batch with an unusable credential before admission, and the
gateway worker fails with `WORKER_CREDENTIALS_MISSING` before pricing,
reservation or any request.

### Value handling

Application code sees only `ProviderCredentialSource` (status by name). The
value accessor exists on the infrastructure `ProviderCredentials` snapshot and
is used only by `CredentialGatewayModelProviders`, which passes the registry
exactly the resolved provider's own credentials — never the host environment.
Values are held in a private field: they are not enumerable and `JSON.stringify`
and `util.inspect` of the snapshot show statuses only.

### Restart, not reload

Credentials are read once at Runtime start. A change needs a Runtime restart:

```bash
systemctl --user restart ai-office-runtime.service          # Linux
launchctl kickstart -k gui/$(id -u)/com.ai-office.runtime   # macOS
```

This adds no reload mechanism and does not anticipate the routing reload
tracked in M7.13.

## Threat model

This is hardening against accidental exposure and other local users, within the
trusted-local model of [ADR-0014](ADR-0014-runtime-authority-and-persistent-daemon-host.md):

- It keeps values out of service definitions, process argv, routing files,
  SQLite, audit and event payloads, command output, diagnostics, dashboard read
  models, portable snapshots and backups.
- Owner and permission checks stop another local user from supplying or reading
  a credential, and stop a mistakenly group- or world-readable file from being
  used.
- It is **not** a same-UID boundary. Any process of the Runtime user can read
  the files, the Runtime's memory or its environment, replace files between
  runs, or run `credential set`. It does not defend against a hostile same-user
  process concurrently mutating the directory, and it does not encrypt at rest.
- Agents and workers never receive a credential, a credential tool or an option
  to choose the credential source; no action payload, run field or command
  argument selects or reloads it.
- `AI_OFFICE_DEBUG_LLM=1` keeps its existing opt-in stderr diagnostics (provider,
  model, key presence, length and a truncated SHA-256 fingerprint). It is off by
  default, never written by `service install`, and unchanged by this decision.

Windows services are unsupported, and the file source requires a POSIX uid.

## Consequences

- A managed Runtime executes gateway runs after `credential set` and a Runtime
  restart on systemd and launchd alike, without the service manager environment.
- Existing managed installs report `managed_outdated` until `service install`
  is re-run.
- Foreground `OPENAI_API_KEY` keeps working and wins over a Runtime home file.
- No migration and no portable-format change: credentials are never persisted
  in `project.sqlite`, `global.sqlite`, snapshots, backups or the office manifest.

Still deferred in M7.13: Anthropic gateway execution, budget co-reservation,
audited override management, dashboard model rendering and routing reload.

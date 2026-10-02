# Installation guide

This guide describes the current supported installation model for AI Office on `main`.

AI Office is currently distributed from a source checkout and linked with Bun. There is no packaged release installer yet. The source entry point intentionally refuses operational access to the user Runtime unless the operator explicitly opts in.

## Supported host model

The primary host model is local and per-user:

- Linux: foreground Runtime or `systemd --user` services;
- macOS: foreground Runtime or `launchd` LaunchAgents;
- Windows: foreground Runtime is possible, but native AI Office service management is not supported;
- no root service is installed;
- no `sudo` is required by AI Office;
- the Runtime listens on an owner-only Unix domain socket, not a TCP port;
- the dashboard binds to loopback only.

## Prerequisites

Required:

- Git;
- Bun;
- a writable user home;
- a project directory to manage.

Optional:

- Codex or Claude Code for repository-local AI client workflows;
- Redis or Valkey for BullMQ-backed orchestration;
- SurrealDB 3.3.0 for persistent Agent Knowledge;
- PostgreSQL/Supabase only for development and storage-parity work until complete Runtime storage parity lands.

AI Office does not install these optional services for you.

## 1. Clone AI Office

```bash
git clone https://github.com/avalla/ai-office.git
cd ai-office
```

Install exactly the dependencies recorded by the lockfile:

```bash
bun install --frozen-lockfile
```

## 2. Link the `ai-office` command

From the repository root:

```bash
bun link
```

The root `package.json` declares the `ai-office` executable. The bare `bun link` command registers the checkout and exposes that bin.

Do **not** run this obsolete sequence:

```bash
bun link
bun link --global ai-office
```

If it was already used and left a broken link, rerun the bare `bun link` command from the AI Office checkout.

Find Bun's global bin directory:

```bash
bun pm bin -g
```

Ensure that directory is on your shell `PATH`.

Verify the local executable:

```bash
ai-office --version
ai-office version --json
ai-office --help
```

These version/help commands are local and do not require a running Runtime.

## 3. Opt in to the user Runtime

A linked source checkout is deliberately guarded. Operational commands require:

```bash
export AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1
```

Add that variable to the shell/session used to operate the source-linked installation if you want it to persist.

Without the opt-in, commands fail before contacting the Runtime. This is intentional and prevents a development checkout from silently taking over the user's authoritative Runtime.

### Runtime home

The default user Runtime home is:

```text
~/.ai-office
```

To use another one, set it **before** installing or starting services:

```bash
export AI_OFFICE_HOME="$HOME/.ai-office"
```

One Runtime home can manage multiple repositories.

Do not point normal user operation at the checkout-local `.ai-office/` directory. The `bun run dev:daemon` and `bun run dev:cli` development commands intentionally use checkout-local isolated state.

## 4. Choose foreground or managed operation

### Option A: foreground Runtime

Start the persistent host:

```bash
ai-office runtime start
```

The historical `ai-office daemon` command remains a compatibility alias.

Keep that process running while using Runtime-backed CLI commands from other terminals.

Check it with:

```bash
ai-office runtime status
```

### Option B: per-user OS services

On Linux and macOS, AI Office can install the Runtime and dashboard as per-user services:

```bash
ai-office service install
ai-office service status
```

Linux uses `systemd --user`; macOS uses LaunchAgents. No system-wide unit, LaunchDaemon, or root process is created.

After moving, relinking, or updating the AI Office source checkout, rerun:

```bash
ai-office service install
```

Installation is idempotent and replaces an outdated generated service definition while preserving Runtime data and credentials.

The complete platform-specific service contract is documented in [Native service management](development/service-management.md).

## 5. Install AI Office into a repository

Move to the repository you want AI Office to manage:

```bash
cd /path/to/project
ai-office install .
```

Then verify:

```bash
ai-office status
ai-office next
```

What `install` does:

- resolves the canonical project/worktree root;
- creates or reuses the authoritative project identity;
- writes the committable `.ai-office/project.json` repository binding;
- reconciles shared `AI-OFFICE.md` guidance;
- reconciles repository-local AI Office skills and supported host pointers;
- detects supported clients for diagnostics/integration;
- preserves user-owned instructions and skills;
- does not copy the Runtime database into the project;
- does not grant capabilities;
- does not install third-party tools.

The absence of a detected Codex/Claude executable does not make project lifecycle invalid. Shared project artifacts and project authority are not owned by client detection.

### Exit codes

For `install`:

- `0`: installed;
- `2`: installed with actionable warnings;
- `1`: failed or partial.

For `status`:

- `0`: no inspected problem requires attention;
- `1`: a problem was found or the project is not installed.

Use `--json` for automation.

## 6. Complete project handover

For an existing repository, `ai-office next` will normally guide you through project handover.

The intended flow separates:

1. deterministic repository discovery;
2. AI-client review of the codebase and current AI Office state;
3. user confirmation of repository understanding;
4. the approved office/organizational model.

The final confirmation is authoritative evidence, not a capability grant:

```bash
ai-office handover:confirm \
  --project <project-id> \
  --summary "<confirmed project understanding>"
```

The project can then maintain its own roles, agents, pipelines, requirements, tasks, reviews, approvals, and model policies.

## 7. Inspect the project

Useful first commands:

```bash
ai-office office:workspace --project <project-id>
ai-office task:list --project <project-id>
ai-office agent:list --project <project-id>
ai-office agent:models --project <project-id> --json
ai-office pipeline:status --project <project-id>
ai-office run:list --project <project-id>
```

The current CLI syntax is always available from:

```bash
ai-office --help
```

## 8. Provider credentials

Credentials are not required for project install, status, deterministic import, handover state, or many governance operations.

For managed Runtime services, provider credentials are stored as owner-only files under:

```text
<AI_OFFICE_HOME>/credentials/
```

Example:

```bash
read -rs KEY
printf '%s' "$KEY" | ai-office credential set OPENAI_API_KEY
unset KEY

ai-office credential status
```

The value is read from non-terminal stdin and is never accepted as a command-line argument.

After changing managed credentials, restart the Runtime service using the platform tools documented in [Native service management](development/service-management.md).

A foreground Runtime reads provider credentials from its own environment instead of the managed credential directory.

## 9. Model routing

Managed services load the canonical routing file from:

```text
<AI_OFFICE_HOME>/model-routing.yaml
```

Inspect routing without sending a model request:

```bash
ai-office model:check --project <project-id> --json
ai-office agent:models --project <project-id> --json
```

Operator overrides and reloads are available through `model:override` and `model:reload`.

See [LLM gateway, cost control and model routing](development/llm-cost-control.md).

## 10. Optional persistent Agent Knowledge

The native optional Agent Knowledge provider is SurrealDB. It is a secondary advisory store, not project authority.

The restart-tested deployment guide currently pins SurrealDB 3.3.0.

For a managed Runtime, configuration lives in:

```text
<AI_OFFICE_HOME>/agent-knowledge.json
```

SurrealDB credentials live separately in protected files:

```text
<AI_OFFICE_HOME>/credentials/AI_OFFICE_SURREALDB_USERNAME
<AI_OFFICE_HOME>/credentials/AI_OFFICE_SURREALDB_PASSWORD
```

Do not improvise this setup from environment variables for a managed service. Follow [Persistent Agent Knowledge deployment](development/agent-knowledge-deployment.md), which covers ownership, permissions, loopback binding, backup, restore, and service restart behavior.

CairnKeep is retired and must not be installed for new AI Office deployments.

## 11. Optional BullMQ orchestration

The default Runtime does not require Redis or Valkey.

For a foreground Runtime, queue-backed orchestration can be selected explicitly:

```bash
export AI_OFFICE_QUEUE_PROVIDER=bullmq
export AI_OFFICE_REDIS_URL=redis://127.0.0.1:6379
ai-office runtime start
```

AI Office never installs Redis/Valkey. Keep it host-local and configure it according to its own security documentation.

Queue messages are disposable delivery hints. Project storage remains authoritative and the transactional outbox preserves intent across queue outages.

For managed services, use the exact service-environment procedure documented in [Native service management](development/service-management.md).

## 12. PostgreSQL / Supabase status

Do not select PostgreSQL merely because a connection URL exists.

AI Office has a real PostgreSQL storage package, migrations, transaction/session handling, tenant/RLS foundations, and growing repository parity. However, the current architecture documentation still classifies PostgreSQL as incomplete for the complete Runtime authority.

SQLite remains the default and complete local Runtime project storage.

When incomplete PostgreSQL storage is selected for a Runtime surface that lacks parity, startup is expected to fail closed rather than silently mix PostgreSQL and SQLite.

See [Storage architecture](architecture/storage.md).

## 13. Dashboard

With a running Runtime:

```bash
ai-office dashboard
```

The dashboard is read-only, binds to loopback, and communicates with the Runtime over its local socket.

Managed service installation can supervise it separately from the Runtime.

## 14. Updating AI Office

The source updater is deliberately two-phase.

First produce the exact plan:

```bash
ai-office update --json
```

Stop the relevant Runtime hosts before applying the approved plan.

Then apply the exact returned hash:

```bash
ai-office update --approve <plan-hash> --json
```

The updater only accepts a safe fast-forward source update, then runs:

- `bun install --frozen-lockfile`;
- bare `bun link`.

It does not automatically stash, reset, switch branches, roll back, or rewrite Runtime data.

After an update, reinstall managed service definitions so they point at the current absolute source/interpreter paths:

```bash
ai-office service install
ai-office service status
```

## 15. Uninstalling

Project uninstall is planned and approval-bound:

```bash
ai-office uninstall .
```

Review the returned plan, then approve the exact hash when you intend to apply it.

Remove the per-user Runtime/dashboard services with:

```bash
ai-office service uninstall
```

Service uninstall does not delete Runtime data or credentials.

`runtime:purge` is a separate destructive lifecycle operation and is only available while the Runtime host is stopped. Do not use it as an ordinary uninstall command.

## Troubleshooting

### `Source CLI user-runtime access requires AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1`

Set:

```bash
export AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1
```

This is required for operational commands from the linked source distribution.

### `ai-office: command not found`

Check:

```bash
bun pm bin -g
```

Put the reported directory on `PATH`, then rerun `bun link` from the AI Office checkout.

### Runtime is unreachable

Check:

```bash
ai-office runtime status
ai-office service status
```

If you use foreground mode, verify that `ai-office runtime start` is still running.

### Managed services are outdated after an update or move

Regenerate them:

```bash
ai-office service install
ai-office service status
```

### Agent Knowledge reports `misconfigured`

Do not fall back to ambient secrets. Check the protected `agent-knowledge.json` and credential-file ownership/modes using the [Agent Knowledge deployment guide](development/agent-knowledge-deployment.md).

### Need an isolated development Runtime

Use the repository-local development commands instead of the user Runtime:

```bash
bun run dev:daemon
bun run dev:cli -- status
```

They intentionally use the source checkout's own `.ai-office/` state.

## Next reading

- [Documentation index](README.md)
- [Architecture overview](architecture/overview.md)
- [Storage architecture](architecture/storage.md)
- [Native service management](development/service-management.md)
- [Agent runtime](development/agent-runtime.md)
- [Persistent Agent Knowledge deployment](development/agent-knowledge-deployment.md)
- [Development roadmap](development/roadmap.md)

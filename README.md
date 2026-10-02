# AI Office

AI Office is a local-first, auditable multi-agent office for software delivery. It keeps project and governance state under an authoritative Runtime, coordinates agents and pipelines, meters model usage and cost, and routes protected side effects through explicit capability and approval boundaries.

> **Current scope:** AI Office is software-development-first today. The generic-core / Domain Packs work is planned in M16; Domain Packs are **not** a current Runtime feature.

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Andrea Valla.

## Highlights

- **Authoritative local Runtime** with a persistent daemon and versioned CLI protocol over an owner-only Unix socket.
- **Project lifecycle**: install, status, handover, portable backup/restore, repository identity, and deterministic project bindings.
- **Custom offices**: versioned roles, agents, model policies, pipeline definitions, approvals, overrides, and project-specific manifests.
- **Governed execution**: task lifecycle, requirements, milestones, reviews, ADRs, enforced pipeline stages, locks, fencing, retries, and audit events.
- **Agent execution**: bounded real workers, simulation, per-agent model routing, usage normalization, budgets, and cost accounting.
- **Controlled actions**: deny-by-default capabilities, project-scoped resources, approval gates, and audited filesystem operations.
- **Operations**: read-only dashboard, operational read models, Runtime health, native per-user service management on Linux and macOS.
- **Storage abstraction**: SQLite is the default and complete local project authority; PostgreSQL/Supabase support exists behind the storage port but is still incomplete for full Runtime authority.
- **Agent Knowledge**: optional native SurrealDB-backed knowledge retrieval and reviewed admission with provenance. CairnKeep is retired.
- **Queue-backed orchestration**: optional BullMQ with Redis/Valkey. Queue jobs are disposable wake-ups; authoritative state remains in project storage.
- **Codex and Claude Code integration** through shared project guidance and repository-local skills. Client detection is informational and does not own project lifecycle.

## Architecture

```text
Codex / Claude Code / CLI / future clients
                |
          RuntimeClient
                |
     HTTP over owner-only
       Unix domain socket
                |
       AI Office Runtime
        /      |       \
 application  ports   read models
    |          |          |
 domain   storage /    dashboard
 rules    knowledge /
          connectors
```

The Runtime owns mutable project state and orchestration semantics. Repository Markdown such as `AI-OFFICE.md` is a projection and integration surface, not a second authority.

### Storage responsibilities

| Component | Role | Current status |
| --- | --- | --- |
| SQLite | Project authority and default Runtime storage | **Default / complete** |
| PostgreSQL / Supabase | Alternative `ProjectStorage` implementation | **Partial; full Runtime startup fails closed where parity is missing** |
| SurrealDB | Secondary `AgentKnowledgeStore` | **Optional / supported** |
| Redis or Valkey | BullMQ delivery / wake-up transport | **Optional** |
| `global.sqlite` | Reusable roles, patterns, and lessons | **Implemented** |

SurrealDB never replaces project authority. PostgreSQL and SurrealDB solve different problems and are deliberately kept behind different ports.

## Installation

The repository is currently distributed as a **source-linked Bun application**, not as a packaged binary.

### 1. Clone and link the CLI

```bash
git clone https://github.com/avalla/ai-office.git
cd ai-office

bun install --frozen-lockfile
bun link
```

Ensure Bun's global bin directory is on `PATH`:

```bash
bun pm bin -g
```

The bare `bun link` command exposes the declared `ai-office` executable. Do not follow it with `bun link --global ai-office`.

### 2. Allow the source distribution to use your user Runtime

Operational commands from a source checkout deliberately require an explicit opt-in:

```bash
export AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1
```

By default Runtime data lives in `~/.ai-office`. Override it before starting or installing services if you need a different home:

```bash
export AI_OFFICE_HOME="$HOME/.ai-office"
```

Check the executable without contacting the Runtime:

```bash
ai-office --version
ai-office version --json
```

### 3. Start AI Office

For a foreground Runtime:

```bash
ai-office runtime start
```

For a supervised per-user Runtime and dashboard on Linux or macOS:

```bash
ai-office service install
ai-office service status
```

AI Office never installs system-wide services and never requires `sudo`.

### 4. Install AI Office into a project

```bash
cd /path/to/project

ai-office install .
ai-office status
ai-office next
```

`install` creates or reconciles the repository binding, shared `AI-OFFICE.md` guidance, and supported client integrations. It does not copy the authoritative database into the repository and does not grant capabilities.

The first useful next step is usually project handover: let the connected AI client review the repository and the current AI Office state, then confirm the resulting project understanding.

For the complete setup, service, credential, optional dependency, update, and troubleshooting procedure, see **[Installation guide](docs/installation.md)**.

## Typical workflow

```bash
# Inspect project and recommended next action
ai-office status
ai-office next

# Browse authoritative project work
ai-office office:workspace --project <project-id>

# Work with tasks
ai-office task:list --project <project-id>
ai-office task:readiness --project <project-id> --task <task-id>

# Inspect agent/model routing
ai-office agent:list --project <project-id>
ai-office agent:models --project <project-id> --json
ai-office model:check --project <project-id> --json

# Inspect runs and pipelines
ai-office pipeline:status --project <project-id>
ai-office run:list --project <project-id>

# Open the read-only operations dashboard
ai-office dashboard
```

Run `ai-office --help` for the current command surface. The CLI is the syntax authority; documentation intentionally avoids duplicating every flag.

## Provider credentials and model routing

Normal project installation and handover do not require provider credentials.

For managed services, provider secrets live in owner-only files under `<AI_OFFICE_HOME>/credentials/`. For example:

```bash
read -rs KEY
printf '%s' "$KEY" | ai-office credential set OPENAI_API_KEY
unset KEY

ai-office credential status
```

Managed model routing is loaded from:

```text
<AI_OFFICE_HOME>/model-routing.yaml
```

After changing managed credentials or startup configuration, restart the Runtime service. See [LLM gateway, cost control and model routing](docs/development/llm-cost-control.md) and [native service management](docs/development/service-management.md).

## Optional Agent Knowledge with SurrealDB

AI Office can use a persistent SurrealDB-backed `AgentKnowledgeStore` for scoped, advisory knowledge and provenance. It is secondary to project storage and does not bypass reviewed knowledge admission.

The managed setup uses:

```text
<AI_OFFICE_HOME>/agent-knowledge.json
<AI_OFFICE_HOME>/credentials/AI_OFFICE_SURREALDB_USERNAME
<AI_OFFICE_HOME>/credentials/AI_OFFICE_SURREALDB_PASSWORD
```

Use the hardened deployment procedure in [Persistent Agent Knowledge deployment](docs/development/agent-knowledge-deployment.md). The current deployment guide pins SurrealDB 3.3.0 for the restart-tested configuration.

## Optional queue-backed orchestration

BullMQ orchestration is disabled by default. A foreground Runtime can opt in with:

```bash
export AI_OFFICE_QUEUE_PROVIDER=bullmq
export AI_OFFICE_REDIS_URL=redis://127.0.0.1:6379
```

Redis/Valkey is external infrastructure and is never installed by AI Office. For managed services and the exact trust/configuration boundary, see [native service management](docs/development/service-management.md).

## Updating a source-linked installation

Stop the relevant Runtime hosts before applying an update.

```bash
ai-office update --json
ai-office update --approve <plan-hash> --json
```

The update flow is fail-closed: it plans an exact source target, requires explicit approval, fast-forwards only, runs the frozen Bun install, and relinks the source executable. It does not silently stash, reset, switch branches, or rewrite Runtime data.

## Development

Use the isolated checkout Runtime when developing AI Office itself:

```bash
bun install --frozen-lockfile
bun run dev:daemon
bun run dev:cli -- status
```

Validation:

```bash
bun run check
```

The repository uses Bun, strict TypeScript, ESLint, Prettier, Vitest, SQLite integration coverage, PostgreSQL contract/integration coverage, and dedicated external-service tests where required.

## Project direction

The current Runtime remains software-development-oriented. M15 is defining cross-domain professional-work boundaries, and M16 plans the extraction of a generic core plus versioned Domain Packs. Until that work lands, do not treat development, legal, manufacturing, or other packs as implemented Runtime capabilities.

See:

- [Development roadmap](docs/development/roadmap.md)
- [M16 Generic Core & Domain Packs plan](docs/development/generic-core-domain-packs.md)
- [Architecture overview](docs/architecture/overview.md)
- [Storage architecture](docs/architecture/storage.md)
- [Documentation index](docs/README.md)

## License

[MIT](LICENSE).

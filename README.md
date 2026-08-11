# AI Office

AI Office is a local AI software office that coordinates agents, keeps structured state in SQLite, manages tasks, runs, governance, budgets, and costs, and mediates agent access to resources through capabilities and controlled actions.

## What AI Office is

AI Office is a Bun and strict TypeScript monorepo built around one local daemon. The daemon owns project state, exposes a versioned HTTP protocol over an owner-only Unix socket, and routes commands through application services and explicit infrastructure ports.

The product is local-first and auditable: SQLite is authoritative, generated Markdown is a projection, LLM usage is metered through a gateway, and protected resource operations are authorized through capability policy and connector boundaries.

## Current status

The current implementation on `main` includes:

- a local daemon and daemon-backed CLI;
- project creation, deterministic repository import, and onboarding;
- tasks, agent definitions, scheduled runs, locking, and persisted run events;
- an LLM gateway with mock and opt-in OpenAI providers;
- versioned pricing, budgets, reservations, usage normalization, and cost accounting;
- structured milestones, requirements, ADRs, reviews, approvals, and Markdown export;
- deny-by-default capability policy and a project-scoped resource registry;
- a filesystem connector with scoped reads, search, mutation simulation, and sandbox checks;
- local approval plus trusted-local create, write, move, and delete execution;
- SQLite persistence, migrations, audit events, and daemon/CLI workflows.

Agent runs still use a deterministic simulated executor. The automatic `agent runtime -> controlled actions` integration belongs to M6D-lite and is not implemented, so AI Office is not yet autonomous end to end.

## How it works

```text
CLI
  -> HTTP over .ai-office/daemon.sock
  -> local daemon command dispatch
  -> application services and domain rules
  -> SQLite repositories / LLM gateway / controlled connectors
```

Stateful CLI commands go through the daemon. Short writes use application-level transactions; provider calls, scans, simulated agent work, and filesystem side effects do not run inside an open SQLite transaction.

## Quick start

Install and validate the repository:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Start the daemon from the repository root:

```bash
bun run daemon
```

In another terminal, check its health:

```bash
bun run cli -- daemon:health
```

The daemon creates and migrates `.ai-office/project.sqlite` and listens on `.ai-office/daemon.sock`.

## Example workflow

Import an existing repository, then inspect its structured profile:

```bash
bun run cli -- project:import /path/to/repository
# Project imported: <project-id>

bun run cli -- project:profile --project <project-id>
```

For a new project without an import scan:

```bash
bun run cli -- project:create "Demo"
bun run cli -- task:create --project <project-id> --title "First task" --priority 10
bun run cli -- task:list --project <project-id>
```

Run interactive onboarding with `project:onboard`, or answer persisted questions individually with `project:answer`. For current command syntax and the complete command list, use:

```bash
bun run cli -- --help
```

## Architecture

The implemented interface is the CLI. Web, IDE, and MCP are target interfaces, not current product surfaces.

```text
CLI                         Web / IDE / MCP (targets)
  \                                   /
   +---------- local daemon ---------+
                    |
           application services
          /          |           \
 agent runtime     memory       LLM gateway
                         \          |
                   controlled     providers
                    actions
                       |
                capability policy
                       |
               connector registry
                       |
                resource adapters
```

The domain does not depend on Bun, SQLite, HTTP, Git, MCP, connector implementations, or provider SDKs. See the [architecture overview](docs/architecture/overview.md) for current boundaries and implementation notes.

## Controlled actions

Filesystem mutations use this explicit workflow:

```text
request -> simulate -> inspect -> approve -> execute
```

After creating or importing a project, synchronize agents and use the returned agent ID:

```bash
bun run cli -- agent:sync --project <project-id> --directory agents
bun run cli -- agent:list --project <project-id>

bun run cli -- resource:create \
  --project <project-id> \
  --type filesystem_scope \
  --provider filesystem \
  --name Workspace \
  --external-ref /absolute/path/to/workspace

bun run cli -- capability:grant \
  --project <project-id> \
  --principal-type agent \
  --principal <agent-id> \
  --resource <resource-id> \
  --actions filesystem.create \
  --constraints '{"allowMutation":true}' \
  --granted-by local-owner \
  --reason "Create files in this workspace"

bun run cli -- action:request \
  --project <project-id> \
  --agent <agent-id> \
  --resource <resource-id> \
  --operation filesystem.create \
  --arguments '{"path":"notes/example.txt","content":"Created by AI Office\n"}'

bun run cli -- action:invoke --project <project-id> --action <action-id>
bun run cli -- action:show --project <project-id> --action <action-id>
bun run cli -- action:approve --project <project-id> --action <action-id> --actor local-user
bun run cli -- action:execute --project <project-id> --action <action-id>
```

Simulation is not mutation. Every filesystem v2 mutation requires approval, execution performs fresh authorization and precondition checks, and one action can obtain at most one execution attempt. `action:show` redacts create/write content.

## Storage model

The architecture separates three kinds of state:

- `<repository>/.ai-office/project.sqlite` is authoritative project state. It is implemented and currently stores projects, tasks, onboarding, agents, runs, costs, governance, capabilities, controlled actions, and audit events.
- `~/.ai-office/global.sqlite` is intended for reusable roles, patterns, and lessons across projects. An initial schema exists, but the daemon does not yet open or manage this database.
- `<repository>/.ai-office/index.sqlite` is intended for regenerable code intelligence such as files, symbols, edges, chunks, and FTS. An initial schema exists, but indexing and daemon integration are future work.

Project migrations are versioned under `migrations/project/` and tracked in `schema_migration`. Reapplying the migration runner is idempotent with respect to that tracking table.

## Repository structure

```text
apps/
  daemon/                 local process and protocol boundary
  cli/                    daemon-backed command-line client
packages/
  domain/                 entities, value objects, and rules
  application/            use cases and ports
  storage-sqlite/         SQLite adapters and migration runner
  agent-runtime/          agent definitions and simulated execution
  llm-gateway/            providers, pricing, budgets, and usage
  orchestration/          scheduling abstractions
  connector-sdk/          connector contracts and registry
  filesystem-connector/   scoped filesystem adapter and sandbox
migrations/               project, global, and index SQL migrations
agents/                    bundled YAML agent definitions
patterns/                  reusable pattern source material
docs/                      architecture, development, ADRs, and history
spikes/                    research prototypes; not production code
tests/                     unit, integration, security, and daemon/CLI E2E tests
```

The Rust/native filesystem work under `spikes/` is research evidence for future hardening. It is not linked into the production connector.

## Development

Primary local validation is:

```bash
bun run typecheck
bun run test
git diff --check
```

CI installs dependencies with the frozen lockfile, runs strict TypeScript typechecking and the deterministic Vitest suite, and checks the committed diff for whitespace errors. Standard CI does not make paid provider calls.

Read [CODEX.md](CODEX.md) before changing code. It defines the operating contract, invariants, scope rules, and definition of done.

## Documentation

The [documentation index](docs/README.md) explains which documents are current architectural truth and which preserve milestone-specific or historical research. In short:

- README: product overview and getting started;
- CODEX: development operating contract;
- architecture docs: current architectural truth;
- roadmap: milestone scope and status;
- accepted ADRs: architectural decisions;
- implementation docs: historical and milestone detail;
- `bun run cli -- --help`: command syntax.

## Roadmap

The authoritative [development roadmap](docs/development/roadmap.md) records completed and future milestones. The next controlled-action milestone is M6D-lite, which will connect agent execution to the controlled-action gateway. Reusable memory, code intelligence, context assembly, productization, and hostile-local security hardening remain future work.

## Security and current trust model

M6C-lite assumes a local, single-user deployment in the user's trust domain. It protects against accidental or unauthorized agent access, path escape, sensitive-path access, stale simulations and capabilities, replay, and unapproved filesystem mutation.

It does not defend against a hostile process running with the same Unix credentials and concurrently mutating the same filesystem namespace. Local approval records an operator-supplied audit identity; it is not cryptographic proof of human presence. Rust/`openat2`, authenticated approvals, tamper-evident audit, and stronger crash reconciliation are M10 research and roadmap items, not production claims today.

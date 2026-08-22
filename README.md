# AI Office

AI Office is a local AI software office that coordinates agents, keeps structured state in SQLite, manages tasks, runs, governance, budgets, and costs, and mediates agent access to resources through capabilities and controlled actions.

## What AI Office is

AI Office is a Bun and strict TypeScript monorepo built around one local daemon. The daemon owns project state, exposes a versioned HTTP protocol over an owner-only Unix socket, and routes commands through application services and explicit infrastructure ports.

The product is local-first and auditable: SQLite is authoritative, generated Markdown is a projection, LLM usage is metered through a gateway, and protected resource operations are authorized through capability policy and connector boundaries.

## Current status

The current implementation on `main` includes:

- a local daemon and daemon-backed CLI;
- project creation, deterministic offline repository import, and host-skill conversational onboarding without runtime provider credentials;
- versioned virtual-office manifests with roles and default task pipelines;
- tasks, agent definitions, scheduled runs, locking, and persisted run events;
- an LLM gateway with mock and opt-in OpenAI providers;
- versioned pricing, budgets, reservations, usage normalization, and cost accounting;
- structured milestones, requirements, ADRs, reviews, approvals, and Markdown export;
- deny-by-default capability policy and a project-scoped resource registry;
- a filesystem connector with scoped reads, search, mutation simulation, and sandbox checks;
- local approval plus trusted-local create, write, move, and delete execution;
- structured agent-run action intents routed through the controlled-action gateway;
- tool-independent project instruction contracts with safe Codex CLI and Claude Code integration;
- SQLite persistence, migrations, audit events, and daemon/CLI workflows.

Runs without an action intent still use the deterministic simulated executor.
Controlled runs can request or simulate an authorized connector action and return
its action ID for inspection, approval, and execution. A real LLM tool loop and
Git worktree manager are not implemented, so AI Office is not yet autonomous end
to end.

## How it works

```text
Codex / compatible host
  -> repository-scoped ai-office skill
  -> machine-oriented CLI
  -> HTTP over .ai-office/daemon.sock
  -> local daemon command dispatch
  -> application services and domain rules
  -> SQLite repositories / LLM gateway / controlled connectors
```

Stateful product commands go through the daemon. Short writes use
application-level transactions; provider calls, scans, simulated agent work,
and filesystem side effects do not run inside an open SQLite transaction. Help
and the destructive `runtime:purge` lifecycle command run locally; purge is
available only while the daemon is stopped.

## Quick start

Install and validate the repository:

```bash
bun install --frozen-lockfile
bun run check
```

Interactive onboarding, offline project import, task management, governance,
and simulated agent runs do not require an LLM credential in AI Office. The
repository-scoped `ai-office` skill uses the model session already authenticated
by the host. Provider configuration in `.env.example` is an optional headless
fallback only; never commit `.env`.

Start the daemon from the directory that should act as its runtime root (for
this checkout, the repository root):

```bash
bun run daemon
```

In another terminal, check its health:

```bash
bun run cli -- daemon:health
```

The daemon creates and migrates `.ai-office/project.sqlite` relative to the
directory where it starts and listens on `.ai-office/daemon.sock`. See
[Local storage and state](#local-storage-and-state) before deleting or resetting
that directory.

## Conversational onboarding

Open this repository in Codex and ask:

```text
Use $ai-office to onboard /path/to/repository
```

The skill scans the repository offline, reads the resulting structured context,
asks only material project questions, proposes a virtual office and default task
pipelines, validates the manifest, and asks for confirmation before applying it.
The runtime stores each accepted manifest as an immutable revision and records a
sanitized audit event. Permission preferences remain project knowledge; they do
not create capability grants.

The skill is checked in at `.agents/skills/ai-office`. Its default manifest is a
starting point, not an automatic grant or fixed organization.

## Machine interface

Import an existing repository, then inspect its structured profile:

```bash
bun run cli -- project:import /path/to/repository --json
# Read projectId from the JSON result.

bun run cli -- project:profile --project <project-id>
bun run cli -- office:context --project <project-id>
```

For a new project without an import scan:

```bash
bun run cli -- project:create "Demo"
bun run cli -- task:create --project <project-id> --title "First task" --priority 10
bun run cli -- task:list --project <project-id>
```

`project:import` never calls a provider: its repository scan remains
deterministic, idempotent, and usable offline. `office:validate`, `office:apply`,
`office:show`, and `office:pipeline` form the versioned machine contract used by
the skill. `project:onboard` remains available as an optional provider-backed
headless compatibility flow; it is no longer the primary interactive UX.

For the optional headless compatibility flow, opt in at the daemon composition
root, configure pricing for the provider's bare model name, and optionally set a
project budget. OpenAI and Anthropic remain supported through the
infrastructure-only LangChain compatibility adapter:

```bash
export AI_OFFICE_LLM_MODEL=openai:gpt-5.4
export OPENAI_API_KEY=<your-key>

bun run daemon
bun run cli -- pricing:set --provider openai --model gpt-5.4 --currency USD --input <micros> --cached-input <micros> --output <micros> --reasoning <micros>
```

Or use Anthropic with the same onboarding and metering path:

```bash
export AI_OFFICE_LLM_MODEL=anthropic:claude-sonnet-4-6
export ANTHROPIC_API_KEY=<your-key>

bun run daemon
bun run cli -- pricing:set --provider anthropic --model claude-sonnet-4-6 --currency USD --input <micros> --cached-input <micros> --output <micros> --reasoning <micros>
```

The model prefix selects the provider; it is not part of the pricing model key. The legacy combination `AI_OFFICE_LLM_PROVIDER=openai` plus `AI_OFFICE_LLM_MODEL=<bare-model>` remains temporarily supported, but new configuration should use the single prefixed model reference.

If the optional provider, model, or required credential is not configured, only
the legacy `project:onboard` command fails. Skill-first onboarding and the rest
of the base runtime remain usable. Provider errors do not display secret values
or change existing questions or answers.

For current command syntax and the complete command list, use:

```bash
bun run cli -- --help
```

## Architecture

The primary interactive interface is the repository-scoped skill. The CLI is a
machine interface to the daemon. Web and MCP are future product surfaces.

```text
Host agent + ai-office skill          Web / MCP (targets)
               \                         /
                +-- CLI / protocol --+
                          |
                    local daemon
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

An agent run can carry one structured controlled-action intent. After creating a
task, synchronizing agents, registering a resource, and granting the agent a
capability, schedule and execute the bridge with:

```bash
bun run cli -- run:schedule \
  --project <project-id> \
  --task <task-id> \
  --agent <agent-id> \
  --resource <resource-id> \
  --operation filesystem.create \
  --arguments '{"path":"notes/from-agent.txt","content":"Created through M6D-lite\n"}'

bun run cli -- run:tick --project <project-id>
bun run cli -- run:show --project <project-id> --run <run-id>
```

`run:tick` returns the action ID. Mutations remain simulations until the operator
uses `action:approve` and `action:execute`; scheduling a run never grants a
capability or bypasses approval.

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

## Local storage and state

AI Office is primarily local to the directory where its daemon runs today. In
the current implementation, the production daemon and CLI derive this **runtime
root** from their current working directory; there is no public data-directory
flag or environment setting. Starting the daemon creates and migrates
`<runtime-root>/.ai-office/project.sqlite` before opening the socket. The
production CLI is only a daemon client (except for local help), so the daemon
owns operational access to that database. `bun run db:migrate` can also migrate
the same current-working-directory database directly.

Three path roles are independent in the current implementation:

- **Runtime root:** the daemon's operational location, selected by its current
  working directory. It owns `.ai-office/project.sqlite`, SQLite sidecars,
  `.ai-office/daemon.sock`, onboarding drafts, and generated Markdown.
- **Source/import root:** the repository scanned by `project:import <path>`. The
  scan records its canonical path in the current runtime database but does not
  move or create that database under the imported repository.
- **Integration root:** the target repository supplied explicitly to
  `client:inspect`, `client:plan`, `client:apply`, and `client:validate` with
  `--root <path>`. The instruction contract must be inside this root, and
  `AGENTS.md` plus `CLAUDE.md` are inspected or managed there.

These roots often coincide in a simple setup, but they are not required to do
so. One runtime database can contain more than one imported project ID, and an
integration root can differ from both the runtime root and the source/import
root. When paths differ, back up each kind of state at the root that owns it.

The intended three-database layout is:

```text
~/.ai-office/
└── global.sqlite                 # schema exists; not created or used by the daemon

<runtime-root>/
└── .ai-office/
    ├── project.sqlite            # active, authoritative operational state
    ├── project.sqlite-wal        # SQLite sidecar while the database is open
    ├── project.sqlite-shm        # SQLite sidecar while the database is open
    ├── daemon.sock               # ephemeral local daemon IPC socket
    ├── index.sqlite              # schema exists; not created or used by the daemon
    ├── drafts/                   # optional onboarding proposals
    └── generated/                # regenerable Markdown projections

<integration-root>/
├── .ai-office/
│   └── agent-instructions.json   # optional coding-client contract input
├── AGENTS.md                     # canonical project instructions
└── CLAUDE.md                     # optional Claude import bridge
```

Only `project.sqlite` and its live SQLite sidecars plus `daemon.sock` are
created by normal daemon operation today. Runtime-root drafts and generated
files appear only when their corresponding workflow is used. Integration
artifacts appear only under the separately selected integration root.
`global.sqlite` and `index.sqlite` are shown to explain the planned boundary;
production code does not currently open or create either file.

For example, suppose AI Office starts from `/Users/alice/dev/ai-office`, then
imports and integrates `/Users/alice/dev/my-product`:

```bash
bun run cli -- project:import /Users/alice/dev/my-product
bun run cli -- client:inspect --client claude --root /Users/alice/dev/my-product
```

The resulting path ownership can be:

```text
/Users/alice/dev/ai-office/
└── .ai-office/
    ├── project.sqlite            # authoritative runtime database
    └── daemon.sock

/Users/alice/dev/my-product/
├── .ai-office/
│   └── agent-instructions.json   # integration contract input
├── AGENTS.md
└── CLAUDE.md
```

`my-product` is the source/import root and, for the client commands, the
integration root. The runtime database remains under `ai-office`; importing or
integrating `my-product` does not relocate it.

| Path                                       | Scope and purpose                                                     | Current status                            | Authority and deletion impact                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `<runtime-root>/.ai-office/project.sqlite` | Projects known to this runtime and their operational state            | Active; opened and migrated by the daemon | **Authoritative, not a cache.** Deleting it removes persisted AI Office knowledge and history from this runtime.  |
| `~/.ai-office/global.sqlite`               | Future user-level roles, patterns, and lessons shared across projects | Initial migration only; M7 is future      | Intended to be durable global knowledge, but AI Office writes no production data there today.                     |
| `<runtime-root>/.ai-office/index.sqlite`   | Future per-project derived code intelligence                          | Initial migration only; M8 is future      | Intended to be regenerable from source and authoritative metadata; there is no populated index to preserve today. |

Project migrations are versioned under `migrations/project/`, applied
transactionally, and tracked in `schema_migration`. SQLite runs in WAL mode;
while the daemon is running, committed data may still be represented by the
`-wal` file, so do not copy or delete the main database in isolation.

### Authoritative project state

`project.sqlite` stores the information AI Office cannot reconstruct merely by
scanning source code. In user-facing groups, that currently includes:

- project records, imported-source metadata, scan history, detected and
  user-supplied profile knowledge, onboarding state, and immutable office
  manifest revisions;
- tasks, roles, agents, scheduled runs, run results and events, and task locks;
- project budgets and reservations, normalized model usage, costs, and the
  pricing versions used to calculate them;
- milestones, requirements, ADR records, reviews, and governance approvals;
- registered resource metadata and credential references (not raw
  credentials), capability grants, controlled-action requests and simulations,
  local action approvals, execution records, and audit events.

Deleting `<runtime-root>/.ai-office/project.sqlite` is therefore effectively a
reset of the AI Office state held by that runtime. Deleting the entire
`<runtime-root>/.ai-office/` also removes that database and may discard drafts
or generated projections. It does not delete the source repository outside
`.ai-office/`, but it can remove authoritative state for every project imported
into that runtime database. Client-contract inputs are affected only when the
integration root is the same directory as the runtime root.

For example, if AI Office is run separately with each repository as its runtime
root, the databases are independent:

```text
/Users/alice/dev/my-project/
└── .ai-office/
    └── project.sqlite            # state in the my-project runtime

/Users/alice/dev/project-b/
└── .ai-office/
    └── project.sqlite            # independent project-b runtime
```

By contrast, `~/.ai-office/global.sqlite` is user-scoped rather than
repository-scoped. Its initial schema defines reusable roles, patterns, and
lessons, but the daemon does not use it and reusable memory remains future M7
work. No production AI Office state is currently written under the user's home
directory by this storage subsystem.

### Regenerable, generated, and ephemeral files

- `index.sqlite` is the future M8 code-intelligence boundary. Its initial schema
  covers indexed files, symbols, code edges, chunks, and FTS. No production
  indexer opens or populates it today. Once implemented, it is designed to be
  derived data, unlike `project.sqlite`.
- `daemon.sock` is an ephemeral owner-only Unix socket. A clean daemon shutdown
  removes it; startup replaces an unreachable stale socket. It is not backup
  data.
- `project.sqlite-wal` and `project.sqlite-shm` are SQLite runtime sidecars, not
  independent databases. Never remove them while the daemon is running.
- `drafts/office-manifest.json` is an optional skill-created proposal. After
  `office:apply`, the accepted manifest revision is authoritative in SQLite;
  deleting an unapplied draft still loses that proposal.
- `generated/project-profile.md` and `generated/governance.md` are
  deterministic, one-way projections. They can be recreated with the
  corresponding export commands and are never read back as authoritative
  state.
- The current worktree manager only simulates paths such as
  `.ai-office/worktrees/<run-id>`; normal production runs do not create those
  directories yet.

### Runtime state versus coding-client files

The runtime root's `.ai-office/` is daemon operational material and is
conceptually separate from source such as `src/` and `docs/`. Coding-client
integration is another concern and may target a different repository. Relative
to the explicit `client:* --root`, the workflow may use
`.ai-office/agent-instructions.json` as its contract input, create an
AI Office-owned `AGENTS.md` when none exists, or maintain a marked import bridge
inside `CLAUDE.md`.

AI Office never blindly overwrites a user-owned `AGENTS.md`; it reports that
file as unmanaged. Existing Claude instructions are preserved and only the
identifiable managed bridge is created or updated after approval of the exact
plan hash. These files configure how a client consumes project instructions;
they are not SQLite runtime state, an office manifest, a capability grant, or
agent authorization. Inspect their ownership and Git status before removing
them. See the [client integration guide](docs/development/agent-client-integration.md)
for the complete ownership and validation contract.

This repository's `.gitignore` deliberately ignores local SQLite files and
sidecars, sockets, `generated/`, and `drafts/` under `.ai-office/`; it does not
ignore the entire directory. The optional `agent-instructions.json` contract is
not ignored by that rule. Repository-owned `AGENTS.md`, `CLAUDE.md`, and
`.agents/skills/` may intentionally be versioned. Treat runtime database files
as local state and decide separately which client-integration artifacts belong
in source control.

### Backup, purge, and re-onboarding

There is no built-in backup/restore or legacy-state import command yet; those
remain future productization work. Before a purge, inspect the current runtime
with the relevant `project:*`, `office:*`, `task:*`, `run:*`, `cost:*`,
governance, capability, and action commands. Then stop the foreground daemon
with `Ctrl-C` so it closes SQLite and removes the socket. From the verified
runtime root, make a filesystem backup:

```bash
cp -R .ai-office ../my-project-ai-office-backup
```

At minimum preserve `project.sqlite`. Copying the whole runtime directory after
a clean shutdown also preserves unapplied office drafts and generated
projections. It preserves the optional client contract only when the integration
root and runtime root coincide; otherwise inspect and back up
`<integration-root>/.ai-office/agent-instructions.json`, `AGENTS.md`, and
`CLAUDE.md` separately according to their ownership. Do not copy only
`project.sqlite` while the daemon is running because its WAL may contain
committed state. Keep the backup outside the `.ai-office/` directory you intend
to purge and verify that the copy exists. Then generate and inspect the local
purge plan while the daemon remains stopped:

```bash
bun run cli -- runtime:purge
bun run cli -- runtime:purge --approve <plan-hash>
```

The plan hash binds the current runtime artifacts. A concurrent change makes
the approval stale. Purge removes only known runtime-owned SQLite files and
sidecars, a stale daemon socket, drafts, and generated projections. It preserves
unknown `.ai-office/` entries, including an integration contract, and removes
the state directory only when it becomes empty. It does not remove source,
`node_modules`, Bun, global user configuration, or files in a distinct
integration root.

A clean re-onboarding sequence is conceptually:

```text
inspect existing AI Office state
  -> stop the daemon
  -> back up the runtime root's .ai-office/
  -> purge only that local runtime state
  -> start the current AI Office version
  -> project:import
  -> office onboarding
  -> coding-client integration, if desired
```

`project:import` rescans the source repository and recreates detected project
facts in the current database. It does **not** recover previous tasks, runs,
manifest revisions, budgets or costs, governance history, capability grants,
controlled-action approvals or executions, or audit events. Re-importing source
and restoring operational state are different operations.

Likewise, re-onboarding and authorization are separate. AI Office has no legacy
state migrator today, and a future migration must not treat an archived
capability grant, action approval/execution authorization, credential reference,
or ephemeral authorization state as trusted merely because it appeared in an
old database. Restore old operational state only through a future documented
compatibility path; otherwise retain the backup as the historical record and
re-establish current authorization explicitly.

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
  agent-client-integrations/ Codex and Claude detection/config adapters
  llm-gateway/            providers, pricing, budgets, and usage
  orchestration/          scheduling abstractions
  connector-sdk/          connector contracts and registry
  filesystem-connector/   scoped filesystem adapter and sandbox
migrations/               project, global, and index SQL migrations
agents/                    bundled YAML agent definitions
.agents/skills/ai-office/  conversational product workflow
patterns/                  reusable pattern source material
docs/                      architecture, development, ADRs, and history
spikes/                    research prototypes; not production code
tests/                     unit, integration, security, and daemon/CLI E2E tests
```

The Rust/native filesystem work under `spikes/` is research evidence for future hardening. It is not linked into the production connector.

## Development

Primary local validation is:

```bash
bun run check
git diff --check
```

CI installs dependencies with the frozen lockfile, runs strict TypeScript
typechecking, ESLint, and the deterministic Vitest suite, and checks the
committed diff for whitespace errors. Standard CI does not make paid provider
calls.

## Coding client integration

Within the selected integration root, AI Office uses `AGENTS.md` as the
canonical project operating contract. Codex loads it natively; Claude Code can
use a minimal `CLAUDE.md` import bridge. Client detection and inspection are
passive, and configuration mutation requires an explicit hash from the exact
proposed plan:

```bash
bun run cli -- client:detect
bun run cli -- client:inspect --client claude --root /path/to/integration-root
bun run cli -- client:plan --client claude --root /path/to/integration-root \
  --contract .ai-office/agent-instructions.json
bun run cli -- client:apply --client claude --root /path/to/integration-root \
  --contract .ai-office/agent-instructions.json --approve <plan-hash>
bun run cli -- client:validate --client claude --root /path/to/integration-root
```

AI Office never overwrites user-owned `AGENTS.md`. Existing Claude instructions
are preserved and only an identifiable managed bridge is maintained. A
user-owned canonical file remains `unmanaged`: the client can consume it, but AI
Office does not claim that the supplied contract was installed. These commands
do not modify global Codex/Claude configuration and remain separate from project
onboarding. See the [client integration guide](docs/development/agent-client-integration.md).

Uninstallation uses the same inspect-plan-approve discipline. Running the
command without `--approve` returns the exact removal plan and hash; passing
that hash applies only ownership-safe changes:

```bash
bun run cli -- client:uninstall --client claude --root /path/to/integration-root
bun run cli -- client:uninstall --client claude --root /path/to/integration-root \
  --approve <plan-hash>
```

Claude uninstall removes only its managed bridge. Codex uninstall removes an
AI Office-owned canonical `AGENTS.md`; user-owned direct imports and instruction
files are preserved. To remove both managed integrations, uninstall Claude
first and Codex second so Claude is never left pointing at a removed canonical
file.

Read [AGENTS.md](AGENTS.md) before changing code. It defines the canonical
operating contract, invariants, scope rules, and definition of done.

## Documentation

The [documentation index](docs/README.md) explains which documents are current architectural truth and which preserve milestone-specific or historical research. In short:

- README: product overview and getting started;
- AGENTS: development operating contract;
- architecture docs: current architectural truth;
- roadmap: milestone scope and status;
- accepted ADRs: architectural decisions;
- implementation docs: historical and milestone detail;
- `bun run cli -- --help`: command syntax.

## Roadmap

The authoritative [development roadmap](docs/development/roadmap.md) records
completed and future milestones. M6D-lite connects structured run intents to the
controlled-action gateway. Skill-first onboarding adds a provider-neutral host
experience plus versioned office and pipeline configuration. Agent client
integration adds a canonical instruction contract plus Codex and Claude
adapters. Reusable memory, code intelligence, autonomous
context/tool selection, productization, and hostile-local security hardening
remain future work.

## Security and current trust model

M6C-lite assumes a local, single-user deployment in the user's trust domain. It protects against accidental or unauthorized agent access, path escape, sensitive-path access, stale simulations and capabilities, replay, and unapproved filesystem mutation.

It does not defend against a hostile process running with the same Unix credentials and concurrently mutating the same filesystem namespace. Local approval records an operator-supplied audit identity; it is not cryptographic proof of human presence. Rust/`openat2`, authenticated approvals, tamper-evident audit, and stronger crash reconciliation are M10 research and roadmap items, not production claims today.

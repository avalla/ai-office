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
- versioned global roles and patterns, lessons, project adoption, and cross-project search;
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
  -> ai-office install/status/task commands
  -> repository-scoped ai-office skill when conversation is needed
  -> machine-oriented CLI
  -> HTTP over <runtime-home>/daemon.sock
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

Install dependencies and expose the source checkout's linkable CLI:

```bash
bun install --frozen-lockfile
bun link
```

The repository is not yet published as a packaged binary. The bare `bun link`
command registers this checkout in Bun's global link registry and exposes its
declared `ai-office` bin; do not follow it with
`bun link --global ai-office`. Ensure the path printed by `bun pm bin -g` is on
`PATH`. If the obsolete two-command sequence was already attempted and left a
dangling bin link, rerun the bare `bun link` command from this checkout to
repair it. The same entry point can also be run from this checkout as
`bun run ai-office -- install /absolute/path/to/project`.

Start the office daemon in one terminal:

```bash
ai-office daemon
```

Then install AI Office from the repository you want to manage:

```bash
cd /path/to/my-project
ai-office install .
ai-office status
```

`install` imports or reuses the project, applies the default office baseline
only when no manifest exists, writes `.ai-office/project.json`, detects supported
coding clients, and reconciles the repository-local files AI Office can safely
manage. For detected Codex or Claude hosts this includes the shared
`AI-OFFICE.md` guide, minimal host pointers, and a discoverable repository-local
`ai-office` skill. It does not install third-party software, overwrite
user-owned instructions or skills, grant capabilities, or copy the authoritative
database into the project. Exit code `0` means installed without issues, `2` means installed with
actionable warnings, and `1` means failed or partial. JSON output uses the same
`installed`, `installed_with_warnings`, or `partial` outcome semantics.

`status` works from the project root or a descendant. It reports the project
identity, runtime-association validity, daemon and authoritative-state availability, office
revision, client integration, and lightweight task counts. Use
`ai-office status --json` for the stable schema-version `3` machine output.
Lifecycle commands first select the nearest valid AI Office binding within the
current Git worktree. On first install they select that worktree root; a
standalone non-Git directory remains its own project root. Running `install .`,
`status .`, or `uninstall .` from a package directory therefore cannot create
or mutate a second project binding there.

The JSON envelope is versioned independently from the binding:

```json
{
  "schemaVersion": 3,
  "installed": true,
  "health": "healthy",
  "project": {
    "id": "...",
    "name": "Example",
    "root": "/canonical/project/root",
    "repositoryIdentity": {
      "id": "repo_...",
      "path": ".../.ai-office/project.json",
      "state": "valid"
    },
    "runtimeAssociation": { "projectId": "...", "state": "valid" }
  },
  "runtime": {
    "daemon": "reachable",
    "home": "/home/user/.ai-office",
    "authoritativeState": "available"
  },
  "office": {
    "state": "default_baseline",
    "onboarding": "not_completed",
    "revision": 1,
    "name": "...",
    "roles": []
  },
  "clients": [],
  "tasks": { "open": 0, "wip": 0 },
  "issues": []
}
```

Repository identity states are `missing`, `invalid`, `legacy`, or `valid`;
runtime association states are reported independently as `missing`, `unverified`,
`conflicting`, `project_missing`, or `valid`. A future
breaking field or semantic change requires a new `schemaVersion`; schema version
`2` output keeps deterministic key and array ordering for identical state.

Lifecycle paths are canonicalized through one repository-root resolver. A
valid binding inside the nearest Git worktree wins; otherwise first install
uses that worktree root. A non-Git directory falls back to the exact canonical
path. Nested Git worktrees remain distinct, while ordinary package directories
cannot become accidental projects merely because the command was run there.

Interactive onboarding, offline import, task management, governance, and
simulated agent runs do not require an LLM credential in AI Office. The
repository-scoped skill uses the model session already authenticated by the
host to generate adaptive questions and synthesize the office. The daemon does
not expose a separate provider-backed onboarding command. A `.env` file is not
required for normal operation; never commit one containing credentials.

The linkable entry point uses `AI_OFFICE_HOME` when set and otherwise the stable
user runtime `~/.ai-office`, so moving or relinking the program does not select
a different authority. One daemon can manage multiple installed repositories.
The legacy development
commands `bun run daemon` and `bun run cli -- ...` remain supported and retain
their current-working-directory runtime semantics. See
[Local storage and state](#local-storage-and-state) for the advanced path model.

## Project lifecycle

The repository-local binding is deliberately small and safe to commit:

```json
{
  "schemaVersion": 2,
  "managedBy": "ai-office",
  "repositoryId": "repo_..."
}
```

It contains no runtime path, credential, capability grant, client executable
path, runtime `projectId`, or copied project state. SQLite remains authoritative
and maps this portable identity to its own project ID and canonical checkout
paths. A fresh clone or purged runtime establishes that local mapping through
ordinary `ai-office install .`; `--rebind` is reserved for a copied or
intentionally split identity. Additional checkouts of an already-known identity
must match a known Git remote or installation fails closed.

Project-local removal is also explicit and non-destructive to runtime state:

```bash
ai-office uninstall .
# Inspect the affected paths and plan hash, then:
ai-office uninstall . --approve <plan-hash>
```

The lifecycle preflights the complete exact plan, removes managed client
integration in dependency order, and detaches only this canonical checkout. It
preserves the portable `project.json`, user-owned instructions, unrelated
`.ai-office/` entries, the project and other checkouts in `project.sqlite`, the
whole runtime, and `global.sqlite`. A failure after mutation reports removed and
possibly modified paths; it does not claim filesystem atomicity or attempt a
cross-SQLite/filesystem rollback. `uninstall`, project-state deletion,
`runtime:purge`, and global-memory deletion are different operations.

## Conversational onboarding

Open this repository in Codex and ask:

```text
Use $ai-office to onboard /path/to/repository
```

The skill scans the repository offline, reads the resulting structured context,
uses the active Codex or Claude model to generate only material project
questions, proposes a virtual office and default task pipelines, validates the
manifest, and asks for confirmation before applying it.
The runtime stores each accepted manifest as an immutable revision and records a
sanitized audit event. Permission preferences remain project knowledge; they do
not create capability grants.

The distribution skill is checked in at `.agents/skills/ai-office`; normal
install also projects a self-contained repository skill at that path in the
target project and a Claude discovery wrapper under `.claude/skills`. Its
default manifest is a starting point, not an automatic grant or fixed
organization.

## Machine interface

Import an existing repository, then inspect its structured profile:

```bash
ai-office project:import /path/to/repository --json
# Read projectId from the JSON result.

ai-office project:profile --project <project-id>
ai-office office:context --project <project-id>
```

For a new project without an import scan:

```bash
ai-office project:create "Demo"
ai-office task:create --project <project-id> --title "First task" --priority 10
ai-office task:list --project <project-id>
```

`project:import` never calls a provider: its repository scan remains
deterministic, idempotent, and usable offline. `office:validate`, `office:apply`,
`office:show`, and `office:pipeline` form the versioned machine contract used by
the skill. There is no provider-backed onboarding command in the daemon; Codex
or Claude owns questions and synthesis, while SQLite remains authoritative for
accepted manifests and project state.

When a project-scoped command is invoked without `--project`, the linkable CLI
canonicalizes the current directory, walks same-filesystem ancestors, and uses
the nearest valid `.ai-office/project.json`. Explicit `--project` remains
available for automation and debugging. The machine-oriented commands are
preserved as primitives under the user-facing lifecycle; they are not a second
source of truth.

For current command syntax and the complete command list, use:

```bash
ai-office --help
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

The linkable `ai-office` entry point keeps user data independently from the
program checkout. It selects `AI_OFFICE_HOME` when explicitly set and otherwise
uses `~/.ai-office` as the **runtime data root**. Starting the daemon creates and
migrates `<runtime-home>/project.sqlite` before opening
`<runtime-home>/daemon.sock`. The legacy `bun run daemon` and `bun run cli`
development scripts deliberately retain `<cwd>/.ai-office` semantics. The
production CLI is only a daemon client (except for local help), so the daemon
owns operational access to that database. `bun run db:migrate` can also migrate
the same current-working-directory database directly.

Three path roles are independent in the current implementation:

- **Runtime data root:** stable user data selected by `AI_OFFICE_HOME` or
  `~/.ai-office`. It directly owns `project.sqlite`, SQLite sidecars,
  `daemon.sock`, onboarding drafts, generated Markdown, and global memory.
- **Source/import root:** the repository scanned by `project:import <path>`. The
  scan records its canonical path in the current runtime database but does not
  move or create that database under the imported repository.
- **Integration root:** the target repository supplied explicitly to
  `client:inspect`, `client:plan`, `client:apply`, and `client:validate` with
  `--root <path>`. The optional instruction contract must be inside this root;
  the shared guide, host pointers, and repository skills are inspected or
  managed there.

These roots often coincide in a simple setup, but they are not required to do
so. One runtime database can contain more than one imported project ID, and an
integration root can differ from both the runtime root and the source/import
root. When paths differ, back up each kind of state at the root that owns it.

The intended three-database layout is:

```text
~/.ai-office/                     # or the explicit AI_OFFICE_HOME
├── project.sqlite                # active, authoritative operational state
├── project.sqlite-wal            # SQLite sidecar while the database is open
├── project.sqlite-shm            # SQLite sidecar while the database is open
├── daemon.sock                   # ephemeral local daemon IPC socket
├── global.sqlite                 # durable reusable memory
├── index.sqlite                  # schema exists; not used by the daemon
├── drafts/                       # optional onboarding proposals
└── generated/                    # regenerable Markdown projections

<integration-root>/
├── .ai-office/
│   ├── project.json              # committable repository identity; not authority
│   └── agent-instructions.json   # optional machine-workflow contract input
├── AI-OFFICE.md                  # shared derived project guidance
├── AGENTS.md                     # minimal Codex pointer
├── CLAUDE.md                     # optional Claude import bridge
├── .agents/skills/ai-office/SKILL.md
└── .claude/skills/ai-office/SKILL.md
```

Normal daemon operation creates `project.sqlite`, its live SQLite sidecars, and
`daemon.sock`. The first `memory:*` command creates or upgrades `global.sqlite`
in the selected user runtime home. Runtime drafts, generated files, and
integration artifacts appear only when their corresponding workflow is used.
`index.sqlite` remains a planned boundary and is not opened or populated.

The normal `install` lifecycle makes the source/import root and integration root
the same canonical repository and writes only `project.json` below its
`.ai-office/`. It derives the coding-client contract in memory from the current
office configuration. The optional `agent-instructions.json` remains supported
for the lower-level `client:*` workflow, but `install` does not create another
persisted contract or source of truth.

For example, the installed entry point can import and integrate
`/Users/alice/dev/my-product` while its own checkout lives anywhere:

```bash
bun run cli -- project:import /Users/alice/dev/my-product
bun run cli -- client:inspect --client claude --root /Users/alice/dev/my-product
```

The resulting path ownership can be:

```text
~/.ai-office/
├── project.sqlite                # authoritative multi-project runtime
├── daemon.sock
└── global.sqlite

/Users/alice/dev/my-product/
├── .ai-office/
│   └── project.json              # portable repository identity anchor
├── AI-OFFICE.md                  # shared, derived, safe to commit
├── AGENTS.md                     # minimal Codex pointer
├── CLAUDE.md                     # managed @AI-OFFICE.md bridge
├── .agents/skills/ai-office/SKILL.md
└── .claude/skills/ai-office/SKILL.md
```

`my-product` is the source/import root and, for the client commands, the
integration root. The runtime database remains under the stable user home;
moving or reinstalling the AI Office program does not relocate or replace it.

| Path                                     | Scope and purpose                                          | Current status                             | Authority and deletion impact                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `<runtime-home>/project.sqlite`          | Projects known to this runtime and their operational state | Active; opened and migrated by the daemon  | **Authoritative, not a cache.** Deleting it removes persisted AI Office knowledge and history from this runtime. |
| `<runtime-home>/global.sqlite`           | User-level roles, patterns, and lessons                    | Active; migrated lazily by memory commands | **Durable global knowledge.** Preserved by `runtime:purge`; deleting it explicitly removes reusable definitions. |
| `<runtime-home>/index.sqlite`            | Future derived code intelligence                           | Initial migration only; M8 is future       | Intended to be regenerable; there is no populated index to preserve today.                                       |
| `<project-root>/.ai-office/project.json` | Portable repository identity                               | Active; created by `install`               | **Not authoritative.** Safe to commit and preserved by local uninstall.                                          |

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

Deleting `<runtime-home>/project.sqlite` is therefore effectively a
reset of the AI Office state held by that runtime. Deleting the entire
runtime home also removes that database and may discard drafts
or generated projections. It does not delete the source repository outside
`.ai-office/`, but it can remove authoritative state for every project imported
into that runtime database. Client-contract inputs are affected only when the
integration root is the same directory as the runtime root.

Separate runtimes are selected explicitly, not inferred from repositories:

```text
AI_OFFICE_HOME=/Users/alice/.ai-office-work ai-office daemon
AI_OFFICE_HOME=/Users/alice/.ai-office-personal ai-office daemon
```

By contrast, `<runtime-home>/global.sqlite` is user/runtime-scoped rather than
repository-scoped. With the default runtime this is
`~/.ai-office/global.sqlite`; an explicit `AI_OFFICE_HOME` selects the matching
global-memory authority too. Daemon-backed `memory:*` commands store reusable roles,
versioned patterns, and lessons there. Role versions are immutable revisions of
one logical role key and can be retrieved exactly; deprecation applies to one
exact revision without deleting history. Project pattern-adoption references
stay in each runtime's authoritative `project.sqlite`. Repeated adoption keeps
the last recorded query when no new query is supplied and replaces it when an
explicit non-empty query is supplied.

The default global memory is a user-level trust boundary shared by commands
using the default runtime. Explicitly isolated runtime homes have explicitly
isolated global memory. Agents never receive direct database or raw SQL access,
and lesson extraction remains an explicit validated command.
`sourceProjectId` and `sourceTaskId` in global memory are historical provenance
identifiers validated when written, not foreign references whose existence is
guaranteed permanently: the originating `project.sqlite` can later be purged or
belong to another runtime. Global memory remains outside `runtime:purge` and
should be backed up separately from each runtime database. Global audit,
memory-write policy, poisoning protection, and quotas remain deferred.

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

The runtime home is daemon operational material and is
conceptually separate from source such as `src/` and `docs/`. Coding-client
integration is another concern and may target a different repository. Relative
to the explicit `client:* --root`, the workflow may use
`.ai-office/agent-instructions.json` as its contract input, project shared
guidance to `AI-OFFICE.md`, create a minimal AI Office-owned `AGENTS.md` pointer,
maintain a marked import bridge inside `CLAUDE.md`, and install repository-local
skills for supported hosts.

AI Office never blindly overwrites a user-owned guide, pointer, or skill; it
reports that artifact as unmanaged. Existing Claude instructions are preserved
and only the identifiable managed bridge is created or updated after approval
of the exact plan hash. These files configure how a client consumes project instructions;
they are not SQLite runtime state, an office manifest, a capability grant, or
agent authorization. Inspect their ownership and Git status before removing
them. See the [client integration guide](docs/development/agent-client-integration.md)
for the complete ownership and validation contract.

This repository's `.gitignore` deliberately ignores local SQLite files and
sidecars, sockets, `generated/`, and `drafts/` under `.ai-office/`; it does not
ignore the entire directory. The optional `agent-instructions.json` contract is
not ignored by that rule. Repository-owned `AI-OFFICE.md`, `AGENTS.md`,
`CLAUDE.md`, `.agents/skills/`, and `.claude/skills/` may intentionally be
versioned. Treat runtime database files
as local state and decide separately which client-integration artifacts belong
in source control.

### Backup, purge, and re-onboarding

There is no built-in backup/restore or legacy-state import command yet; those
remain future productization work. Before a purge, inspect the current runtime
with the relevant `project:*`, `office:*`, `task:*`, `run:*`, `cost:*`,
governance, capability, and action commands. Then stop the foreground daemon
with `Ctrl-C` so it closes SQLite and removes the socket. Back up the selected
runtime home (the default is shown):

```bash
cp -R ~/.ai-office /path/to/ai-office-backup
```

At minimum preserve `project.sqlite`. Copying the whole runtime directory after
a clean shutdown also preserves unapplied office drafts and generated
projections. It preserves the optional client contract only when the integration
root and runtime root coincide; otherwise inspect and back up
`<integration-root>/.ai-office/agent-instructions.json`, `AI-OFFICE.md`, host
pointers, and repository skills separately according to their ownership. Do not copy only
`project.sqlite` while the daemon is running because its WAL may contain
committed state. Keep the backup outside the runtime home you intend
to purge and verify that the copy exists. Then generate and inspect the local
purge plan while the daemon remains stopped:

```bash
bun run cli -- runtime:purge
bun run cli -- runtime:purge --approve <plan-hash>
```

The plan hash binds every current runtime entry that may be removed. A
concurrent change makes the approval stale. Purge removes only planned and
revalidated runtime-owned project SQLite files and sidecars, a stale daemon
socket, drafts, and generated projections. `global.sqlite` is unknown to the
purge ownership list and is preserved. Directory cleanup is non-recursive, so an
unexpected entry introduced during apply survives and keeps its directory from
being removed. Purge preserves unknown runtime-home entries and removes the
runtime home only when it becomes empty. It does not remove source,
`node_modules`, Bun, global user
configuration, or files in a distinct integration root.

A clean re-onboarding sequence is conceptually:

```text
inspect existing AI Office state
  -> stop the daemon
  -> back up the selected runtime home
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

Within the selected integration root, AI Office uses `AI-OFFICE.md` as the
shared derived project guide. Codex gets a minimal `AGENTS.md` pointer and a
skill under `.agents/skills`; Claude gets a managed `CLAUDE.md` import and a
small discovery wrapper under `.claude/skills`. Client detection and inspection
are passive, and configuration mutation requires an explicit hash from the
exact proposed plan:

The normal `ai-office install .` lifecycle composes detect, inspect, plan,
apply, and validate for detected or already managed clients. It still computes
and applies each exact plan hash internally, in sequence, and reports every
created or updated path. Use the commands below directly for automation,
debugging, or a custom instruction contract:

```bash
bun run cli -- client:detect
bun run cli -- client:inspect --client claude --root /path/to/integration-root
bun run cli -- client:plan --client claude --root /path/to/integration-root \
  --contract .ai-office/agent-instructions.json
bun run cli -- client:apply --client claude --root /path/to/integration-root \
  --contract .ai-office/agent-instructions.json --approve <plan-hash>
bun run cli -- client:validate --client claude --root /path/to/integration-root
```

AI Office never overwrites user-owned guidance, pointers, or skills. Existing
Claude instructions are preserved and only an identifiable managed bridge is
maintained. A user-owned artifact remains `unmanaged`: the client can consume
it, but AI Office does not claim that the supplied contract was installed. These commands
do not modify global Codex/Claude configuration and remain separate from project
onboarding. See the [client integration guide](docs/development/agent-client-integration.md).

When the daemon is unavailable, status still verifies deterministic pointers
and repository skills from their managed contracts and reports certain changes
as `drifted`. The current `AI-OFFICE.md` body depends on the authoritative
manifest, so an otherwise intact offline integration is `unverified`, never
misreported as fully `configured`.

Uninstallation uses the same inspect-plan-approve discipline. Running the
command without `--approve` returns the exact removal plan and hash; passing
that hash applies only ownership-safe changes:

```bash
bun run cli -- client:uninstall --client claude --root /path/to/integration-root
bun run cli -- client:uninstall --client claude --root /path/to/integration-root \
  --approve <plan-hash>
```

Claude uninstall removes only its managed bridge and skill wrapper. Codex
uninstall removes its managed pointer. Shared `AI-OFFICE.md` guidance and the
primary `.agents` skill are removed only when Claude no longer depends on them.
To remove both managed integrations, uninstall Claude first and Codex second.
A user-owned direct import remains untouched and keeps shared artifacts in
place until its owner changes that dependency.

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

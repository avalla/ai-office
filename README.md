# AI Office

AI Office is a local AI software office that coordinates agents, keeps structured state in SQLite, manages tasks, runs, governance, budgets, and costs, and mediates agent access to resources through capabilities and controlled actions.

## What AI Office is

AI Office is a Bun and strict TypeScript monorepo built around one authoritative
**AI Office Runtime**. The Runtime owns mutable project state and long-lived
orchestration semantics. A local persistent daemon is its current host; it
exposes a versioned HTTP protocol over an owner-only Unix socket and routes
clients through application services and explicit infrastructure ports.

The product is local-first and auditable: SQLite is authoritative, generated Markdown is a projection, LLM usage is metered through a gateway, and protected resource operations are authorized through capability policy and connector boundaries.

## Current status

The current implementation on `main` includes:

- an authoritative Runtime, a persistent local daemon host, and a Runtime-backed CLI;
- project creation, deterministic offline repository import, and host-skill conversational onboarding without runtime provider credentials;
- a first-connection welcome, deterministic project-handover readiness, and `ai-office next` recommended actions;
- stable project identity plus portable, integrity-checked project backup and restore across machine paths;
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
- authoritative operational read models plus a read-only daemon query API,
  invalidation stream, and local `ai-office dashboard` operations console;
- SQLite persistence, migrations, audit events, and daemon/CLI workflows.

Runs without an action intent still use the deterministic simulated executor.
Controlled runs can request or simulate an authorized connector action and return
its action ID for inspection, approval, and execution. A real LLM tool loop and
Git worktree manager are not implemented, so AI Office is not yet autonomous end
to end.

## How it works

```text
Codex / Claude / CLI / future clients
  -> RuntimeClient
  -> HTTP over <runtime-home>/daemon.sock (current local IPC)
  -> persistent daemon host (current deployment mode)
  -> AI Office Runtime
  -> application services and domain rules
  -> SQLite repositories / LLM gateway / controlled connectors
```

Stateful product commands go through the authoritative Runtime; there is no
automatic embedded or direct-SQLite fallback. Short writes use
application-level transactions; provider calls, scans, simulated agent work,
and filesystem side effects do not run inside an open SQLite transaction. Help
and explicit `status --offline` can run locally. Source-linked `update` is a
local maintenance operation with a health-only Runtime preflight. The destructive
`runtime:purge` lifecycle command is available only while the Runtime host is
stopped.

The daemon is not only a command execution surface. The same socket carries a
separately versioned, read-only query surface that publishes authoritative
operational read models:

```text
                  AI OFFICE DAEMON
                         |
        +----------------+----------------+
        |                |                |
     Commands          Queries          Events
        |                |                |
       CLI          Dashboard/API    invalidation
      Agents          Humans            stream
```

## Quick start

This checkout is a source distribution, including when installed with `bun link`.
To deliberately use the personal Runtime, set
`AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1` in that terminal. Without this opt-in,
the source bin refuses operational commands before contacting the Runtime.
Help remains available. `AI_OFFICE_HOME` selects the destination but is not the
opt-in. For isolated development, use `bun run dev:daemon` and
`bun run dev:cli -- <command>`: both select this source checkout's `.ai-office/`
regardless of the invoking directory or ambient `AI_OFFICE_HOME`. Project and
global-memory databases are isolated together; diagnostics go to stderr.
Development data persists until explicitly removed through supported lifecycle
operations. Linked worktrees select their own source checkout's runtime.

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

Start the persistent Runtime host in one terminal:

```bash
ai-office runtime start
```

The existing `ai-office daemon` command remains a compatibility alias.

Then install AI Office from the repository you want to manage:

```bash
cd /path/to/my-project
ai-office install .
ai-office status
ai-office next
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
identity, runtime-association validity, Runtime-host and authoritative-state availability, office
revision, client integration, and lightweight task counts. Use
`ai-office status --json` for the stable schema-version `4` machine output.
Exit code `0` means nothing needing attention was found in what was inspected
and `1` means a problem was found or the repository is not installed.
Lifecycle commands first select the nearest valid AI Office binding within the
current Git worktree. On first install they select that worktree root; a
standalone non-Git directory remains its own project root. Running `install .`,
`status .`, or `uninstall .` from a package directory therefore cannot create
or mutate a second project binding there.

The JSON envelope is versioned independently from the binding:

```json
{
  "schemaVersion": 4,
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
    "runtimeAssociation": { "projectId": "...", "state": "valid" },
    "stateRevision": { "head": "rev_...", "base": "rev_...", "checksum": "..." }
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
`conflicting`, `project_missing`, or `valid`. `runtime.daemon` is `reachable`,
`unreachable`, or `not_checked`, and `runtime.authoritativeState` adds
`not_checked` alongside `available`, `unavailable`, `project_missing`, and
`repository_unassociated`: a host that was never contacted is a different fact
from a host proved unreachable. `health` is `healthy`, `needs_attention`,
`not_installed`, or `unverified`, the last meaning local evidence found no
problem while authoritative state was not read.

Version `4` added those three values and left every version `3` value meaning
what it meant. A future breaking field or semantic change requires a new
`schemaVersion`; output keeps deterministic key and array ordering for identical
state.

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
the isolated source-checkout runtime semantics of `dev:daemon` and `dev:cli`. See
[Local storage and state](#local-storage-and-state) for the advanced path model.

### Update the source-linked installation

```bash
ai-office update --json
# Review the exact source, target, steps and plan hash, then approve:
ai-office update --approve <plan-hash> --json
```

Stop the selected user Runtime (`AI_OFFICE_HOME`, or `~/.ai-office`) and the
Runtime development host in this distribution's `.ai-office` before updating.
The command probes both homes using only `GET /health`, before Git planning and
again during apply. Any responding listener blocks maintenance; a timeout or
uncertain probe fails closed. Keep hosts stopped throughout the update. Other
arbitrary runtime homes are not discoverable: stop those hosts manually too.

`update` works without `AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1`. This grants
no operational Runtime access: no commands, queries, SQLite reads, migrations,
or project binding inspection occur. The ordinary source CLI still requires
that opt-in. Help (`--help`, `help`, `-h`) stays entirely local before path
resolution, probing, or Git work.

The distribution comes from the source executable, never the current project.
A clean tracked worktree and an upstream branch are required; detached, ahead,
and divergent branches are refused. Planning binds the exact remote target and
a credential-safe remote fingerprint. It may acquire missing Git objects using
a temporary ref, cleaned before any plan is returned, without changing HEAD,
index, worktree, FETCH_HEAD, or ordinary tracking refs. Untracked files do not
invalidate approval; Git refuses conflicting incoming tracked paths.

Apply repeats the preflight, rejects stale approval, and performs only a
fast-forward, `bun install --frozen-lockfile`, and bare `bun link`. Runtime data,
global memory, bindings, and project integrations are preserved. Results are
`updated`, `already_current`, `failed`, or `partial`; errors after the checkout
advances remain partial, with completed steps and manual repair instructions.
There is no automatic rollback, stash, reset, branch switch, Bun update, or
published-package update. Restart the desired host explicitly after a complete
update. See [ADR-0011](docs/adr/ADR-0011-source-linked-program-update.md).

## After installation

The first time a repository becomes known to the runtime, `install` prints a
short welcome and the recommended next steps:

```text
╭────────────────────────────────╮
│  AI OFFICE                     │
│  Your virtual office is ready  │
╰────────────────────────────────╯

AI Office installed.
...
Next
  1. Hand this project over to your virtual office
     AI Office scanned an existing codebase but has no approved product
     context for it
     Ask your AI client:
       "Take this project in charge. Review the repository and the
       current AI Office state, then help me complete the project
       handover."

Try asking your AI client
  "Review the current project and tell me what the office thinks we
  should do next."
  "Show me the current roadmap, milestones and active work."

Commands
  ai-office next
  ai-office status
```

**What was installed.** A committable repository identity in
`.ai-office/project.json`, the shared derived `AI-OFFICE.md` guide, a minimal
pointer for each detected coding client, and a repository-local `ai-office`
skill. Nothing was granted, and no authoritative database was copied into the
repository.

**What to do in the project.** Ask your AI client to take the project in
charge. The installed skill carries one client-neutral handover workflow, so
Codex and Claude Code follow the same steps.

**What happens during handover.** Four things stay deliberately distinct:

1. **Discovery** — the deterministic repository scan records languages,
   frameworks, tooling, documentation, file counts, and commit evidence.
2. **Repository review** — the agent reads the repository and compares it with
   what AI Office already stores.
3. **User confirmation** — you accept or correct that review. Only this makes
   repository understanding authoritative, and it is recorded with
   `ai-office handover:confirm --project <id> --summary "<what the office understood>"`.
4. **Approved organizational model** — `office:apply` records mission, goals,
   constraints, preferences, roles, and pipelines.

An approved office manifest never certifies repository understanding: it
carries no architecture, implementation state, or review acceptance. A project
configured before this feature existed therefore reports repository
understanding as `discovered` and asks you to confirm a review, rather than
silently claiming to be ready.

**What AI Office persists.** Only management state it owns: office manifest
revisions, governance records such as milestones and requirements, tasks,
deterministic repository scan evidence, and the confirmed repository review.
The repository stays authoritative for code, configuration, and technical
documentation.

**Asking "what next?".** `ai-office next` answers from real state:

```text
AI Office · Next steps

Handover
  state: in_progress
  repository: existing
  ✓ Project connection        Repository identity and runtime association are valid
  ~ Repository understanding  Discovered 1 language(s), 0 framework(s), 2 documentation file(s), 30 source file(s); no confirmed handover repository review is recorded
  ✓ Agent clients             2 configured agent clients
  ✓ Product direction         The approved office records 1 goal
  ✓ Delivery plan             1 active milestone, 0 requirement(s)
  ✓ Working agreement         The approved office records 1 constraint(s) and 1 preference(s)

Next
  1. Confirm the handover repository review
     The office holds an approved organizational model but no confirmed
     review of this repository
```

Dimension states are `not_started`, `discovered`, `needs_input`, `ready`, or
`unknown`. Handover states are `not_connected`, `not_imported`,
`needs_handover`, `in_progress`, `ready`, or `unknown`. `ai-office next --json`
returns the same assessment as a stable schema-version `1` payload with
structured `recommendedActions`; it is versioned independently from
`ai-office status --json`, which is unchanged.

**Keeping the review honest.** The confirmation is bound to a fingerprint of
the material repository facts. Ordinary edits keep it valid; a structural
change such as a new language or an order-of-magnitude growth in source files
makes it `stale`, and the office asks you to review the changes before
declaring the project ready again. Unanswered goal and constraint questions
also keep the handover incomplete.

**Checking state and resuming later.** `ai-office status` reports lifecycle
health and ends with a compact pointer to the recommended next action.
Reinstalling an already connected repository reconciles managed files without
replaying the welcome, and uninstall followed by reinstall preserves the
handover state because that state lives in the runtime, not in the repository.

## Hand your project to the virtual office

AI Office is not only a CLI that stores tasks. It is a persistent management
layer around the repository, so agents can work as a virtual office instead of
rebuilding the project context in every session.

Handing a project over means the office understands the project, records the
management state that belongs to its own domain, and can then evaluate a
request such as "I want to add subscription billing" against the recorded
roadmap, milestones, and requirements.

Ask your AI client:

```text
Take this project in charge and use AI Office to understand its current
state before proposing what we should do next.
```

The office distinguishes an existing repository from a new one. For an existing
repository it reconstructs what was already built and what is in progress
before proposing anything. For a nearly empty repository it guides goals,
constraints, architecture, and a first milestone instead. The classification is
deterministic and measures existing application code rather than tooling
presence, because a fresh scaffold already declares a language, a framework,
and a package manager while a long-lived single-language repository may declare
none of them.

Handover transfers organizational context ownership. It is not an
authorization change: it grants no capability, bypasses no approval or
governance gate, alters no policy, starts no agent run, and never rewrites
committed project state to match a proposal.

## Operations dashboard

`ai-office dashboard` serves a local, read-only operations console. The daemon
must already be running; the dashboard never starts it implicitly.

```bash
ai-office dashboard
```

```text
AI Office dashboard
http://127.0.0.1:4278/?token=1f0c…
Read-only. Local same-user surface; the link carries this session's token.
```

It answers the questions you ask between commands: which projects exist, what is
being worked on, which pipeline stage each run is in, which agent is doing what,
what is waiting for a human, what failed, and what happened recently. The page
updates itself as the daemon completes commands. `--port`, `--host`, and
`--no-open` are available; Ctrl-C stops the host and releases the port.

The dashboard does not infer operational state from raw SQLite records. It
consumes the same authoritative application read models any other client would,
so the console, the CLI, and future integrations cannot disagree about what a
task's status means. Where the current domain cannot express something — there
is no persisted task/requirement or task/milestone association — the surface
reports it as unavailable instead of guessing.

It is read-only: no task editing, no pipeline control, no approvals, no
assignment. See the [operational dashboard guide](docs/development/dashboard.md)
for the query API, the invalidation stream, and the threat model.

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

## Portable project backup and restore

The canonical filesystem path is never the project identity. The committed
`repositoryId` identifies the logical project; each machine keeps its own
runtime project row and checkout binding. A portable backup moves the safe,
project-owned subset of authoritative state without copying SQLite:

```bash
# Machine A
cd ~/dev/my-project
ai-office project:backup --output ../my-project.aioffice

# Transfer the archive and obtain the source repository on Machine B.
git clone <repository-url> ~/work/my-project
cd ~/work/my-project
ai-office project:restore ../my-project.aioffice --root .
ai-office status
```

The versioned `.aioffice` file contains project metadata, tasks, sanitized
profile knowledge, office manifest revisions, governance records, agent/role
definitions, terminal run summaries, an immutable state revision, and SHA-256
integrity metadata. It excludes absolute paths, active processes/runs/pipelines,
locks, caches, global memory, pricing/cost state, resources, capability grants,
controlled-action authority, audit payloads, managed credentials, and profile
values explicitly labelled as credential/secret data. Nested structured fields
with sensitive names are also rejected. Free-form human descriptions are not
content-scanned for possible secrets; users must not place credentials in prose.
Restore validates the complete envelope through the daemon and refuses a
mismatched identity, corrupt archive, unsupported version, or different
existing local state or revision head. There is no destructive force-restore
option.

Project descriptions are semantic user/domain text and are transferred
verbatim, including text that happens to start with `Imported from`. The sole
legacy exception is an exact `Imported from <path>` match against a structured
local source binding or detachment record for that same project: the portable
projection omits that historically generated machine metadata without mutating
the stored description. An unmatched or differently cased description is
preserved. New source imports no longer encode checkout provenance in that
field; checkout paths and scan provenance remain structured, machine-local
source metadata.

A backup is a coherent semantic snapshot, not an allowlist of unrelated rows.
Task lifecycle status is portable semantic state, not execution authority.
`project:backup` therefore preserves `assigned`, `running`, `blocked`, and
`waiting_review` tasks when no live authority exists, but fails while an agent
or pipeline run is active or an unexpired task lock exists. Finish or cancel
that active execution and retry; task states are never rewritten merely to
make a backup succeed.

Reviews and approvals are included only when their task, requirement, ADR,
milestone, or terminal agent-run subject is included too. Terminal run summaries
cannot resume execution or carry action intent, pipeline authority, results,
errors, events, or worktree paths. Source provenance records only sanitized
network Git remotes: URL credentials, query strings, and fragments are removed,
while `file://`, absolute, relative, Windows, UNC, and ambiguous local remotes,
including Windows drive-relative forms such as `C:repo.git`, are omitted
entirely. Multiple checkout sources contribute provenance only
when their sanitized network remotes agree; conflicting remotes are omitted
rather than selected by row order.

The state revision records that the daemon observed one semantic state; it is
not a receipt proving that the output file was published. If the no-clobber
archive write fails, an identical retry safely reuses that revision. The local
writer uses a private synchronized temporary file and an atomic hard-link
publication during normal process execution, but does not claim power-loss
durability after return.

Schema, referential-closure, sensitive-profile, checksum, manifest, and other
intrinsic portability validation completes before a changed state advances the
snapshot head. A valid observed snapshot may remain after later filesystem
publication failure; state that cannot form a valid archive creates no revision.
Shallow parent and base revision IDs receive lightweight project ownership
reservations, so another project cannot claim them before their full revision
payload arrives.

`project:import` remains the offline source scanner, and `project:export`
remains the Markdown profile projection; `project:backup` and
`project:restore` are the portable state workflow. Remote push/pull and
automatic semantic merge are roadmap work, not current commands. See
[Project portability and synchronization](docs/development/project-portability-and-sync.md).

## Conversational onboarding

Onboarding is the office-configuration part of the handover described in
[Hand your project to the virtual office](#hand-your-project-to-the-virtual-office).

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

Pipeline definitions are guidance-only unless they are explicitly configured
as enforced and an operator starts a runtime run. An enforced run pins its
manifest revision, task, stages, role requirements, capability restrictions,
assignments, approvals, separation rules, transitions, and overrides in SQLite.
Stage capabilities intersect ordinary grants; they never broaden authority.

The distribution skill is checked in at `.agents/skills/ai-office`; normal
install also projects a self-contained repository skill at that path in the
target project and a Claude discovery wrapper under `.claude/skills`. Its
default manifest is a starting point, not an automatic grant or fixed
organization.

The [bundled agent profiles](agents/README.md) describe the core Architect,
Developer, Reviewer, and QA responsibilities, plus optional Product Analyst,
Product Designer, Security Reviewer, Technical Researcher, and Release Engineer
specialists. Hacker (adversarial testing) and Mad Scientist (bounded experiments)
profiles support focused exploration. Devil's Advocate, Chaos Gremlin, Code
Archaeologist, Radical Minimalist, Alien User, Forensic Detective, and Keeper of
the Future add perspectives on decisions, resilience, history, simplicity,
usability, incidents, and maintenance. Each profile defines a working method,
expected handoff, and limits.
Normal synchronization of `agents/` registers and enables only the four core
agents. The fourteen specialists live in `agent-catalog/` and must be deliberately
synchronized. Once synchronized, they can be directly scheduled outside an active
pipeline; an office revision is required for pipeline routing, not run eligibility.
See the catalog for full and subset synchronization examples. Companion Markdown
instructions remain guidance and are not injected into Runtime executors.

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

`task:list` is an operational board, not a list of reminders. `task.status` is
authoritative operational state, moved only by semantic lifecycle commands:

```bash
ai-office task:transitions --project <id> --task <id>   # read-only preflight
ai-office task:start --project <id> --task <id>
ai-office task:complete --project <id> --task <id>
```

Requirements are a different kind of state — what must be true and verified —
and are linked to tasks explicitly and many-to-many. Linked requirement progress
appears beside the task status, never instead of it, and a contradiction between
them is flagged rather than hidden:

```bash
ai-office task:link-requirement --project <id> --task <id> --requirement <id>
ai-office task:reconcile --project <id>   # read-only; reports stale state
```

Reconciliation reports contradictions and refuses to guess: verified
requirements are acceptance state and do not prove that operational work
happened. Work that was completed before AI Office tracked it is recorded by an
explicit operator attestation, with a mandatory rationale and an approved plan
hash, and audited as a correction rather than as execution:

```bash
ai-office task:record-completion --project <id> --task <id> --reason <text>
ai-office task:record-completion --project <id> --task <id> --reason <text> --approve <planHash>
```

See `docs/development/task-board.md`.

`project:import` never calls a provider: its repository scan remains
deterministic, idempotent, and usable offline. `office:validate`, `office:apply`,
`office:show`, and `office:pipeline` form the versioned machine contract used by
the skill. There is no provider-backed onboarding command in the daemon; Codex
or Claude owns questions and synthesis, while SQLite remains authoritative for
accepted manifests and project state.

Operate an enforced pipeline through the Runtime-backed machine surface:

```bash
ai-office pipeline:start --project <id> --task <task-id> --pipeline <pipeline-id>
ai-office pipeline:status --project <id> --run <run-id>
ai-office pipeline:assign --project <id> --run <run-id> --agent <agent-id>
ai-office pipeline:transition --project <id> --run <run-id> --event complete --agent-run <agent-run-id>
```

Approval and cancellation are explicit transition events. A reasoned
Pipeline administration remains a trusted-local operator operation, persisted
and audited. The legacy `--actor` option is accepted only as an audit label and
does not establish authority within the application layer. Agent controlled
actions use `--agent-run`; the runtime derives project, task, agent, and
pipeline provenance from that persisted run. Direct actions do not select an
unrelated task's pipeline by supplying a run identifier.

The Runtime and local daemon host do not authenticate human presence. A
same-user shell-capable worker can technically invoke the same CLI and daemon
socket, so this release does not claim strong operator isolation. Strong
isolation requires a future worker sandbox or authenticated operator-presence
boundary.

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
client of the authoritative Runtime through its current daemon-hosted IPC
transport. Web and MCP are future client adapters to the same authority.

```text
Codex / Claude / CLI / future Web and MCP adapters
                          |
                    RuntimeClient
                          |
                 local daemon IPC
                          |
                 AI Office Runtime
        +-----------------+-----------------+
        |                 |                 |
 application services  pipelines/policy  workers/schedulers
        |                 |                 |
        +-------- controlled actions -------+
                          |
               connectors / audit / SQLite
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
development scripts select `<source-checkout>/.ai-office` regardless of cwd. The
production CLI is only a daemon client (except for local help), so the daemon
owns operational access to that database. `bun run db:migrate` can also migrate
the same isolated source-checkout database directly.

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
├── index.sqlite                  # schema exists; not used by the Runtime
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

Normal Runtime-host operation creates `project.sqlite`, its live SQLite sidecars, and
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
| `<chosen-path>/*.aioffice`               | User-owned portable project snapshot                       | Created only by `project:backup`           | **Backup artifact.** Never removed by uninstall or runtime purge; keep it outside the runtime being purged.      |

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
AI_OFFICE_HOME=/Users/alice/.ai-office-work ai-office runtime start
AI_OFFICE_HOME=/Users/alice/.ai-office-personal ai-office runtime start
```

By contrast, `<runtime-home>/global.sqlite` is user/runtime-scoped rather than
repository-scoped. With the default runtime this is
`~/.ai-office/global.sqlite`; an explicit `AI_OFFICE_HOME` selects the matching
global-memory authority too. Runtime-backed `memory:*` commands store reusable roles,
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
- `daemon.sock` is an ephemeral owner-only Unix socket. A clean Runtime-host shutdown
  removes it; startup replaces an unreachable stale socket. It is not backup
  data.
- `project.sqlite-wal` and `project.sqlite-shm` are SQLite runtime sidecars, not
  independent databases. Never remove them while the Runtime host is running.
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

The runtime home is persistent Runtime-host operational material and is
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

Use the Runtime-backed portable workflow for project-owned state before a purge:

```bash
ai-office project:backup --output /path/outside-the-runtime/project.aioffice
```

That snapshot intentionally excludes machine security authority, global memory,
cost accounting, caches, drafts, and generated projections. For a full
installation disaster-recovery copy, stop the Runtime host first and copy the
entire runtime home so `project.sqlite` and its WAL are consistent; back up
`global.sqlite` separately according to its user-level ownership. Never copy a
live SQLite main file in isolation. Keep every backup outside the runtime home
you intend to purge and verify it exists. Then inspect and apply the purge plan
while the Runtime host remains stopped:

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
  -> stop the Runtime host
  -> create portable project backups (and any separate full-runtime backup)
  -> purge only that local runtime state
  -> start the current AI Office version
  -> clone or obtain the source repository
  -> project:restore
  -> coding-client integration, if desired
```

`project:import` only rescans source facts; `project:restore` recreates the
documented portable state subset. Restore never transfers capability grants,
action approvals/executions, credential references, or ephemeral authorization.
Re-establish those explicitly on the destination machine. Export archives are
user-owned and survive repository uninstall and runtime purge.

## Repository structure

```text
apps/
  daemon/                 persistent Runtime host and local protocol boundary
  cli/                    Runtime-backed command-line client
  dashboard/              loopback host and read-only operations console
packages/
  domain/                 entities, value objects, and rules
  application/            use cases and ports
  runtime-host/           Runtime command execution and local composition
  storage-sqlite/         SQLite adapters and migration runner
  agent-runtime/          agent definitions and simulated execution
  agent-client-integrations/ Codex and Claude detection/config adapters
  llm-gateway/            providers, pricing, budgets, and usage
  orchestration/          scheduling abstractions
  connector-sdk/          connector contracts and registry
  filesystem-connector/   scoped filesystem adapter and sandbox
migrations/               project, global, and index SQL migrations
agents/                    four default agent definitions and profile guide
agent-catalog/             fourteen opt-in specialist definitions
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

With `status --offline`, or when the Runtime host is unavailable, status still
verifies deterministic pointers
and repository skills from their managed contracts and reports certain changes
as `drifted`. The current `AI-OFFICE.md` body depends on the authoritative
manifest, so an otherwise intact offline integration is `unverified`, never
misreported as fully `configured`.

The two cases are reported differently, because they know different things.
`status --offline` deliberately contacts nothing, so it reports the Runtime host
and authoritative state as `not_checked`. Health is `unverified` (exit 0) when
local inspection finds no problem; observed drift, conflicts, missing/unmanaged
client integration, or an invalid binding yield `needs_attention` (exit 1). It
never claims the host is down and never tells you to start it. Ordinary `status`
with the host actually unreachable reports `unreachable`, `unavailable`, and
`needs_attention`, and does recommend starting the Runtime — that case has
evidence.

A relative path always means the directory you ran the command in. The Runtime
host is a long-lived process started from somewhere else entirely, and it never
resolves your `.` against its own working directory.

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
primary `.agents` skill are removed only when no surviving repository host file
can depend on them. In particular, a user-owned `AGENTS.md` or direct Claude
import remains untouched and keeps shared artifacts in place until its owner
changes that dependency. To remove both managed integrations, uninstall Claude
first and Codex second.

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

AI Office assumes a trusted-local, single-user deployment. Runtime mediation
protects application invariants against accidental or unauthorized agent
access, path escape, sensitive-path access, stale simulations and capabilities,
replay, and unapproved filesystem mutation.

The Runtime is authoritative inside AI Office, but neither it nor its daemon
host authenticates one arbitrary same-UID process against another. IPC routing,
owner-only socket mode, executable identity, TTY ownership, and protocol
privilege markers are not proof of human presence. A same-UID shell-capable
worker can reach local administration unless future worker isolation or an
authenticated operator-presence boundary prevents it. The current filesystem
boundary also does not defend against a hostile same-UID process concurrently
mutating the namespace. Local approval records an operator-supplied audit
identity; it is not cryptographic proof of human presence. Rust/`openat2`,
authenticated approvals, tamper-evident audit, and stronger crash
reconciliation are M10 research and roadmap items, not production claims today.

The operations dashboard is a local, same-user observability surface and adds no
authenticated human or operator boundary. It is read-only and changes no
authorization. The Runtime host still opens no TCP port; `ai-office dashboard`
owns a loopback port only while it runs. Because a loopback TCP port is
reachable by every local Unix account — unlike the owner-only socket — that host
validates the `Host` header and requires a per-process session token that dies
with the command.

The token is a barrier to accidental and blind access, not a secret: the command
hands the whole URL to the platform opener, so it appears in that process's
arguments and in browser history. It does not authenticate a human, does not
separate same-UID processes, and is not claimed to keep project state secret
from other local accounts. Running in a browser is not authentication.

# AI Office Blueprint

TypeScript/Bun MVP for a local virtual office. Milestone 2 adds a single local daemon and a Unix-socket CLI client around the SQLite-backed Project/Task vertical slice.

## Goals

- a single local daemon;
- SQLite as the source of truth;
- structured tasks, milestones, ADRs, agents, runs, events, and costs;
- reusable global memory across projects;
- separate local memory and code index;
- a single gateway to LLM providers;
- cost accounting per call, run, task, milestone, and project;
- architectural boundaries compatible with extracting the core to Rust in the future.

## Initial stack

- Bun
- strict TypeScript
- `bun:sqlite`
- Zod
- Vitest
- CLI and daemon in the same monorepo

## Quick start

```bash
bun install
bun run typecheck
bun run test
```

## Validation

GitHub Actions runs frozen dependency installation, strict TypeScript
typechecking, the Vitest suite, and a committed-diff whitespace check for every
pull request and every push to `main`. The stacked milestone baselines are 57
tests across 14 files for M3, 87 across 18 files for M4, and 110 across 26 files
for M5.

`bun run lint` is not part of CI yet because the repository does not have an
ESLint 9 `eslint.config.*` configuration. The M3 executor and worktree manager
remain deterministic simulations, M4 intentionally excludes milestone-scoped
budgets, and no CLI command currently produces real provider usage.

Start the local daemon from the repository root. It creates and migrates
`.ai-office/project.sqlite`, then listens on `.ai-office/daemon.sock`:

```bash
bun run daemon
```

In another terminal, verify the daemon and create a project through the CLI client:

```bash
bun run cli -- daemon:health
bun run cli -- project:create "Demo"
# Project created: <project-id>
```

Use the returned ID to create and list tasks:

```bash
bun run cli -- task:create --project <project-id> --title "First task" --priority 10
bun run cli -- task:list --project <project-id>
```

List output:

```text
ID                                      STATUS   PRIORITY  TITLE
<task-id>                               pending  10        First task
```

Columns in the actual output are tab-separated. Optional descriptions are accepted through `--description`. To apply migrations without running a command:

```bash
bun run db:migrate
```

Import an existing repository with a deterministic local scan:

```bash
bun run cli -- project:import /path/to/repository
```

The importer canonicalizes the path, reuses the same project on later imports,
updates detected facts, records every scan, and keeps onboarding questions in
SQLite. Continue interactively or answer individual questions for automation:

```bash
bun run cli -- project:onboard --project <project-id>
bun run cli -- project:answer \
  --project <project-id> \
  --question <question-id> \
  --answer "<value>"
```

Permission answers accept `all`, `none`, or a comma-separated selection of
`read_files`, `modify_files`, `run_tests`, `run_shell`,
`install_dependencies`, `create_branches`, `create_commits`, and
`network_access`.

Inspect the structured profile or regenerate its Markdown projection:

```bash
bun run cli -- project:profile --project <project-id>
bun run cli -- project:export --project <project-id>
```

The export is written to `.ai-office/generated/project-profile.md`. The project
database remains the source of truth.

## Structure

```text
apps/
  daemon/              central process
  cli/                 local client
packages/
  domain/              entities, value objects, and rules
  application/         use cases and ports
  storage-sqlite/      SQLite adapters
  agent-runtime/       agent execution
  llm-gateway/         providers, pricing, budgets, and usage
  orchestration/       scheduler and workflows
migrations/
agents/
patterns/
docs/
```

## Database

The architecture defines three databases:

```text
~/.ai-office/global.sqlite
<repository>/.ai-office/project.sqlite
<repository>/.ai-office/index.sqlite
```

`global.sqlite` stores reusable roles, templates, patterns, and lessons.

`project.sqlite` stores the authoritative project state.

`index.sqlite` contains regenerable data: symbols, relationships, chunks, FTS, and embeddings.

The current daemon opens and migrates `project.sqlite`. The global and index databases will be connected in their respective milestones.

## Available vertical slice

```text
CLI client
  -> HTTP over .ai-office/daemon.sock
  -> serialized daemon command queue
  -> CreateProject / CreateTask / ListTasks / Project onboarding
  -> ProjectRepository / TaskRepository ports
  -> bun:sqlite repositories
  -> .ai-office/project.sqlite
  -> structured response and CLI output
```

SQL migrations are versioned in `migrations/project/` and recorded in the `schema_migration` table. Running the CLI or `bun run db:migrate` again is idempotent.

The daemon exposes `GET /health` and `POST /commands` only through its Unix
domain socket. Commands are serialized, lifecycle and command events are
appended to `audit_event`, and SIGINT/SIGTERM stop the listener gracefully.

## Commands

```text
ai-office daemon:health
ai-office project:create
ai-office project:import
ai-office project:onboard
ai-office project:answer
ai-office project:profile
ai-office project:export
ai-office task:create
ai-office task:list
```

## For Codex

Read these files first:

1. `CODEX.md`
2. `docs/architecture/overview.md`
3. `docs/development/roadmap.md`
4. `docs/adr/ADR-0001-sqlite.md`

The current implementation delivers the following working vertical slice:

```text
CLI → Unix socket → daemon queue → application service → SQLite → CLI response
```

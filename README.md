# AI Office Blueprint

TypeScript/Bun MVP for a local virtual office. Milestone 1 delivers a working Project/Task vertical slice backed by SQLite.

## Goals

- a single local daemon (starting with Milestone 2);
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

The CLI automatically creates `.ai-office/project.sqlite` in the current directory and applies pending migrations. Start by creating a project:

```bash
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

Milestone 1 opens and migrates only `project.sqlite`. The global and index databases will be connected in their respective milestones.

## Available vertical slice

```text
CLI
  -> CreateProject / CreateTask / ListTasks
  -> ProjectRepository / TaskRepository ports
  -> bun:sqlite repositories
  -> .ai-office/project.sqlite
  -> output CLI
```

SQL migrations are versioned in `migrations/project/` and recorded in the `schema_migration` table. Running the CLI or `bun run db:migrate` again is idempotent.

## Commands

```text
ai-office project:create
ai-office task:create
ai-office task:list
```

The other commands described in the roadmap belong to later milestones.

## For Codex

Read these files first:

1. `CODEX.md`
2. `docs/architecture/overview.md`
3. `docs/development/roadmap.md`
4. `docs/adr/ADR-0001-sqlite.md`

The initial milestone delivers the following working vertical slice:

```text
CLI → command → application service → repository → SQLite → query CLI
```

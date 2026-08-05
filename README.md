# AI Office Blueprint

MVP in TypeScript/Bun per un ufficio virtuale locale. La Milestone 1 rende operativo il vertical slice Project/Task su SQLite.

## Obiettivi

- daemon locale unico (dalla Milestone 2);
- SQLite come source of truth;
- task, milestone, ADR, agenti, run, eventi e costi strutturati;
- memoria globale riutilizzabile tra progetti;
- memoria locale e indice del codice separati;
- gateway unico verso i provider LLM;
- cost accounting per chiamata, run, task, milestone e progetto;
- confini architetturali compatibili con una futura estrazione del core in Rust.

## Stack iniziale

- Bun
- TypeScript strict
- `bun:sqlite`
- Zod
- Vitest
- CLI e daemon nello stesso monorepo

## Avvio rapido

```bash
bun install
bun run typecheck
bun run test
```

La CLI crea automaticamente `.ai-office/project.sqlite` nella directory corrente e applica le migration mancanti. Creare prima un progetto:

```bash
bun run cli -- project:create "Demo"
# Project created: <project-id>
```

Usare l'ID restituito per creare e leggere i task:

```bash
bun run cli -- task:create --project <project-id> --title "Primo task" --priority 10
bun run cli -- task:list --project <project-id>
```

Output della lista:

```text
ID                                      STATUS   PRIORITY  TITLE
<task-id>                               pending  10        Primo task
```

Le colonne dell'output effettivo sono separate da tab. Le descrizioni opzionali sono accettate con `--description`. Per applicare le migration senza eseguire un comando:

```bash
bun run db:migrate
```

## Struttura

```text
apps/
  daemon/              processo centrale
  cli/                 client locale
packages/
  domain/              entità, value object e regole
  application/         use case e porte
  storage-sqlite/      adapter SQLite
  agent-runtime/       esecuzione degli agenti
  llm-gateway/         provider, prezzi, budget e usage
  orchestration/       scheduler e workflow
migrations/
agents/
patterns/
docs/
```

## Database

L'architettura prevede tre database:

```text
~/.ai-office/global.sqlite
<repository>/.ai-office/project.sqlite
<repository>/.ai-office/index.sqlite
```

`global.sqlite` conserva ruoli, template, pattern e lesson riutilizzabili.

`project.sqlite` conserva lo stato autorevole del progetto.

`index.sqlite` contiene dati rigenerabili: simboli, relazioni, chunk, FTS ed embedding.

Nella Milestone 1 viene aperto e migrato soltanto `project.sqlite`. I database globale e di indice verranno collegati nelle milestone dedicate.

## Vertical slice disponibile

```text
CLI
  -> CreateProject / CreateTask / ListTasks
  -> porte ProjectRepository / TaskRepository
  -> repository bun:sqlite
  -> .ai-office/project.sqlite
  -> output CLI
```

Le migration SQL sono versionate in `migrations/project/` e registrate nella tabella `schema_migration`; rieseguire la CLI o `bun run db:migrate` è idempotente.

## Comandi

```text
ai-office project:create
ai-office task:create
ai-office task:list
```

Gli altri comandi descritti nella roadmap appartengono alle milestone successive.

## Per Codex

Aprire prima:

1. `CODEX.md`
2. `docs/architecture/overview.md`
3. `docs/development/roadmap.md`
4. `docs/adr/ADR-0001-sqlite.md`

La milestone iniziale consiste nel rendere funzionante il vertical slice:

```text
CLI → command → application service → repository → SQLite → query CLI
```

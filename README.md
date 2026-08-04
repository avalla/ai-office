# AI Office Blueprint

Base progettuale per un ufficio virtuale locale composto da più agenti coordinati da una singola istanza.

## Obiettivi

- daemon locale unico;
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
bun run db:migrate
bun run dev:daemon
```

In un secondo terminale:

```bash
bun run cli -- project:create "Demo"
bun run cli -- task:create --project demo --title "Primo task"
bun run cli -- task:list --project demo
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

La base prevede tre database:

```text
~/.ai-office/global.sqlite
<repository>/.ai-office/project.sqlite
<repository>/.ai-office/index.sqlite
```

`global.sqlite` conserva ruoli, template, pattern e lesson riutilizzabili.

`project.sqlite` conserva lo stato autorevole del progetto.

`index.sqlite` contiene dati rigenerabili: simboli, relazioni, chunk, FTS ed embedding.

## Comandi MVP previsti

```text
ai-office init
ai-office start
ai-office status
ai-office project:create
ai-office task:create
ai-office task:list
ai-office task:start
ai-office task:complete
ai-office costs:show
```

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

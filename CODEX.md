# Istruzioni operative per Codex

## Missione

Trasformare questo blueprint in un MVP funzionante di AI Office.

AI Office è un daemon locale unico che coordina agenti software, conserva memoria strutturata in SQLite, monitora costi e genera viste Markdown.

## Vincoli

- Runtime: Bun.
- Linguaggio: TypeScript strict.
- Evitare `any`.
- Preferire classi e interfacce per i confini applicativi.
- DRY, KISS, YAGNI.
- Nessun ORM nella prima milestone.
- SQL esplicito e migration versionate.
- Tutte le scritture passano dall'application layer.
- Il dominio non deve importare Bun, SQLite, HTTP, provider LLM o Git.
- Le transazioni non devono restare aperte durante chiamate LLM o subprocess lunghi.
- Ogni modifica deve includere test pertinenti.
- Non introdurre Rust nella prima milestone; mantenere però protocolli e porte estraibili.

## Ordine di lavoro

### Milestone 1 — Vertical slice

Implementare:

1. apertura di `project.sqlite`;
2. migration runner;
3. entità `Project` e `Task`;
4. repository SQLite;
5. use case `CreateProject`, `CreateTask`, `ListTasks`;
6. CLI funzionante;
7. test unitari e integration;
8. README aggiornato.

### Milestone 2 — Daemon

Implementare:

1. server locale HTTP o Unix socket;
2. CLI come client del daemon;
3. lifecycle e shutdown pulito;
4. health endpoint;
5. event log;
6. command serialization.

### Milestone 3 — Agenti e run

Implementare:

1. `Role`, `Agent`, `AgentRun`;
2. state machine dei run;
3. scheduler;
4. executor simulato;
5. agent definition caricata da YAML;
6. audit completo.

### Milestone 4 — LLM gateway e costi

Implementare:

1. interfaccia provider;
2. provider mock;
3. model usage;
4. catalogo prezzi versionato;
5. cost event;
6. budget e reservation;
7. aggregazioni per task, agente e progetto.

### Milestone 5 — Memoria

Implementare:

1. ADR, milestone, requirement e pattern;
2. memoria globale;
3. export Markdown;
4. FTS5;
5. code index rigenerabile;
6. retrieval ibrido iniziale.

## Regole sui commit

- un cambiamento coerente per commit;
- messaggi Conventional Commits;
- non mescolare refactoring ampi e nuove funzionalità;
- riportare nel riepilogo test eseguiti e limitazioni residue.

## Definition of done

Un task è completato quando:

- acceptance criteria soddisfatti;
- test passano;
- migration idempotenti rispetto alla tabella di tracking;
- errori tipizzati;
- logging senza segreti;
- documentazione aggiornata;
- nessun TODO critico nascosto.

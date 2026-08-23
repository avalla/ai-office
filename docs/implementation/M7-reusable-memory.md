# M7 reusable memory implementation

## Delivered boundary

M7 promotes the existing global database schema into a daemon-backed reusable
memory subsystem. `~/.ai-office/global.sqlite` remains separate from
project authority and stores reusable global roles, versioned patterns, and
lessons. Exact pattern-adoption references remain in authoritative
`project.sqlite`.

The implementation keeps the established dependency direction:

```text
daemon-backed CLI
  -> ManageGlobalMemory application service
  -> GlobalMemoryRepository / MemoryReferenceRepository ports
  -> SQLite adapters
  -> global.sqlite definitions + project.sqlite adoption references
```

The global database is opened and migrated lazily for `memory:*` commands. It
is never passed to an agent and does not replace project state in
`project.sqlite`.

## Domain and persistence

- `GlobalRole` validates a structured definition, positive version, decimal
  micro-cost string, execution limits, and deterministic deprecation.
- `GlobalPattern` stores the problem, context, solution, applicability,
  constraints, risks, provenance, outcome counts, and status for one version.
- `GlobalLesson` stores optional project/task provenance, content, confidence,
  and status. Application validation rejects cross-project task references.
- `MemoryReference` records explicit project adoption of one exact pattern
  version and increments usage on repeated adoption.

Global migration `0002_memory_integrity.sql` leaves the applied initial
migration unchanged and adds deterministic lookup indexes plus a unique
global-role key. Project migration `0018_reusable_memory_references.sql` adds
project-owned adoption references with project foreign-key enforcement. The
shared migration runner provides atomic, ordered, `schema_migration`-tracked
fresh and upgrade behavior.

## Commands

All stateful operations use the daemon protocol:

- `memory:role:create`
- `memory:pattern:create`
- `memory:lesson:create`
- `memory:search`
- `memory:pattern:adopt`
- `memory:references`
- `memory:deprecate`

Search is deterministic, excludes deprecated records, and spans all projects
represented in global memory. It uses bounded SQLite text matching; semantic
search and embeddings remain M8/M8.5 work.

## Explicit limitations

- lesson extraction is an explicit validated command, not an autonomous LLM
  inference;
- pattern success/failure counters are stored but no pipeline runtime updates
  them yet;
- global targets are validated by the application service because a
  cross-database foreign key is not possible; project ownership has a local
  foreign-key backstop;
- there is no global audit stream, quota, backup command, or semantic index.

## Verification

Coverage includes domain invariants, fresh migration, representative upgrade,
role version conflicts, cross-project task ownership, deterministic search,
pattern adoption and usage tracking, deprecation, project foreign-key
enforcement, and the complete daemon/CLI Unix-socket flow.

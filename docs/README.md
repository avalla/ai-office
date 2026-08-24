# Documentation index

AI Office keeps different kinds of documentation separate so current product truth is not confused with milestone history or research.

## Current project direction

- [Project README](../README.md): product overview, current status, quick start, and concise examples.
- [Operating instructions](../AGENTS.md): canonical evergreen development contract for coding clients and contributors.
- [Agent client integration](development/agent-client-integration.md): current Codex/Claude detection, planning, ownership, apply, and validation contract.
- [Architecture overview](architecture/overview.md): current system boundaries, implemented surfaces, storage responsibilities, and trust model.
- [Storage design](architecture/storage.md): current database ownership,
  authority, rebuildability, and runtime/import/integration-root path semantics.
- [Repository-local project binding](adr/ADR-0008-repository-local-project-binding.md):
  accepted identity, discovery, portability, and lifecycle decision.
- [Stable user runtime home](adr/ADR-0009-stable-user-runtime-home.md):
  accepted separation of program location from authoritative user data.
- [Development roadmap](development/roadmap.md): authoritative milestone scope and implementation status.
- [Testing strategy](development/testing.md): current validation categories and CI expectations.
- [Agent runtime](development/agent-runtime.md): run lifecycle, controlled-action bridge, and current executor limitations.
- Accepted documents under [`adr/`](adr/): architectural decisions that govern the current design. Each ADR's status is authoritative for whether it applies now or is deferred.
- [Skill-first host orchestration](adr/ADR-0006-skill-first-host-orchestration.md): interactive host/runtime responsibility boundary.

The CLI itself is the syntax authority for current commands:

```bash
bun run cli -- --help
```

## Directory guide

### `architecture/`

Current architecture and boundaries, including storage, the domain model, and cost accounting.

### `development/`

Current implementation and development guidance, subsystem notes, testing strategy, and the authoritative roadmap.

### `adr/`

Architectural decisions with explicit status. Accepted ADRs describe current decisions; deferred ADRs preserve a reviewed future direction without claiming current implementation.

### `implementation/`

Milestone assessments, implementation reports, and research notes. These documents preserve detailed context and evidence but may describe a point-in-time baseline rather than the current code.

> Documents under `docs/implementation/` may describe historical designs,
> rejected alternatives, security research or milestone-specific constraints.
> README, architecture, roadmap and accepted ADRs describe the current project direction.

The M6C hardened assessment, native filesystem spike report, ADR-0003, ADR-0004, and `spikes/m6c-native-filesystem/` are intentionally retained as the research baseline for future M10 security hardening. They are not linked into production and are not requirements for M6D-lite.

## Ownership of truth

```text
README         product overview and getting started
AGENTS         development operating contract
architecture   current architectural truth
roadmap        milestone scope and status
accepted ADRs  architectural decisions
implementation historical and milestone detail
CLI --help     current command syntax
```

`CODEX.md` and `CLAUDE.md` are compatibility bridges, not independent sources of
project truth. When documents disagree, first use this ownership model and each
ADR's status. Update the authoritative document for the concept instead of
copying the same truth into every file.

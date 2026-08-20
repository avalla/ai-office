# Agent client integration and instruction compiler assessment

- Date: 2026-08-20
- Status: implementation baseline

## Existing architecture

AI Office is a Bun and strict TypeScript monorepo with dependency direction
`apps/adapters -> application -> domain`. Stateful CLI commands are sent to the
local daemon, application services orchestrate ports, and SQLite is authoritative
for durable project state. Repository scans, provider calls, subprocesses, and
filesystem mutations must happen outside database transactions.

The current interactive product boundary is the repository-scoped `ai-office`
skill. The host owns conversation and synthesis; the daemon owns validation,
persistence, policy, controlled actions, execution state, and audit. Project
import is deterministic and already detects `AGENTS.md`, `CODEX.md`, and
`CLAUDE.md` as documentation, but does not interpret or mutate them.

Internal agents are YAML role/capability definitions. They do not currently
load prompts or compose instruction fragments. The runtime remains a simulated
executor plus the single controlled-action bridge; it does not assemble task
context or run an autonomous model loop.

## Current instruction flow

`CODEX.md` is currently the repository operating contract and duplicates a
client name in what is otherwise project-level guidance. Codex now documents
`AGENTS.md` as its native hierarchical project-instruction mechanism. Claude
Code supports project `CLAUDE.md` files and imports through `@path` syntax.
Those mechanisms permit one canonical project contract:

```text
AGENTS.md                 canonical project instructions
CODEX.md                  temporary human/legacy compatibility pointer
CLAUDE.md -> @AGENTS.md   minimal Claude bridge
```

No Codex global TOML change is necessary for the first project-level slice.

## Boundary options considered

### Put client files in the domain

Rejected. `CLAUDE.md`, Codex executables, managed Markdown sections, and user
home paths are infrastructure conventions. Adding them to domain entities would
violate dependency direction and require core changes for every future client.

### Reuse controlled actions

Rejected for this slice. Client setup is an explicit owner-operated setup
command, not an agent request for a protected project capability. Forcing it
through action requests would couple machine integration to project resources,
grants, simulations, and the M6 lifecycle. The equivalent safety properties are
provided by passive inspection, deterministic planning, a plan hash supplied at
apply time, precondition checks, atomic writes, and identifiable managed content.

### Persist every detection and plan

Rejected. Installed-client detection and external file contents are derived
state. Persisting them would create stale duplicate authority. User preferences
may warrant global persistence later, when `global.sqlite` has an implemented
owner and setup UX. The first slice requires no migration.

### One generic prompt/configuration DSL

Rejected. The first slice needs only a small versioned engineering operating
policy and project instruction contract. Provider prompts, model parameters,
editor settings, permissions, and full M8.5 context assembly remain separate.

### Client adapters behind an application port

Accepted. The application owns detect/inspect/plan/apply/validate orchestration
and approval matching. Infrastructure adapters own executable lookup,
filesystem conventions, managed sections, hashes, preconditions, and atomic
writes. The domain owns only the tool-independent policy and instruction
contract.

## Security and ownership model

- Detection and inspection are passive and never create files.
- Plans contain deterministic change metadata and a hash over the exact proposed
  operations.
- Apply recomputes the plan and requires the caller to supply that hash.
- Every write checks the file hash observed during planning, preventing a stale
  plan from overwriting a concurrent user edit.
- Missing files may be created as AI Office-owned files.
- AI Office-owned canonical files carry an ownership header and may be replaced
  atomically by later approved plans.
- Existing user-owned `AGENTS.md` is authoritative and is never overwritten.
- Existing `CLAUDE.md` is preserved; AI Office appends or updates only a marked
  bridge section. An existing direct `@AGENTS.md` import needs no change.
- Malformed or duplicated managed markers are conflicts and fail closed.
- Existing `CODEX.md` is assessed but never rewritten by the adapter.
- Plans, errors, command audit, and output contain no credentials or raw external
  configuration beyond generated project instructions.

## Recommended architecture

```text
domain
  AgentOperatingPolicy + ProjectInstructionContract
       |
application
  deterministic instruction compiler
  AgentClientAdapter port
  detect / inspect / plan / approved apply / validate use cases
       |
infrastructure
  agent-client-integrations package
    Codex adapter (native AGENTS.md)
    Claude adapter (managed CLAUDE.md bridge)
    filesystem/executable probes and atomic writes
       |
daemon-backed CLI
  client:detect / inspect / plan / apply / validate
```

The compiled canonical artifact is Markdown because both first clients consume
project instructions as Markdown. The typed input, not that rendering, is the
tool-independent contract. Future clients may render or reference it differently
without changing the domain.

## First vertical slice

1. Add a deliberately small schema-version `1` policy/contract and deterministic
   Markdown compiler.
2. Add an application adapter port and orchestration services.
3. Implement Codex and Claude adapters with passive detection/inspection,
   deterministic plans, preconditioned atomic apply, and validation.
4. Expose daemon-backed non-interactive `client:*` commands. `client:apply`
   requires the hash returned by `client:plan`.
5. Move this repository's canonical operating contract to `AGENTS.md`, retain a
   minimal `CODEX.md` pointer, and add a minimal importing `CLAUDE.md`.
6. Add an accepted ADR and current documentation.

## Likely affected areas

- `packages/domain/src/agent/`
- `packages/application/src/agent-client/` and `ports/`
- new infrastructure package under `packages/`
- daemon/CLI composition and command help
- isolated unit, integration, and daemon E2E tests
- root instruction files, README, architecture, roadmap, testing docs, and ADRs

## Risks and deferred work

- Client version probing and unsupported-version policy are deferred; executable
  presence is detected without launching a client.
- Global Codex/Claude configuration and user preference persistence are deferred.
- Removing integrations is deferred until ownership history and setup persistence
  have an authoritative home.
- Existing user-owned canonical instructions require manual reconciliation when
  they conflict with a newly compiled contract.
- Internal prompt composition is deferred. The current agent runtime has no
  prompt-loading or effective-context seam, so adding unused prompt fragments
  would be speculative M8.5 scaffolding. Architect capabilities already express
  inspection, ADR, decomposition, and tradeoff responsibilities; the compiler's
  operating policy can be reused when a real context assembler is introduced.
- Cursor, Windsurf, and Copilot are deferred. The next adapter should be selected
  from evidence after the two-client boundary has production use.

The adapter boundary and canonical instruction authority are consequential and
warrant an ADR.

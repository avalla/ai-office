# AI Office project instructions

## Mission

Build and maintain AI Office as a local AI software office: one authoritative Runtime coordinates agents, persists project state in SQLite, meters LLM usage and costs, and mediates protected resource access through capabilities and controlled actions. A local persistent daemon is the current Runtime host, not a same-UID security boundary.

Prefer the smallest change that preserves the current architecture and advances the task's explicit acceptance criteria. Do not claim a roadmap feature before its end-to-end implementation exists.

## Read before changing code

Use this small, stable read order:

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture/overview.md`
4. `docs/development/roadmap.md`
5. documentation specific to the milestone or task
6. relevant accepted ADRs

Use `docs/README.md` to distinguish current guidance from historical implementation material. Do not treat every milestone assessment as a standing requirement.

## Operating mode

For non-trivial work, do not translate a request directly into file changes. First determine the underlying objective, relevant existing architecture, affected constraints and invariants, credible alternatives and trade-offs, and the smallest coherent solution. Then decide, plan, implement, and review the resulting diff from both an architectural and reviewer perspective.

A proposed mechanism is not automatically an architectural decision. When repository evidence shows that it conflicts with the current architecture, surface the conflict and choose the smallest coherent solution. Scope discipline prevents unrelated work; it does not justify a locally convenient change that damages conceptual integrity.

## Architectural invariants

- Runtime is Bun; application code is strict TypeScript and avoids `any`.
- Dependency direction is `apps/adapters -> application -> domain`.
- The domain must not import Bun, SQLite, HTTP, Git, MCP, connector implementations, LLM providers, or provider SDKs.
- Application services own use-case orchestration. Infrastructure adapters implement application ports.
- Authoritative project state lives in SQLite; generated Markdown is a deterministic, one-way projection.
- Stateful product commands go through the authoritative Runtime, currently hosted by the local daemon. The CLI is a Runtime client over local IPC; it never falls back to an embedded writer. Local help, explicit `status --offline`, compatible degraded read-only status, and `runtime:purge` are the narrow offline paths. Purge refuses to run while the Runtime host is reachable.
- Protected local or external resources are never exposed directly to agents. Side effects cross controlled application and connector boundaries.
- Errors at domain and application boundaries are typed. External output must not expose secrets, raw credentials, or internal stack traces.

## Domain boundaries

- `packages/domain` contains aggregates, value objects, state transitions, and policies that are independent of runtime and storage.
- `packages/application` contains commands, orchestration, and ports. It may depend on domain abstractions, not concrete adapters.
- `packages/storage-sqlite`, `packages/llm-gateway`, connector packages, and app composition roots are infrastructure.
- Cross-project ownership and aggregate references must be validated explicitly; SQLite foreign keys are a backstop, not the only rule.
- Keep provider details behind the LLM gateway and resource details behind connector descriptors and the registry.

## Persistence and migrations

- Use explicit, versioned SQL migrations and the existing migration runner. Introducing a new persistence abstraction or ORM is an architectural decision, not an incidental refactor.
- Never edit an applied migration to change its meaning. Add a forward migration and an upgrade test.
- Preserve migration order, foreign keys, constraints, and compatibility with existing project databases.
- Migrations must run atomically and be idempotent through `schema_migration` tracking.
- Test fresh databases and representative upgrades whenever persistence changes.
- The current persistent Runtime host opens `project.sqlite`; global reusable memory and the regenerable code index are separate roadmap concerns.

## Transactions and side effects

- Keep SQLite transactions short and deterministic.
- Do not hold a transaction open during LLM/provider calls, subprocesses, repository scans, user prompts, or filesystem mutations.
- Persist authority before a side effect and record its outcome afterward using the established lifecycle for that domain.
- Make transaction ownership explicit; avoid nested or competing transaction boundaries.
- Audit records that establish the same state transition belong in the same transaction when the current design requires atomicity.

## Controlled actions and security

- Capability policy is deny by default. Authorization is deterministic and never delegated to an LLM.
- Resource, operation, normalized arguments, connector identity/version, effective constraints, and grant state participate in controlled-action authorization.
- Filesystem mutation follows `request -> simulate -> inspect -> approve -> execute`. Simulation never mutates the target.
- Every filesystem v2 mutation requires an explicit local approval bound to the action and simulation artifact. Execution then performs fresh authorization and revalidates resource state, grants, constraints, descriptor, simulation artifact, and preconditions.
- One action has at most one execution attempt. Terminal and ambiguous states must not be replayed automatically.
- The current execution boundary is trusted-local and path based. It does not defend against a hostile same-user process concurrently mutating the namespace.
- Runtime centralization supplies application authority, consistency, provenance, and audit; Unix-socket routing, executable identity, TTY ownership, and protocol fields do not authenticate one same-UID process against another.
- `spikes/m6c-native-filesystem/`, ADR-0003, ADR-0004, and the hardened M6C assessment are future M10 hardening baselines, not production components or M6D-lite requirements.
- Agent-runtime action intents cross the controlled-action gateway. Do not bypass that boundary with direct filesystem or connector dependencies.

## Testing

- Add or update the narrowest tests that prove the changed behavior and its failure modes.
- Use deterministic clocks, IDs, providers, executors, and mocks where available.
- Use isolated temporary directories, files, sockets, and SQLite databases. Tests must not depend on developer-local state.
- Standard tests must not call paid providers or require real credentials.
- Persistence changes require fresh-migration and upgrade coverage.
- Connector and controlled-execution changes require adversarial path/precondition tests and relevant fault injection.
- Daemon or CLI behavior changes require end-to-end coverage through the Unix-socket protocol.
- Before handoff, run `bun run check` and the appropriate diff check.

## Git and commit rules

- Keep commits coherent and use Conventional Commits messages.
- Do not mix feature work, broad refactors, migrations, and documentation cleanup without an explicit reason.
- Preserve unrelated working-tree changes and stage only task-owned files.
- Do not rewrite shared history or use destructive Git operations unless the user explicitly requests them.
- Report validation performed, residual limitations, and any intentionally deferred work.

## Scope discipline

- `docs/development/roadmap.md` is the authoritative milestone and status record.
- Implement only the requested task or milestone. Do not pull future roadmap scope forward opportunistically.
- README explains the product; AGENTS defines the operating contract; architecture docs describe current boundaries; ADRs record accepted decisions; implementation docs preserve milestone detail and research; CLI help defines current command syntax.
- If code and current architectural documentation disagree, verify the implementation, update only the truth owned by the task, and report out-of-scope code inconsistencies rather than silently expanding scope.
- Keep spikes and research isolated from production packages until an accepted plan explicitly promotes them.

## Definition of done

A change is complete when:

- the stated acceptance criteria and scope are satisfied;
- architectural and security invariants still hold;
- relevant tests cover success, failure, and upgrade behavior as applicable;
- typecheck and the test suite pass;
- migrations are forward-only and upgrade-safe when persistence changes;
- transactions do not span long-running or external side effects;
- logs, audit payloads, errors, and generated views do not leak secrets;
- current documentation is aligned without turning historical research into current requirements;
- the diff contains no unrelated changes or whitespace errors;
- remaining limitations are explicit.

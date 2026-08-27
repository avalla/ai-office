# Testing strategy

AI Office tests behavior at the narrowest useful boundary and adds integration coverage wherever transactions, persistence, transport, or side effects matter.

## Test categories

- **Unit:** domain transitions, policies, canonical serialization, pricing and budget math, protocol validation, and deterministic connector components.
- **Integration:** application services with real adapters, repository round trips, transaction rollback, event/aggregate consistency, onboarding, costs, governance, capabilities, and controlled execution.
- **SQLite and migration upgrades:** fresh migration order, schema constraints, idempotent reruns, compatibility upgrades from earlier milestone schemas, and preservation of existing project data.
- **Security and adversarial connector:** traversal, absolute paths, symlinks, hard links, sensitive paths, binary/size limits, stale hashes, destination races, revoked grants, disabled resources, and replay attempts.
- **Fault injection:** audit, transaction, connector, and outcome-persistence failures, including rollback and `execution_unknown` behavior around filesystem side effects.
- **Daemon/CLI E2E:** the real Unix-socket path from CLI through daemon dispatch, application services, SQLite or connectors, and rendered CLI output.
- **Agent client integration:** isolated PATH and project roots, passive inspection, deterministic plan hashes, ownership-preserving updates, unmanaged canonical status, operational validation semantics, malformed markers, stale approvals, atomic cleanup, idempotence, and daemon CLI flows. Tests never use the developer's real client configuration.

## Isolation and determinism

Tests use deterministic clocks, IDs, providers, executors, and mocks where appropriate. Files, directories, sockets, and SQLite databases are created in temporary isolated locations and cleaned up after each test.

Standard CI makes no paid provider calls and requires no real API credentials. Provider behavior is exercised with deterministic mocks or injected fake transport.

## CI

Pull requests and pushes to `main` run:

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` validates the repository-scoped AI Office skill, then runs
typecheck, lint, and the full test suite. It validates both the distribution
skill and the self-contained skill projected by project install. The check is deterministic,
requires no secret or network access, validates `SKILL.md` and
`agents/openai.yaml` structure, verifies required linked resources, and parses
the default manifest through the production manifest schema.

OpenAI documents the skill directory and required `SKILL.md` metadata but does
not publish a pinned validator CLI as a repository dependency. The bundled
Codex skill-creator validator also depends on its host installation and Python
YAML environment. CI therefore uses this repository-contract check and does not
claim equivalence with that host-internal validator.

CI also checks the committed diff for whitespace errors. Local changes should
pass the same commands plus the relevant `git diff --check` comparison before
review.

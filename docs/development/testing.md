# Testing strategy

AI Office tests behavior at the narrowest useful boundary and adds integration coverage wherever transactions, persistence, transport, or side effects matter.

## Test categories

- **Unit:** domain transitions, policies, canonical serialization, pricing and budget math, protocol validation, and deterministic connector components.
- **Integration:** application services with real adapters, repository round trips, transaction rollback, event/aggregate consistency, onboarding, costs, governance, capabilities, and controlled execution.
- **SQLite and migration upgrades:** fresh migration order, schema constraints, idempotent reruns, compatibility upgrades from earlier milestone schemas, and preservation of existing project data.
- **Security and adversarial connector:** traversal, absolute paths, symlinks, hard links, sensitive paths, binary/size limits, stale hashes, destination races, revoked grants, disabled resources, and replay attempts.
- **Fault injection:** audit, transaction, connector, and outcome-persistence failures, including rollback and `execution_unknown` behavior around filesystem side effects.
- **Daemon/CLI E2E:** the real Unix-socket path from CLI through daemon dispatch, application services, SQLite or connectors, and rendered CLI output.

## Isolation and determinism

Tests use deterministic clocks, IDs, providers, executors, and mocks where appropriate. Files, directories, sockets, and SQLite databases are created in temporary isolated locations and cleaned up after each test.

Standard CI makes no paid provider calls and requires no real API credentials. Provider behavior is exercised with deterministic mocks or injected fake transport.

## CI

Pull requests and pushes to `main` run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
```

CI also checks the committed diff for whitespace errors. Local changes should pass the same commands plus the relevant `git diff --check` comparison before review.

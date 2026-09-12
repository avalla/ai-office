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
- **Source-linked update:** real local Git remotes cover exact approval drift,
  absent target objects, unchanged planning refs/index/worktree, required temporary
  ref cleanup, ancestry proof, untracked conflicts, and step-by-step failure/partial
  outcomes without rollback. Injected runners never install real dependencies or
  register global links during standard tests. Socket E2E tests cover both selected
  user and distribution development homes, incompatible and nonresponding hosts,
  rechecks after approval, and the source maintenance opt-in exception. Subprocess
  instrumentation rejects SQLite/operational client access; architecture tests
  traverse imports to exclude Runtime/SQLite composition. All help forms are
  exercised before Runtime resolution and updater planning.
- **Bun source-link smoke:** a copied real distribution uses temporary HOME,
  install, cache, global-package, global-bin, config, and runtime roots to prove frozen install,
  bare link registration, launcher resolution, `ai-office --help`, and dangling
  link repair without touching developer or runner-global Bun state.

## Isolation and determinism

Tests use deterministic clocks, IDs, providers, executors, and mocks where appropriate. Files, directories, sockets, and SQLite databases are created in temporary isolated locations and cleaned up after each test.

A test Unix socket is not stored beside the project state it belongs to. Project
directories, SQLite databases, and generated views have no path-length
constraint; a Unix socket does, because `sockaddr_un.sun_path` holds 104 bytes
on macOS. A macOS `$TMPDIR` is a per-user `/var/folders/.../T` path about 48
bytes long, which a nested `.ai-office/daemon.sock` exhausts. Harnesses
therefore keep using `mkdtempSync(join(tmpdir(), ...))` for their own state and
take the socket from `createTestUnixSocket()` in `tests/helpers/unix-socket.ts`,
which allocates a short, unique root of its own. The socket root is removed only
after the Runtime host bound to it has stopped. This is a test-harness rule:
production `RuntimePaths`, `AI_OFFICE_HOME`, and the real
`~/.ai-office/daemon.sock` location are unaffected.

Tests that deliberately exercise socket-path derivation — `runtime-paths`,
`service-cli`, `source-runtime-guard`, and `distribution-runtime-preflight` —
keep deriving the path from a runtime home, because the derivation is what they
assert. Their fixture roots use short prefixes so the derived paths stay inside
the macOS limit.

Standard CI makes no paid provider calls and requires no real API credentials. Provider behavior is exercised with deterministic mocks or injected fake transport.

## CI

Pull requests and pushes to `main` run, on both `ubuntu-latest` and
`macos-latest`:

```bash
bun install --frozen-lockfile
bun run check
```

The macOS job additionally runs `bun run validate:launchd-plists`, which checks
the generated LaunchAgent plists with Apple's own parser — something the
TypeScript suite cannot do.

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

The full validation job pins Bun 1.3.6 as the supported baseline. A separate,
small `smoke:bun-link` matrix runs on both 1.3.6 and the latest stable Bun
release. This keeps ordinary tests deterministic while detecting changes in the
source-link packaging contract on current Bun.

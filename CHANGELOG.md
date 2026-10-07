# Changelog

## Unreleased

- `task-delivery` 0.3.0: for a run over several tasks the summary offers to
  clarify every task before development starts - questions asked together,
  task by task, with the answers recorded in the project's tasks and
  requirements - and, where the project allows stacked work, to stack each
  task's branch on the one before it. Once every task is clarified, the
  dependency check and the branch plan are recomputed, and a materially changed
  plan needs a new approval before preflight. Declining run-wide stacking, or not answering the offer, leaves separately
  approved Git branch dependencies unchanged, and a stopped task stops the
  tasks stacked on it. Each task keeps
  its own pull request and gates; nothing is merged without authorization.
- `task-delivery` 0.2.0: started without a target, the skill asks whether to
  deliver a whole milestone, one or more tasks, or some tasks of one
  milestone, and whether to use the project's default delivery pipeline when
  one is defined; it then checks the dependencies of the selection, shows a
  summary, and waits for the go-ahead before preflight. Where the project
  tracks task state, the skill marks each task started, in review and done -
  with the configured `task_lifecycle` commands (`start`, new `review`,
  `complete`, with a `{task}` placeholder) or the project's documented way -
  and stops when the tracker refuses a transition. It never starts a binding
  pipeline run whose stages it is not assigned to complete, and asks when it
  cannot tell.
- Add portable agent skills under `skills/` with one canonical source per
  skill and a deterministic installer for the executor copies
  (`bun run skills:install`, `skills:check`, `skills:validate`). The first
  skill, `task-delivery`, is a vendor-neutral gated delivery workflow usable
  from Claude Code, Codex, Pi and other `SKILL.md` hosts. It is independent of
  the Runtime-managed `ai-office` skill; `bun run check` now fails on an invalid
  skill, a drifted copy, or an optional `.task-delivery.yaml` that has unknown
  keys, wrong types or empty values.
- Admit native project knowledge from verified non-run sources (AK-11).
  `knowledge:plan` and `knowledge:admit` take an explicit source:
  `--run <runId>` as before, `--source handover --handover <confirmationId>`
  for the project's current user-confirmed repository review, or
  `--source operator-confirmed --confirmed-by <operator> --evidence
<kind:id>[,…]` citing non-rejected requirements, accepted ADRs, approved reviews, tasks or that
  review. The Runtime resolves every reference inside the project and refuses
  unconfirmed, superseded, stale and other-project evidence; no agent run is
  fabricated and no Codex or Claude session identifier is accepted. Provenance
  is part of the plan hash, stored as typed immutable fields, and recorded in
  the admission audit events. Run-backed plans keep their hash and identity.
  `handover:confirm` returns `confirmationId`; `knowledge:trace` adds
  `admissionSource` and `admission`; `knowledge:search` hits and the admission
  result add `provenanceKind`. `knowledge:plan` and `knowledge:admit` now
  reject positional arguments. The SurrealDB knowledge schema moves to version
  3 in place on the next Runtime start; existing records are unchanged. The
  skill policy and handover guidance describe the three sources, so installed
  repositories receive an updated skill on the next `ai-office install`.
- Route durable project knowledge work through the governed workflow from the
  generated `AI-OFFICE.md` project instructions, so every client reaches the
  skill's durable project knowledge workflow. Correct the policy: a failed
  `knowledge:search` means the duplicate check did not happen, so agents stop
  and report the error code; agents report wrong or outdated records instead of
  admitting contradicting corrections, because no command supersedes or
  retracts an admitted record; the policy states the full `knowledge:plan`
  syntax for both kinds; and it describes search precision: at most `--limit`
  hits (five by default) where a full page may mean more, imported legacy hits
  carry their import time as `createdAt`, and matching is one lowercased
  literal substring. Skill help lists include the `knowledge:*` commands, and
  `--help` shows the complete `knowledge:plan`/`knowledge:admit` syntax.
  `bun run validate:skills` rejects duplicate policy copies and tolerates CRLF
  line endings. The `knowledge:search` limit bound is derived from the
  retrieval limit. Installed repositories refresh on the next
  `ai-office install`.
- Let `ai-office task:update` change a task's priority. It now takes
  `--project`, `--task` and at least one of `--description` and
  `--priority <integer>`; both may be given in one command and land in one
  transaction. Lifecycle status is untouched. Description updates still append
  `task.description_updated` exactly as before; a priority update appends
  `task.priority_updated` with the explicit `from` and `to` priority. Priority
  semantics are now documented and enforced once in the task domain: an
  integer from `-2147483648` to `2147483647` (the range every storage adapter,
  including PostgreSQL `integer`, can store), default `0`, higher sorts first.
  `task:create --priority` and `task:update --priority` share one parser and
  refuse anything but plain decimal integer text (for example `""`, `1e3`,
  `0x10`, `1.5`) with a usage error; `task:create` previously accepted
  `Number()` notation such as `1e3` or an empty value (stored as `0`) and any
  JavaScript safe integer, which PostgreSQL storage could not persist. No
  migration is required; existing rows and `project:restore` archives are not
  re-validated, so a wider legacy SQLite priority stays until it is updated.
  The skill describes the new option, so installed repositories receive an
  updated skill on the next `ai-office install`.
- Fix truncated CLI output when stdout is a pipe. Every Runtime client command
  opened an interactive prompt reader on `process.stdout` up front, which in
  Bun makes a pipe on stdout non-blocking; `console.log` then wrote only what
  the pipe buffer could hold at once (64 KiB on Linux), silently dropped the
  rest and still exited `0`, so `office:workspace --json` or
  `requirement:list --json` piped to another program produced invalid JSON.
  The prompt reader now opens only when the Runtime asks a question, and from
  then on output goes through the same backpressure-aware stream. Prompt
  answers piped on stdin are no longer lost to the early reader.
- Make durable project knowledge an explicit part of agent work. The AI Office
  skill now carries one canonical policy, embedded verbatim in the distribution
  skill and the skill projected into installed repositories: classify what was
  learned, keep authoritative information in its source of truth, keep
  project-specific knowledge out of global `memory:*`, consider knowledge
  promotion before wrapping up substantial work, and admit only through
  `knowledge:plan`, user review and `knowledge:admit`. The handover workflow
  gains the matching step, so installed repositories receive an updated skill
  on the next `ai-office install`. Add the read-only
  `ai-office knowledge:search` (`--project`, `--query`, optional `--limit` and
  `--agent`) to find existing records before a new plan; it uses the existing bounded literal search on record text, rejects
  positional arguments so an unquoted multi-word query cannot silently search
  its first word, and writes nothing. No store,
  provider, automatic ingestion or write path is added.
- Add `ai-office requirement:update` to correct the descriptive text of a
  requirement that is still `proposed` without replacing its identity. It
  takes `--project`, `--requirement` and at least one of `--title` and
  `--description`. Key, milestone, status, project and creation metadata
  cannot be changed through it, and task links are untouched. A requirement in
  any other status is refused with a typed error. Each effective change
  appends one `requirement.updated` governance event in the same transaction;
  title changes are recorded verbatim and description prose is not copied into
  the event. SQLite migration `0043` and PostgreSQL migration `20261003000200`
  extend the governance event type and preserve existing history.
- Retire the CairnKeep adapter, configuration, diagnostics and legacy import
  commands after the AK-06 import window. Native agent knowledge remains the
  only worker retrieval and reviewed admission path. Imported legacy records
  and historical run provenance remain readable; external CairnKeep data is
  untouched.
- Report the running source checkout's `HEAD` revision. `ai-office --version` and `-V` now print
  SemVer build metadata for a source-linked checkout, for example
  `0.1.0+git.6fe106c41945` (12-character revision), and still print the plain
  product version with exit code `0` when the revision cannot be determined
  (no `git`, no or corrupt Git metadata, a nested checkout, a future packaged
  distribution). The new local `ai-office version [--json]` prints the full
  revision, distribution kind and tracked dirty state; `--json` has
  `contractVersion` 1 and uses `null` for unknown values. Resolution is local
  Git inspection of the executable's own distribution root, shares HEAD,
  revision validation and tracked-dirty logic with `ai-office update`, and
  needs no Runtime, SQLite, network or source opt-in. The product version stays
  `0.1.0`; the revision is not a protocol, schema or migration version.
- Add a managed Runtime provider credential boundary.
  `ai-office credential set`, `status` and `remove` store provider credentials
  such as `OPENAI_API_KEY` as owner-only files in
  `<AI_OFFICE_HOME>/credentials/`, reading values only from non-terminal stdin. Managed systemd and launchd Runtimes read credentials only
  from there through a non-secret `AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE`
  marker (reinstall once to add it) and ignore the service manager's
  environment; a foreground Runtime reads only its environment and never the
  credential files. `AI_OFFICE_DEBUG_LLM=1` no longer prints a key length or
  fingerprint, only whether a credential is available. Symlinked,
  non-regular, foreign-owned, group/world-accessible, oversized or malformed
  credential files fail closed. `model:check` reports each credential by name as
  present, missing or invalid, never its value or path (ADR-0020).
- Add agent model routing. Roles keep a semantic `model_policy`; the host-local
  `<AI_OFFICE_HOME>/model-routing.yaml` (or, in the foreground,
  `AI_OFFICE_MODEL_ROUTING_FILE`) maps policies, project-scoped and host-global
  agent overrides to `<provider>:<model>` profiles, with `AI_OFFICE_LLM_MODEL`
  as the lowest precedence foreground default. Managed systemd and launchd
  Runtimes read only the Runtime-home file (reinstall once to add the routing
  marker). Scheduling freezes an immutable, non-secret model selection on each
  run (migration `0030`); execution uses only that selection, explicit invalid
  routing fails closed, and role budgets are unchanged. Read-only
  `agent:models`, `model:check` and `run:show --json` expose routing (ADR-0019).
- Add `run:tick --worker gateway`, which executes routed `openai:` runs through
  the metered LLM gateway with exact model enforcement, applied
  `reasoning_effort` and `max_output_tokens`, and the role budget as the run
  budget. The default registry now builds OpenAI providers with the native
  Responses adapter.
- Fix gateway metering: usage is inclusive totals with subset details, so cached
  input and reasoning tokens are priced once at their own rate instead of on top
  of the input and output rates, and impossible subsets are rejected. The
  reservation prices each bounded token once at its dearer rate. A provider
  answer rejected after it was received (another model, malformed usage) is
  charged at the reserved worst case with `charge_basis = 'reserved_envelope'`
  (migration `0031`) instead of releasing the reservation. `pricing:set` rates
  are per bucket: for OpenAI set `--reasoning` equal to `--output`.

- Add optional, read-only, non-authoritative project memory through a
  provider-neutral port and a CairnKeep stdio MCP adapter restricted to
  `memory_search`. Memory identity derives from the portable `repositoryId`;
  each worker run performs at most one bounded search, gets advisory excerpts
  pinned in its input digest, and records append-only retrieval provenance
  (migrations `0028` and `0029`: separate digests of the task-derived query and
  the exact provider-sent query). The adapter accepts only MCP `2025-06-18` and
  normalizes `CAIRN_AGENTFS_BASE_DIR` to an absolute path before spawn.
  Disabled by default via `AI_OFFICE_PROJECT_MEMORY_PROVIDER`;
  diagnostics in `status`, `project-memory:status [--probe]` and `run:show`
  (ADR-0018).

- Add the MIT license with copyright held by Andrea Valla and matching package metadata.
- Establish the initial `0.1.0` product version in the root package metadata.
- Add local `--version` / `-V` reporting for source-linked and development CLIs.
- Document release gates and separate product versions from protocol, database,
  snapshot, and agent-profile versions.
- Align roadmap descriptions with merged consolidation, explicit requirement
  summaries, and host-only onboarding.
- Add `ai-office service install|status|uninstall` for per-user native service
  management on Linux (`systemd --user`) and macOS (`launchd` LaunchAgents),
  with ownership-marked definitions, normalized cross-platform status, and an
  uninstall that removes service definitions only.
- Add `ai-office dashboard --await-runtime <seconds>`, a bounded wait for the
  Runtime socket so a supervised dashboard tolerates a Runtime that becomes
  available shortly after it starts.
- Make `ai-office service install` converge running processes to the generated
  definitions, restarting already-running managed services rather than leaving
  them on a superseded configuration.
- Make `ai-office service uninstall` fail closed: a managed definition is
  removed only after the service manager confirms the service stopped, so the
  ownership evidence survives an ambiguous or failed stop.
- Report services that remain registered with the operating system after their
  definition was removed, instead of inferring absence from a missing file.
- Require managed, current, registered, enabled and running before reporting a
  service installation as healthy.
- Treat a failed `launchctl print` as an unknown state rather than an absent
  service, so an ambiguous inspection can no longer delete the plist that proves
  AI Office owns a LaunchAgent.
- Read launchd's persistent enable/disable overrides through
  `launchctl print-disabled`, so a disabled service is reported as such instead
  of being inferred from registration, and `ai-office service install` re-enables
  both labels before bootstrapping.
- Escape a literal `$` in systemd `ExecStart=` as `$$` without corrupting
  `Environment=` values, so paths and arguments containing a dollar sign reach
  the service intact.
- Stop writing the undocumented `ServiceDescription` key into generated plists;
  the human-readable name is an XML comment instead.
- Validate the generated LaunchAgent plists on a `macos-latest` CI runner with
  `plutil`, without installing or bootstrapping anything on the host.
- Allocate daemon end-to-end test sockets from a short, dedicated temporary root
  instead of nesting them under the project directory, so the full suite binds
  within the 104-byte macOS `sun_path` limit. Test harnesses only; production
  `RuntimePaths`, `AI_OFFICE_HOME`, and socket placement are unchanged.
- Run the complete `bun run check` on `macos-latest`, alongside the native plist
  validation, instead of a service-management subset.

No version tag or public release has been published by these changes.

The existing baseline includes the persistent Runtime, explicit run outcomes,
atomic admission, cancellation and approved recovery, task/requirement queries,
four core plus fourteen opt-in agent profiles, and hardened source-linked
program updates. Worker dispatch is available through explicit `run:tick`
workers and opt-in queue-backed orchestration; an autonomous development loop
remains future work.

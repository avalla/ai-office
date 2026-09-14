# Changelog

## Unreleased

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
program updates. Real worker dispatch and an autonomous development loop remain
future work.

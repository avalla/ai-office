# Changelog

## Unreleased

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

No version tag or public release has been published by these changes.

The existing baseline includes the persistent Runtime, explicit run outcomes,
atomic admission, cancellation and approved recovery, task/requirement queries,
four core plus fourteen opt-in agent profiles, and hardened source-linked
program updates. Real worker dispatch and an autonomous development loop remain
future work.

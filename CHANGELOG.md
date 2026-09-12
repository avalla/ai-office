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

No version tag or public release has been published by these changes.

The existing baseline includes the persistent Runtime, explicit run outcomes,
atomic admission, cancellation and approved recovery, task/requirement queries,
four core plus fourteen opt-in agent profiles, and hardened source-linked
program updates. Real worker dispatch and an autonomous development loop remain
future work.

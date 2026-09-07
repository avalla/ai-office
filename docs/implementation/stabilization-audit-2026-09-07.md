# Stabilization audit — 2026-09-07

Baseline: `main` at `05a6f2ccba2d093a6afb2e03886bef63eab2bdfd`.
This is a dated repository audit, not a replacement for the development roadmap.
It examines Git ancestry, patch equivalence, open PRs/issues, CI, tracked and
untracked work, current documentation, and relevant implementation boundaries.
It is not a line-by-line correctness or security review of the entire product.

## Integration and repository health

- GitHub has no open PRs or issues at the audit baseline. PRs #1–#42 are merged.
- #32–#36 reached main through replacement PRs #38–#42; #37 followed them.
- #30 is also integrated, through `31192fe424394584b66a0e2dfa36bd080dd30cc8`.
  Source-linked program updates are implemented; do not resurrect the older
  updater branches as unfinished features.
- Main CI is green for the exact baseline commit:
  [workflow 34017986837](https://github.com/avalla/ai-office/actions/runs/34017986837).
- The original local main matches remote main but has no upstream configured.
  The updater correctly refuses a branch without an upstream. Repair tracking
  only after preserving the active work; this audit does not change it.
- No product version, LICENSE, changelog, Git tags, or GitHub releases existed
  at the baseline. Protocol/profile versions are not a product version.

## Branch inventory and cleanup decisions

There are 34 remote branches including main, and 18 local branches in the
original checkout. Classify content and history separately: lack of ancestry
alone does not prove missing work, especially after a rebase or a stacked merge.

| Remote group | Count excluding main | Evidence and next action |
| --- | ---: | --- |
| Fully reachable from main | 25 | No unique commits. Candidates for branch cleanup after checking active worktree ownership. Includes the five integration/pr-32 through integration/pr-36 branches and the rebased agent catalog. |
| Old consolidation merge topology | 5 | No unique non-merge commits, and each complete tree equals a known main ancestor. No feature delta needs integration. |
| Historical branch decisions | 3 | Preserve until the evidence below has been recorded and the owner chooses archive/retirement. |

The five topology-only branches are independently verified:

| Remote branch | Same tree already on main |
| --- | --- |
| `fix/development-runtime-isolation` | `916b4abe71b1a32e63eaec08456006b24d2bf6b5` |
| `fix/run-execution-outcomes` | `4affd68cc1c32eb1d715d4738a3649a76547a9b1` |
| `fix/run-admission` | `c3f40c1043433202328d35b6fd04c1f805bbb2e4` |
| `feat/run-recovery` | `a3080cd369a53f835cb8f0fd547e371d3e91bff2` |
| `fix/task-requirement-read-models` | `004950930144762cb3322651af1cf0efc648eefc` |

Historical branches need these decisions:

- `feat/project-lifecycle-ux`: its Bun-link fix is patch-equivalent to main,
  but `4cdcf803675fbad0520682720ac6374d8363c1bd` contains unpublished architecture/
  roadmap proposals: provider-neutral source control, finding lifecycle,
  bounded review loops, and explicit merge gates. Preserve the proposal for a
  documentation review against the newer M15 direction. Do not merge the old
  branch wholesale or assume all its work is disposable.
- `feat/source-linked-program-update` and `refactor/host-only-onboarding-pr`:
  their two distinct commits contain the old source updater from #22. #30
  restored and hardened this feature for the current Runtime architecture.
  Archive as superseded history after retaining the PR linkage; ancestry is
  not a reason to restore the old implementation.

Local-only distinctions:

- `feat/agent-profile-catalog` still points to the pre-rebase `e70adb5`; the
  rebased version was integrated by #37. This divergence is known history,
  not a second catalog to merge.
- `feat/restore-source-linked-update` retains an earlier #30 revision; the
  integrated head is `118e95a`, so compare against that PR before retirement.
- `port/pr30-runtime` has one patch-equivalent documentation commit already
  on main; no missing feature was found there.
- `refactor/host-only-onboarding` has equivalent onboarding/Bun-link changes
  plus the same distinct `4cdcf80` proposal described above.
- The other eleven non-main local branches are reachable from main.

No branch or worktree was deleted, reset, rebased, stashed, or moved by this
audit. Remote pruning was confined to an independent temporary clone.

## Active work outside PRs

The original main worktree contained 15 modified files and 5 new files when
the audit started; it continued changing during inspection. The tracked diff
initially added 1,663 lines and removed 157, excluding new files.

This is an active dashboard/query feature, not leftover build output: task
details, filters and pagination, exact aggregates/charts, application read
models, SQLite query changes, documentation, and regression tests. Preserve it
and give it a dedicated branch/PR before a release. Validate its query limits,
aggregation, no-N+1 behavior, cross-project isolation, compatibility, and UI
read-only contract. This audit does not claim those in-progress changes pass.

Five secondary worktrees are clean: operational-dashboard, pr29-hardening,
project-portability, project-welcome-handover, and task-lifecycle. Their heads
are reachable from main. Ignored paths in those worktrees are dependency
directories; check for active processes before removing a worktree. The
original checkout also contains ignored planning/editor/host files, which are
not cleanup targets. The single stored LLM-smoke debug note is marked resolved;
it is not evidence of an active provider defect.

## Functional completeness and stabilization scope

| Area | Implemented today | Remaining boundary |
| --- | --- | --- |
| Task/run lifecycle | Explicit task state, outcomes, atomic claims, cancellation, exact-plan recovery | No automatic replay, real heartbeat, or worker dispatch |
| Pipelines (M11) | Durable sequential stages, assignments, approvals, policy enforcement | Branching, retries, bounded cycles, artifacts, compensation and dispatch remain future |
| Agent catalog | Four core and fourteen opt-in operational profiles | Companion system.md is repository guidance, not executor input |
| Default office/profile compatibility | Separate manifest roles and Runtime role keys | Default short role IDs differ from Runtime keys; resolve or explicitly scope this before claiming ready-to-run enforced default pipelines |
| Project portability | Local portable backup/restore | Remote adapter, push/pull, divergence handling and semantic sync remain future |
| Program update | Exact approved source-linked fast-forward, frozen dependencies, relink | Source distribution only; follows configured upstream, not release tags |
| Code intelligence | Initial index schema | No operational indexer, retrieval or context assembly |
| Product distribution | Source-linked CLI and read-only dashboard | No packaged binary, release history or public SDK |
| Autonomous delivery | Controlled-action and pipeline foundations | No real worker, Git worktree executor, GitHub delivery loop or automatic merge |

These future boundaries do not all block a limited initial release. Stabilize
the documented current product without turning M8–M15 into one release task.
The default role-key mismatch deserves a focused compatibility decision; do
not fix it through bulk profile or manifest rewrites in this audit.

## Documentation corrections

The stabilization branch corrects three stale descriptions in the roadmap:
M7.10 is merged; task/requirement summaries are explicitly linked; provider-backed
onboarding is historical and superseded by ADR-0010. It also updates the README
requirement-summary wording and the consolidation delivery record.

The committed dashboard guide still has a stale “no task/requirement
association” subsection. The active dashboard work already edits that guide
and removes this wording; leave its final reconciliation to that PR.

## Proposed release sequence

1. Preserve and finish the active dashboard/query change in a dedicated PR,
   or explicitly exclude it from the first release.
2. Review the small stabilization branch: a single root product version,
   local version reporting, release policy, changelog, and corrected roadmap.
3. Select the project license and copyright notice. No open-source license
   is chosen implicitly by this audit.
4. Decide the fate of `4cdcf80`, then clean integrated branch/worktree history
   in a separate maintenance action. Restore main tracking when appropriate.
5. Run the full checks and isolated linking smoke on the final clean release
   commit. Publish the initial version tag/release only after these gates pass.

`0.1.0` is an initial-development product baseline, not a claim of complete
autonomous execution. See [release policy](../development/releases.md).

## Validation of the stabilization branch

- `bun run check`: 979 tests in 96 files passed, with skill validation,
  TypeScript checking, and lint.
- Focused version/source-isolation/CLI/architecture checks: 23 tests in 4 files
  passed. Instrumented launchers prove that version reporting cannot resolve
  Runtime paths, open SQLite, or make an IPC/network request.
- `bun run smoke:bun-link`: passed with Bun 1.4.0 and isolated global state.
- `git diff --check`: passed.

These checks validate the clean baseline plus this stabilization change. They
do not include the active dashboard work in the original dirty worktree and
do not certify a release. The license selection remains outstanding.

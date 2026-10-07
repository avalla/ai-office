# Task delivery profiles, handoff and Runtime-owned delivery state

Status: plan, not implemented. The choices step 1 left open were decided by
the owner (see Owner decisions). Step 2 is gated by the proposed
[ADR-0031](../adr/ADR-0031-runtime-owned-delivery-state.md).

## Objective

The `task-delivery` skill (`skills/task-delivery`) runs one fixed 11-gate
lifecycle for every task, holds delivery state only in the executor's context,
loads about 800 lines of prose (`SKILL.md` and its references) on every invocation, and validates its
configuration with a repository script instead of the product CLI. The goal is:

1. choose how much process a task gets: `lite`, `full`, or `custom`;
2. keep context small by loading only what a stage needs and by handing off at
   gate boundaries;
3. move deterministic parts (configuration validation, and later delivery
   state) into the CLI without making the skill depend on the Runtime.

## Constraints that stay

- The skill is vendor-neutral and works without a Runtime, a daemon, or an AI
  Office project (`skills/README.md`). Any CLI integration is optional.
- A profile never grants authority and never waives these rules: merge only on
  explicit authorization; READY FOR MERGE is not DONE; evidence is bound to
  the head commit; stay in scope; the stop conditions apply.
- The configuration contract stays plain `key: value` under one level of
  sections, with no lists. Profiles therefore use booleans.
- The repository's own instructions win where they are stricter.

## Step 1 - profiles, slimmer skill, handoff packet, CLI validation

### 1.1 Profiles

Gates become a catalog with stable ids. A profile selects gates.

| Gate id           | lite                                  | full        | custom    |
| ----------------- | ------------------------------------- | ----------- | --------- |
| `preflight`       | on                                    | on          | always on |
| `design`          | short record, before `implementation` | written     | choice    |
| `implementation`  | on                                    | on          | always on |
| `pull_request`    | on                                    | on          | always on |
| `review`          | one round                             | on          | choice    |
| `hardening`       | on demand                             | on demand   | on demand |
| `second_review`   | off                                   | on          | choice    |
| `qa`              | `verification.full`                   | independent | choice    |
| `external_review` | off                                   | as today    | choice    |
| `ready_for_merge` | on                                    | on          | always on |
| `post_merge`      | on                                    | on          | always on |

Configuration (additive, optional keys; all values unquoted booleans or one of
three words):

```yaml
delivery:
  # profile: lite | full | custom; absent means full
  profile: custom
# stages: allowed only when profile is custom; an error otherwise
stages:
  design: true
  second_review: false
  external_review: false
```

Rules:

- Absent `delivery.profile` means `full`: existing projects behave as today.
- The accepted `stages` keys are `design`, `review`, `second_review`, `qa` and `external_review`; any other key, including `hardening`, which is not configurable, is an unknown-key error.
- Under `custom`, `false` means different things by key: for `design` and `qa` it selects the reduced form of the gate (the short design record, and `verification.full`), never the absence of the gate; for `review`, `second_review` and `external_review` it turns the gate off. `review: false` together with `qa: false` is a configuration error unless `external_review.command` is set, so that a hardening fix always has an independent re-check.
- Under `custom`, a `stages` key that is omitted takes the value of that gate in `full`, so every configuration yields one deterministic selection; the one exception is `second_review`, which is off when `review` is off and omitted.
- `stages` with a profile other than `custom` is an error, and so is `second_review: true` while `review` is off, since there is no review whose findings and hardening a second review could confirm. Gates that are always on are not `stages` keys.
- Floor: when the diff touches migrations, controlled actions or connectors,
  security boundaries, or public contracts, the effective profile is at least
  `full`. The floor is a minimum, never a one-time decision:
  - it is determined at preflight from the information available then, and
    the skill states it with its evidence;
  - it is evaluated again before the task leaves `implementation`, again
    before `ready_for_merge`, and whenever a new commit on the head can change
    the classification (for example a migration, a controlled action or a
    connector, a security boundary, or a public contract added after a
    `lite` start);
  - it is applied gate by gate and in depth: every gate the `full` profile requires becomes required in its `full` form, whatever the configured profile is (`lite`, or `custom` with gates turned off or reduced), and a gate the configuration turns on stays on. Under a floor trigger review has the full number of rounds, `qa` is independent, `design` is the written design, and a gate that ran in a reduced form is run again in its `full` form;
  - it only moves up. A gate that becomes required and was omitted is executed before the task proceeds, and evidence gathered under the reduced profile does not cover it;
  - an authorizer may raise the profile, never lower it below the computed
    floor.
- External review keeps its current meaning: configured or requested makes it required, whatever the profile says. A configuration that disables it while `external_review.command` is set (`lite`, or `custom` with `stages.external_review: false`) is a configuration error rather than a silent skip.
- Hardening is a step that runs on demand, whenever any gate (review, QA, external review) yields findings, in every profile, as `lifecycle.md` already routes failures. Its fixes are followed by the failing gate run again on the new head, for review, QA and a required external review; a best-effort external review is not repeated, as the skill already says, and its findings are confirmed by the independent QA re-run on the final head. When `review` is off, that independent gate (QA or external review) is the confirmation of the hardening diff, so the implementation context never approves its own fix, and the non-convergence stop condition counts returns to hardening, as `lifecycle.md` does today.
- Review without a second review (`lite`, or `custom` with `review` on and `second_review` off): one full round on the reviewed head. When hardening produces commits, the same reviewer confirms the hardening diff, which is a confirmation of the answers to the findings and not a second full review, and the full verification runs green on the final head. The confirmation and the verification are the evidence for the current head, so the head-binding rule is unchanged. Hardening stays limited to the findings, as the skill already requires.
- Readiness: `ready_for_merge` checks, on the current head, the selected gates that precede it, plus any such gate the floor made required, plus a required external review (configured by the project or requested by the authorizer, as today, whatever the profile selects), plus the stages of an enforced Runtime pipeline that governs the task, which stay authoritative whatever the profile selects; `post_merge` runs only after an authorized merge and is never part of this check. A profile that omits a gate does not need its evidence. Step 1 audits every statement in `SKILL.md` and its references that presupposes the full lifecycle and rewords it for "selected or floor-required gates". The audit covers at least: the stage 10 wording; the `lifecycle.md` sentence that requires every earlier gate to have evidence for the current head; the part-way rule of `SKILL.md`; the independence sentence of `SKILL.md` (independent contexts for the gates whose selected or floor-required form is independent: review, second review and external review always, and QA only in its full form; the reduced QA runs `verification.full` on the final head and checks every acceptance criterion against observed results in the implementation context, recorded as not independent, as the skill already provides when independence is not available); the routing in `lifecycle.md` of QA failures and external-review findings through Hardening and a new Second Review, which becomes Second Review when selected or floor-required and otherwise the reviewer's confirmation of the hardening diff, together with the non-convergence stop condition anchored on whichever re-review applies, or on returns to hardening when `review` is off; the sentence of `references/configuration.md` that says no key can waive a gate, which becomes: no key can waive the non-negotiable rules or a gate the floor requires; and the pipeline sentence "a project pipeline never removes a gate", which becomes: a profile may omit the optional gates, a project pipeline still may not. Each reworded sentence is pinned by a contract invariant with a removal test, the validator's required-sentence patterns and the tests that pin the old wording are updated with them, and a test asserts that no reference text still requires an omittable gate unconditionally.
- Design: a profile that shortens `design` still produces a written design record before `implementation` starts; it is linked or copied into the pull request.
- This amends the current sentence "a project pipeline never removes a gate":
  a profile may omit the optional gates above, a project pipeline still may
  not.

### 1.2 Slimmer skill

- `SKILL.md` keeps the rules, roles, profile selection, and the stage table
  (target about 100 lines).
- Each stage's detail loads from its reference only on entry.
- "What to deliver" and the dependency check move to
  `references/delivery-scope.md`, read only at the start of a run.
- A stage the profile turns off is not loaded.

### 1.3 Handoff packet

At every gate the implementation context writes one compact record, and the next implementation-context stage or a fresh implementation session starts from it:

```text
stage, result, profile, head sha, base sha, branch/PR
evidence: [{claim, command-or-link, log path, sha256}]
open findings: [{id, severity, status}]
decisions: [{what, who authorized}]
next action
```

- Evidence is cited by path and hash; output is not pasted.
- Location in step 1: an untracked file in the task worktree
  (`.task-delivery/<task>/handoff.md`, where `<task>` is the task identifier or, without one, the branch name, so that successive tasks sharing a worktree never share a packet; the directory is ignored through the repository's shared exclude file, `$(git rev-parse --git-common-dir)/info/exclude`, because Git reads `info/exclude` only from the common directory and a per-worktree file would not ignore it).
- Resume rule: a packet is evidence for its recorded head sha. When the head differs, evidence is invalidated per gate and per changed commit under the skill's existing rules, including its exception for review evidence after a clean merge-in; verification always runs again on the new head.
- Cut points are gate boundaries only. After a gate, a context reset is allowed
  and recommended when the context is large.
- Multi-task runs: an orchestrator holds the queue and a report of at most 15
  lines per task; each task's first context starts from the approved run summary and the task statement, and its later contexts start from its packet.
- Reviewer and verifier inputs stay as the skill defines them: the task, the acceptance criteria and the diff. The packet is read by the implementation context only; the implementer's design reasoning, summaries and claims never reach the reviewer or the verifier. A second review, or the confirmation of a hardening diff, also receives the per-finding responses, which are a fix commit or a rejection reason, because deciding whether a rejection is justified needs them.

### 1.4 CLI: `delivery:validate`

- `ai-office delivery:validate [--root <path>] [--json]` moves the contract
  check of `.task-delivery.yaml` from `scripts/skills/task-delivery-config.ts`
  into a shared module used by the Runtime host and by `skills:validate`; `apps/cli` does not import it.
- A `--root` that does not exist, is not a directory, or cannot be read is rejected with a typed error, never reported as valid.
- It is a Runtime-routed read like other product commands: the CLI stays a
  Runtime client and gains no new offline path (owner decision, 2026-10-07).
  The repository's `skills:validate` keeps using the shared module directly.
- `--root` is resolved in the invoking client, as `AGENTS.md` requires for
  caller-local paths:
  - when `--root` is omitted, the CLI uses the working directory of its own
    client process;
  - when `--root` is relative, the CLI resolves it against that same working
    directory;
  - the path is materialized as an absolute path before IPC, and the Runtime
    receives only absolute paths;
  - the Runtime rejects a relative path with a typed error instead of
    interpreting it against its own working directory, and never infers the
    caller's filesystem context from the daemon's cwd.
- It also reports the configured profile and the gate selection that follows from the configuration alone. The floor depends on the task, the diff and the head commit, which the command does not receive, so the skill applies the floor on top of this selection and never treats the reported list as the effective one.

### Tests and acceptance criteria

Shared parser and validation module (no Runtime needed, tested directly):

- every new key, wrong type, `stages` without `custom`, `second_review: true` with `review` off, `review: false` with `qa: false` and no `external_review.command`, the meaning of `false` for `design` and `qa` (reduced form, never absent), an omitted `second_review` while `review` is off (resolves to off), an external reviewer configured while `lite` or `custom` disables it, and an omitted `custom` stage taking its `full` value;
- configured profile and configuration-derived gate selection for `lite`, `full`, `custom`, and for an absent `delivery.profile` (equals `full`); the output is never labelled effective, and a test asserts that it carries no floor.

Skill contract and package validation (handoff packet included):

- stage table and references stay consistent with the gate catalog; a gate a
  profile turns off does not require its reference;
- generated copies stay in sync (`skills:check`);
- the audit rule is proven: each reworded skill sentence has a contract invariant with a removal test, the required-sentence patterns and the tests that pin the old wording (for example the "never removes a gate" sentence) are updated, a test asserts that no reference text still requires an omittable gate unconditionally, and the old stage 10 wording is gone;
- with `review` off, the re-run of the failing independent gate confirms the hardening diff, a best-effort external review is not repeated, and non-convergence counts returns to hardening;
- handoff packet rules are pinned by contract invariants and removal tests: the per-task packet location (`.task-delivery/<task>/handoff.md`) and its ignore through the common-directory exclude, so a clean tree stays clean; the per-gate, per-changed-commit invalidation on a head change, with the existing merge-in exception and verification re-run; cut points only at gate boundaries; reviewer and verifier inputs exclude the implementer's design reasoning, summaries, claims and the packet itself, and a second review or hardening confirmation receives the per-finding responses;
- floor rules are pinned by contract invariants and removal tests: floor
  determined at preflight; re-evaluated before leaving `implementation`, before
  `ready_for_merge` and on a head change that can alter the classification;
  floor is applied gate by gate, including to `custom` with gates turned off; it only moves up; an omitted gate that becomes required is executed before the task proceeds; lowering below the floor is refused; under a floor trigger a gate that ran in a reduced form (one review round, non-independent QA, short design record) is run again in its `full` form and the reduced evidence does not cover it; the review-without-second-review rule is pinned for `lite` and for `custom` with `review` on and `second_review` off, and hardening is an on-demand step that runs for any gate's findings (one full round; confirmation of the hardening diff by the reviewer when there are hardening commits; full verification on the final head; hardening stays limited to the findings), together with the unchanged head-binding rule; `ready_for_merge` excludes `post_merge` and includes a required external review and the stages of an enforced pipeline; the accepted `stages` keys are exactly `design`, `review`, `second_review`, `qa`, `external_review`, so `stages.hardening` is rejected; `ready_for_merge` checks the selected gates plus the gates the floor made required; a shortened `design` still has a written record before `implementation`.

CLI `delivery:validate`, end to end through the Unix-socket protocol with a
Runtime available (daemon-backed):

- valid file, invalid file, `--json` shape;
- `--root` omitted: the client's cwd, exactly, is validated, from a subdirectory too; a root without `.task-delivery.yaml` is reported as "no configuration found at <absolute root>" with a status distinct from a valid configuration, so a wrong directory is visible;
- `--root` relative: resolved against the client's cwd, and the Runtime
  receives an absolute path;
- `--root` absolute: passed unchanged;
- `--root` nonexistent, not a directory, or unreadable: a typed error, never a pass;
- a Runtime that receives a relative path rejects it with a typed error and
  does not read the daemon's cwd.

Runtime unavailable:

- the CLI reports the Runtime as unreachable with the established exit code and
  message, performs no validation itself, and adds no embedded or offline
  fallback; a test asserts that the shared module is not invoked on that path, and an import-boundary check asserts that `apps/cli` does not import it.

### Out of scope for step 1

Runtime storage of delivery state, `delivery:next` and `delivery:record`,
pipeline mapping, dashboard views.

## Step 2 - Runtime-owned delivery state (gated by ADR-0031)

A delivery run in the Runtime records profile, gates passed, and evidence per
head commit; the skill calls `delivery:next` and `delivery:record` when a
Runtime is available and otherwise keeps the step-1 file packet. The handoff
packet becomes the run's persisted record. The relation to the office
pipeline definitions (ADR-0013) is the main open design point and is the
subject of the ADR.

## Delivery order

1. The `task-delivery` 0.3.0 change (clarifying tasks before a run and run-wide stacking, currently pull request #126, still open) is merged to `main`. Step 1 starts only after that, from the resulting `main`. No earlier interim branch of this work is a prerequisite.
2. Step 1 in its own pull request, from the resulting `main`.
3. ADR-0031 reviewed and decided.
4. Step 2 planned as its own milestone task, only after ADR-0031 is accepted.

## Owner decisions (2026-10-07)

1. `delivery:validate` is routed through the Runtime; no new offline path.
2. The floor list (migrations, controlled actions or connectors, security
   boundaries, public contracts) is accepted.
3. "A project pipeline never removes a gate" is amended: a profile may omit the
   optional gates; a project pipeline still may not.

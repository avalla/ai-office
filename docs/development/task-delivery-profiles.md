# Task delivery profiles, handoff and Runtime-owned delivery state

Status: plan, not implemented. The choices step 1 left open were decided by
the owner (see Owner decisions). Step 2 is gated by the proposed
[ADR-0031](../adr/ADR-0031-runtime-owned-delivery-state.md).

## Objective

The `task-delivery` skill (`skills/task-delivery`) runs one fixed 11-gate
lifecycle for every task, holds delivery state only in the executor's context,
loads about 1,275 lines of prose on every invocation, and validates its
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

| Gate id           | lite                | full        | custom      |
| ----------------- | ------------------- | ----------- | ----------- |
| `preflight`       | on                  | on          | always on   |
| `design`          | short, in the PR    | written     | choice      |
| `implementation`  | on                  | on          | always on   |
| `pull_request`    | on                  | on          | always on   |
| `review`          | one round           | on          | choice      |
| `hardening`       | with `review`       | on          | with review |
| `second_review`   | off                 | on          | choice      |
| `qa`              | `verification.full` | independent | choice      |
| `external_review` | off                 | as today    | choice      |
| `ready_for_merge` | on                  | on          | always on   |
| `post_merge`      | on                  | on          | always on   |

Configuration (additive, optional keys; all values unquoted booleans or one of
three words):

```yaml
delivery:
  profile: custom # lite | full | custom; absent means full
stages: # read only when profile is custom
  design: true
  second_review: false
  external_review: false
```

Rules:

- Absent `delivery.profile` means `full`: existing projects behave as today.
- `stages` with a profile other than `custom` is an error, as is a stage that
  is always on being set to `false`.
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
  - it only moves up. When it moves from `lite` to `full`, every gate that is
    now required and was omitted is executed before the task proceeds, and
    evidence gathered under the reduced profile does not cover them;
  - an authorizer may raise the profile, never lower it below the computed
    floor.
- External review keeps its current meaning: configured or requested makes it
  required, whatever the profile says; `lite` with a configured external
  reviewer is a configuration error rather than a silent skip.
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

At every gate the implementation context writes one compact record, and the
next stage or a fresh session starts from it:

```text
stage, result, profile, head sha, base sha, branch/PR
evidence: [{claim, command-or-link, log path, sha256}]
open findings: [{id, severity, status}]
decisions: [{what, who authorized}]
next action
```

- Evidence is cited by path and hash; output is not pasted.
- Location in step 1: an untracked file in the task worktree
  (`.task-delivery/handoff.md`, added to the worktree's local exclude).
- Resume rule: a packet whose head sha differs from the current head is
  evidence for nothing.
- Cut points are gate boundaries only. After a gate, a context reset is allowed
  and recommended when the context is large.
- Multi-task runs: an orchestrator holds the queue and a report of at most 15
  lines per task; each task runs in a fresh context started from its packet.
- Reviewer and verifier inputs stay: task, acceptance criteria, diff, plus
  the packet's evidence index, never the implementer's reasoning.

### 1.4 CLI: `delivery:validate`

- `ai-office delivery:validate [--root <path>] [--json]` moves the contract
  check of `.task-delivery.yaml` from `scripts/skills/task-delivery-config.ts`
  into a shared module used by both the CLI and `skills:validate`.
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
- It also reports the effective profile and gate list, so the skill can read
  them instead of re-deriving them.

### Tests and acceptance criteria

Shared parser and validation module (no Runtime needed, tested directly):

- every new key, wrong type, `stages` without `custom`, an always-on gate set
  to `false`, `lite` with a configured external reviewer;
- effective profile and gate list for `lite`, `full`, `custom`, and for an
  absent `delivery.profile` (equals `full`).

Skill contract and package validation:

- stage table and references stay consistent with the gate catalog; a gate a
  profile turns off does not require its reference;
- generated copies stay in sync (`skills:check`);
- floor rules are pinned by contract invariants and removal tests: floor
  determined at preflight; re-evaluated before leaving `implementation`, before
  `ready_for_merge` and on a head change that can alter the classification;
  floor only moves up; omitted gates become required and are executed when it
  moves from `lite` to `full`; lowering below the floor is refused.

CLI `delivery:validate`, end to end through the Unix-socket protocol with a
Runtime available (daemon-backed):

- valid file, invalid file, `--json` shape;
- `--root` omitted: the client's cwd is validated;
- `--root` relative: resolved against the client's cwd, and the Runtime
  receives an absolute path;
- `--root` absolute: passed unchanged;
- a Runtime that receives a relative path rejects it with a typed error and
  does not read the daemon's cwd.

Runtime unavailable:

- the CLI reports the Runtime as unreachable with the established exit code and
  message, performs no validation itself, and adds no embedded or offline
  fallback; a test asserts that the shared module is not invoked on that path.

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

1. The `task-delivery` 0.3.0 change (clarifying tasks before a run and run-wide
   stacking, currently pull request #126) is on `main`. Step 1 starts from
   that `main`. No earlier interim branch of this work is a prerequisite.
2. Step 1 in its own pull request, from the resulting `main`.
3. ADR-0031 reviewed and decided.
4. Step 2 planned as its own milestone task, only after ADR-0031 is accepted.

## Owner decisions (2026-10-07)

1. `delivery:validate` is routed through the Runtime; no new offline path.
2. The floor list (migrations, controlled actions or connectors, security
   boundaries, public contracts) is accepted.
3. "A project pipeline never removes a gate" is amended: a profile may omit the
   optional gates; a project pipeline still may not.

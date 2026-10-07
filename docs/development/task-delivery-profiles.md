# Task delivery profiles, handoff and Runtime-owned delivery state

Status: plan, not implemented. Step 1 needs no architectural decision. Step 2
is gated by the proposed
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
  `full`. The skill states the floor and the evidence for it at preflight; an
  authorizer may raise a profile, never lower below the floor.
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
- It also reports the effective profile and gate list, so the skill can read
  them instead of re-deriving them.

### Tests

- Config contract: every new key, wrong type, `stages` without `custom`,
  an always-on gate set to `false`, `lite` with an external reviewer.
- Skill package validation: stage table and references stay consistent with
  the gate catalog; a disabled gate's reference is not required.
- Generated copies stay in sync (`skills:check`).
- CLI: unknown key, valid file, `--json` shape, no Runtime required.

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

1. Land `feat/task-delivery-refinement` (7 commits, no pull request yet;
   its worktree has uncommitted regenerated skill copies that need an owner
   decision before it is touched).
2. Step 1 in one pull request, built on that branch's content.
3. ADR-0031 reviewed and decided; step 2 planned as its own milestone task.

## Owner decisions (2026-10-07)

1. `delivery:validate` is routed through the Runtime; no new offline path.
2. The floor list (migrations, controlled actions or connectors, security
   boundaries, public contracts) is accepted.
3. "A project pipeline never removes a gate" is amended: a profile may omit the
   optional gates; a project pipeline still may not.

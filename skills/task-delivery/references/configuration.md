# Project configuration

The skill reads optional, project-specific settings from a single file at the
repository root: `.task-delivery.yaml`. The file is never required, and every
key in it is optional. A ready-to-copy example is in
[task-delivery.example.yaml](../assets/task-delivery.example.yaml).

A file that is present must respect this contract exactly: a YAML mapping with
at least one key, written as plain `key: value` lines under at most one level
of section headers, each key at most once. Malformed YAML, an empty or
comment-only file, an unknown or misspelled key, a repeated key, a value of
the wrong type, an empty string, or any other YAML notation is an error, not
something to ignore: a typo would otherwise silently fall back to a default and
switch a policy off. The repository that publishes this skill detects such
errors with its `skills:validate` check. Whoever follows the skill does the
same when reading the file: on any key or value outside this contract, stop
and report it instead of continuing with defaults.

The repository's own contributor instructions always win over this file where
they are stricter.

## Keys

| Key                       | Meaning                                                                                       | Default when absent                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `integration_branch`      | Branch that task branches start from and merge into                                           | The remote's default branch                                                                 |
| `knowledgePolicy`         | Knowledge retrieval policy for handoff and resume enrichment                                  | `auto`                                                                                      |
| `verification.full`       | Command that must pass before handoff, at QA, and after merge                                 | The check command the repository documents; otherwise ask                                   |
| `verification.targeted`   | Command template for a narrow test run while iterating                                        | The repository's test runner on the changed area                                            |
| `git.worktree_required`   | `true` when each task must use an isolated workspace                                          | `false`                                                                                     |
| `git.stacking_allowed`    | `true` when a task branch may be based on an unmerged task branch                             | `false`                                                                                     |
| `external_review.command` | Command of the external reviewer; setting it makes stage 9 required                           | None: required only if the authorizer asks; otherwise best effort                           |
| `task_lifecycle.enabled`  | `true`: task state is tracked outside Git. `false`: it is not, and the skill never touches it | Tracked when a command below is configured or the project's instructions describe a tracker |
| `task_lifecycle.start`    | Command that marks a task as started, run in preflight                                        | None: the project's documented way, otherwise report                                        |
| `task_lifecycle.review`   | Command that marks a task as in review, run when its pull request is open                     | None: the project's documented way, otherwise report                                        |
| `task_lifecycle.complete` | Command that marks a task as done, used only after stage 11                                   | None: the project's documented way, otherwise report                                        |

`knowledgePolicy` is a resolved input to knowledge retrieval: where nothing
resolves it yet, the `auto` default above is descriptive only — applying the
default and persisting the setup are owned by the configuration task.

Five further keys steer the delivery itself: `checkpointFrequency`,
`handoffMode`, `resumeDetail`, `knowledgePolicy`, and `contextThreshold`.
They may sit in this file as a static fallback, and they are documented with
the Runtime setup below.

## Types

`integration_branch`, `verification.*`, `external_review.command`,
`task_lifecycle.start`, `task_lifecycle.review`, and `task_lifecycle.complete`
are non-empty strings. `knowledgePolicy` is one of the words `auto`,
`required`, or `disabled`, written unquoted.
`git.*` and `task_lifecycle.enabled` are booleans written unquoted (`true` or
`false`). `verification`, `git`, `external_review`, and `task_lifecycle` are
mappings; no other key is allowed at any level. To drop the configuration,
delete the file instead of emptying it; task state is then tracked or not as
the project's own instructions say.

Only this layout is accepted, so that no two readers can take the file
differently and a repeated or disguised key cannot hide:

- printable ASCII text with LF line endings: no byte-order mark, no CRLF, no
  tabs, no control or other characters, in comments too;
- unquoted keys, one `key: value` per line with a space after the colon, nested
  keys indented with spaces at one depth under their section;
- comments on their own line, after a section header, a boolean, or a quoted
  value; an optional leading `---`;
- booleans written `true` or `false`, lowercase and unquoted;
- a string unquoted only when it starts with a letter, contains no `: ` or
  ` #`, does not end with `:`, and is not a word a YAML reader may type
  (`y`, `n`, `yes`, `no`, `on`, `off`, `true`, `false`, `null` in any case, or
  `e` followed by digits);
- any other string wrapped whole in quotes on one line: double quotes, where
  `\"` and `\\` are the only escapes, or single quotes, where `''` stands for
  a single quote.

Quoted keys, flow collections (`{...}`, `[...]`), anchors, aliases, tags, merge
keys, block scalars, lists, and values continued on a following line are
rejected. A command that needs several lines belongs in a script.

In `external_review.command`, `{base}` stands for the branch the task's pull
request targets: the integration branch, or the branch the task is stacked on.
Replace it before running the command, so that the review covers the task's
own diff and nothing else.

In the `task_lifecycle` commands, `{task}` stands for the identifier of the
task in the system that tracks it. Replace it before running the command.

## Knowledge retrieval policy

`knowledgePolicy` decides how a handoff or a resume uses read-only,
task-linked knowledge from the project's knowledge store:

- `disabled`: no retrieval and no knowledge section in the handoff.
  References already recorded in a checkpoint stay listed as-is.
- `auto` (the default): attempt `knowledge:task` for the task. When the
  reported state is not connected, continue without knowledge and record a
  one-line evidence note naming the state.
- `required`: knowledge retrieval is mandatory; when the store is not
  connected, the handoff or resume gate blocks with the typed error recorded
  as evidence. Only the authorizer may lower the policy to proceed.

Knowledge stays advisory under every value; no value makes retrieved
knowledge a gate input, and no value writes anything back.

## Runtime setup

Five keys steer the delivery: `checkpointFrequency`, `handoffMode`,
`resumeDetail`, `knowledgePolicy`, and `contextThreshold`. They resolve in
this order:

1. **Runtime setup**, when the project has a Runtime that answers: the
   project stores its own defaults, with optional overrides per run and per
   task. Read them with `delivery:setup:show` and write one with
   `delivery:setup:set --key <key> --value <json>`; a run or task scope adds
   `--run <id>` or `--task <id>`, and `--value null` deletes the key. Values
   merge over the built-in defaults in the order project, then run, then
   task: the narrowest scope wins.
2. **This file**, as a static fallback for a project without a Runtime. The
   same five keys are accepted here under the same value contract; a key
   present in both places is read from the Runtime when one answers.
3. **The built-in defaults** below, when neither answers.

A Runtime that was not contacted is reported as not checked, never as
unreachable, and it is never required: without it, the file and the defaults
carry the same contract. From a checkout,
`bun scripts/skills/setup-resolution.ts [--project <id>] [--task <id>] [--run <id>]`
runs this whole resolution and prints one JSON line,
`{schemaVersion: 1, source, values}`, for scripts and tests; a configuration
that breaks its contract exits 1 with the typed message on stderr instead of
guessing around it. Pass `--project` when the project id is known (the
delivery flow usually knows it): without it, the office CLI discovers the
binding from the current directory, and a directory the binding cannot reach —
a task worktree, for example — resolves through the file or the defaults
instead of pretending the Runtime was checked.

### Setup keys

| Key                   | Values                                             | Default      | Meaning                                                                                                                                         |
| --------------------- | -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpointFrequency` | `every-gate`, `stage-boundaries`, `handoff-only`   | `every-gate` | When the implementation context publishes a checkpoint: at every gate, only at stage boundaries, or only when a handoff is prepared             |
| `handoffMode`         | `offer`, `gate`                                    | `offer`      | `offer` asks at each trigger and never blocks; `gate` makes the handoff question part of the workflow — never a gate of any review              |
| `resumeDetail`        | `brief`, `standard`, `full`                        | `standard`   | How much stage evidence a resuming context re-reads from the checkpoint before continuing, as [checkpoints](checkpoints.md) describes            |
| `knowledgePolicy`     | `auto`, `required`, `disabled`                     | `auto`       | The resolved value feeds the knowledge retrieval policy above; it is the only setup key the handoff and resume gates consume                     |
| `contextThreshold`    | a number from 0 to 1                               | 0.25         | Offers a handoff when the remaining context is estimated below this fraction; applies only where the executor can measure its remaining context  |

The words are unquoted strings; `contextThreshold` is the one numeric key,
written as plain digits with an optional decimal fraction (`0.25`), never
quoted.

### Guided setup

On the first invocation, when no Runtime setup and no configuration value
answers a setup key, ask for it instead of guessing: one question per key,
offering the default above, through the executor's own question mechanism.
Persist every answer with `delivery:setup:set` when a Runtime answers, or
record it in `.task-delivery.yaml` when none does; the resolution order then
keeps it for every later run. Asking is never blocking: a declined question
keeps the default and needs nothing.

## Rules

- Configuration selects commands and policies. It never grants authority: no
  key can authorize a merge, widen scope, or waive a gate.
- Commands are run as written from the repository root. Treat a non-zero exit
  code as a failed gate.
- When task state is tracked - `task_lifecycle.enabled` is `true`, a command
  is configured, or the project's instructions describe a tracker and the key
  is not `false` - every transition is made: with the
  configured command; without one, in the project's own documented way of
  changing task state; and only where there is none, by reporting the
  transition so the tracker's owner can apply it. A refused transition is a
  stop condition.
- `task_lifecycle.enabled: false` together with a `task_lifecycle` command is
  an error: the commands would never run.
- The roles in the skill are independent of who performs them. A project may
  bind them to its own role names and to any executor; the pipeline stays the
  same when the executor changes.

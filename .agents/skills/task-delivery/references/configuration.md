# Project configuration

The skill reads optional, project-specific settings from a single file at the
repository root: `.task-delivery.yaml`. The file is never required, and every
key in it is optional. A ready-to-copy example is in
[task-delivery.example.yaml](../assets/task-delivery.example.yaml).

A file that is present must respect this contract exactly: a YAML mapping with
at least one key, written one key per line, each key at most once. Malformed
YAML, an empty or comment-only file, an unknown or misspelled key, a repeated
key, a value of the wrong type, or an empty string is an error, not something
to ignore: a typo would otherwise silently fall back to a default and
switch a policy off. The repository that publishes this skill detects such
errors with its `skills:validate` check. Whoever follows the skill does the
same when reading the file: on any key or value outside this contract, stop
and report it instead of continuing with defaults.

The repository's own contributor instructions always win over this file where
they are stricter.

## Keys

| Key                       | Meaning                                                             | Default when absent                                               |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `integration_branch`      | Branch that task branches start from and merge into                 | The remote's default branch                                       |
| `verification.full`       | Command that must pass before handoff, at QA, and after merge       | The check command the repository documents; otherwise ask         |
| `verification.targeted`   | Command template for a narrow test run while iterating              | The repository's test runner on the changed area                  |
| `git.worktree_required`   | `true` when each task must use an isolated workspace                | `false`                                                           |
| `git.stacking_allowed`    | `true` when a task branch may be based on an unmerged task branch   | `false`                                                           |
| `external_review.command` | Command of the external reviewer; setting it makes stage 9 required | None: required only if the authorizer asks; otherwise best effort |
| `task_lifecycle.enabled`  | `true` when task state is tracked in a system outside Git           | `false`                                                           |
| `task_lifecycle.start`    | Command that marks a task as started                                | None: report the transition instead                               |
| `task_lifecycle.complete` | Command that marks a task as done, used only after stage 11         | None: report the transition instead                               |

## Types

`integration_branch`, `verification.*`, `external_review.command`,
`task_lifecycle.start`, and `task_lifecycle.complete` are non-empty strings.
`git.*` and `task_lifecycle.enabled` are booleans written unquoted (`true` or
`false`). `verification`, `git`, `external_review`, and `task_lifecycle` are
mappings; no other key is allowed at any level. To switch everything off,
delete the file instead of emptying it. Keep it flat and plain: no anchors,
aliases, tags, or merge keys, and no multi-line value containing a line that
starts with one of the key names.

## Rules

- Configuration selects commands and policies. It never grants authority: no
  key can authorize a merge, widen scope, or waive a gate.
- Commands are run as written from the repository root. Treat a non-zero exit
  code as a failed gate.
- When `task_lifecycle.enabled` is `true` and no command is given, report each
  transition so the tracker's owner can apply it.
- The roles in the skill are independent of who performs them. A project may
  bind them to its own role names and to any executor; the pipeline stays the
  same when the executor changes.

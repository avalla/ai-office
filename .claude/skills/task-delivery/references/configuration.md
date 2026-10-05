# Project configuration

The skill reads optional, project-specific settings from a single file at the
repository root: `.task-delivery.yaml`. The file is never required. Unknown keys
are ignored. A ready-to-copy example is in
[task-delivery.example.yaml](../assets/task-delivery.example.yaml).

The repository's own contributor instructions always win over this file where
they are stricter.

## Keys

| Key                       | Meaning                                                           | Default when absent                                       |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `integration_branch`      | Branch that task branches start from and merge into               | The remote's default branch                               |
| `verification.full`       | Command that must pass before handoff, at QA, and after merge     | The check command the repository documents; otherwise ask |
| `verification.targeted`   | Command template for a narrow test run while iterating            | The repository's test runner on the changed area          |
| `git.worktree_required`   | `true` when each task must use an isolated workspace              | `false`                                                   |
| `git.stacking_allowed`    | `true` when a task branch may be based on an unmerged task branch | `false`                                                   |
| `external_review.command` | Command that runs the external reviewer on the current branch     | Not configured: stage 9 is skipped                        |
| `task_lifecycle.enabled`  | `true` when task state is tracked in a system outside Git         | `false`                                                   |
| `task_lifecycle.start`    | Command that marks a task as started                              | None: report the transition instead                       |
| `task_lifecycle.complete` | Command that marks a task as done, used only after stage 11       | None: report the transition instead                       |

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

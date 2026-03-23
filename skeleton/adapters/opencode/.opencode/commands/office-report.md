# /office-report

Description: Generate a project report. Usage: /office-report <status|investor|tech-debt|audit|velocity>

## Report: `status`

Read:
- `.ai-office/tasks/README.md` (task counts)
- All files in `.ai-office/tasks/WIP/` and `.ai-office/tasks/TODO/`
- All `*-status.md` files in `.ai-office/docs/runbooks/`

Output:
```
# Project Status Report — <today>

## Task Board
| Column | Count |
|--------|-------|
| BACKLOG | X |
| TODO | X |
| WIP | X |
| REVIEW | X |
| DONE | X |

## Active Features (WIP)
- <slug>: state=<state>, owner=<owner>

## Blocked
- <any features with state=blocked>

## Recently Completed
- <last 3 DONE tasks>
```

---

## Report: `investor`

Read all status files, task counts, and any existing investor report in `.ai-office/docs/`. Run `git log --oneline -10` as a bash command to get the last 10 commits.

Output a concise investor update:
```
# Investor Update — <today>

## Progress This Period
- Key features shipped
- Milestones reached

## Current Sprint
- What's in WIP now

## Metrics
- Tasks done / total
- Features in flight

## Next Milestone
- What ships next and when
```

---

## Report: `tech-debt`

Scan for signals of tech debt:
- Read `.ai-office/tasks/BACKLOG/` for any tasks mentioning "refactor", "debt", "cleanup", "TODO", "fixme"
- Check git log for commits with "hack", "temporary", "fixme", "workaround" in messages
- List any known issues from status files with `blocked` state

Output a prioritized list of tech debt items.

---

## Report: `audit`

Read all status files and task files. Produce a structured audit:

```
# Project Audit — <today>

## Pipeline Health
- Features in flight: X
- Blocked features: X
- Average time in WIP (estimate from file dates)

## Quality Gates
- Tasks in REVIEW: X (pending review)
- Tasks bypassed review (moved REVIEW→DONE without evidence): check files

## Task Board Health
- Stale WIP tasks (no update in >7 days based on file dates): list them
- Empty columns: note any

## Recommendations
- Prioritized action items
```

---

## Report: `velocity`

Read all task files in `.ai-office/tasks/DONE/` and `.ai-office/tasks/ARCHIVED/`. Group completed tasks by milestone and by week (using `**Completed:**` date).

Output:

```
# Velocity Report — <today>

## Tasks Completed by Milestone

| Milestone | Total Done | HIGH | MEDIUM | LOW |
|-----------|-----------|------|--------|-----|
| M1        | 7         | 3    | 3      | 1   |
| M2        | 2         | 1    | 1      | 0   |
| M0        | 3         | 0    | 2      | 1   |

## Weekly Throughput (last 4 weeks)

| Week        | Tasks Completed |
|-------------|----------------|
| <week 1>    | X              |
| <week 2>    | X              |
| <week 3>    | X              |
| <week 4>    | X              |

## Avg throughput: X tasks/week

## In Progress (WIP)

- X tasks currently in WIP
- Assignees: <list unique assignees in WIP>

## Observations

- <Note any milestone with 0 completions in the past 2 weeks>
- <Note any assignee with > 3 tasks in WIP simultaneously>
```

If no completed tasks exist, say so and suggest running `/office-task-move <id> DONE` as tasks are finished.

<!-- ai-office-version: 1.11.0 -->

<!-- ai-office-version: 1.11.0 -->

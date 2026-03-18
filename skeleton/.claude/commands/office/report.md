---
description: Generate a project report. Usage: /office:report <status|investor|tech-debt|audit>
---

$ARGUMENTS: `<status|investor|tech-debt|audit>`

---

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

Read all status files, task counts, git log (last 10 commits via bash), and any existing investor report in `.ai-office/docs/`.

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

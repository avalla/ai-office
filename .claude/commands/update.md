---
description: Update the AI Office framework in a target project. Usage: /update [project-path]
---

$ARGUMENTS format: `[project-path]`

- **project-path**: path to the target project root. Defaults to the current working directory.

---

## Steps

1. Read the installed version from `<project-path>/.claude/commands/office/.version` (or report "unknown").
2. Read the available version from `VERSION` in this repo.
3. Report: "Installed: `<installed>` · Available: `<available>`"

4. If versions match: "Already up to date. Nothing to do."

5. If an update is available, show which command files have changed:
   - Compare each file in `skeleton/.claude/commands/office/` with the installed copy
   - List new files (`+`) and changed files (`~`)

6. Ask: "Apply update v`<installed>` → v`<available>`? (yes / no)"

7. If confirmed: run `./update.sh <project-path>` and show the output.

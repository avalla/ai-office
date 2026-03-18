---
description: Remove the AI Office framework from a target project. Usage: /uninstall [project-path] [--keep-data]
---

$ARGUMENTS format: `[project-path] [--keep-data]`

- **project-path**: path to the target project root. Defaults to the current working directory.
- **--keep-data**: remove commands only; leave `.ai-office/` (tasks, docs, config) intact.

---

## Steps

1. Resolve the target path. Confirm: "Uninstalling AI Office from `<path>`."

2. Check what exists:
   - `.claude/commands/office/` — N command files + `.version`
   - `.ai-office/` — tasks, docs, config, milestones

3. Show the removal plan:
   ```
   Will remove:
     ✂️  .claude/commands/office/   (18 files + .version)
   ```
   If `--keep-data` is NOT set, also show:
   ```
     ✂️  .ai-office/                (tasks, docs, config, milestones)
   ```
   If `--keep-data` IS set:
   ```
     ✅  .ai-office/                (kept — tasks and docs preserved)
   ```

4. Warn if there are open tasks (WIP or TODO files in `.ai-office/tasks/`) and `--keep-data` is not set:
   ```
   ⚠️  X open tasks found in WIP/TODO. They will be deleted with .ai-office/.
   ```

5. Ask: "Confirm uninstall? This cannot be undone. (yes / no)"

6. If confirmed:
   - Always remove `.claude/commands/office/`
   - If `--keep-data` is not set: remove `.ai-office/`
   - If `.claude/commands/` is now empty, remove it too

7. Confirm: "✅ AI Office removed from `<path>`."
   If data was kept: "ℹ️  .ai-office/ data preserved."

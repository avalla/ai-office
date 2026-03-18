---
description: Install the AI Office framework into a target project. Usage: /install [project-path]
---

$ARGUMENTS format: `[project-path]`

- **project-path**: absolute or relative path to the target project root. Defaults to the current working directory.

---

## Steps

1. Confirm the target: "Installing AI Office into `<resolved-path>`."

2. Run the installer:
   ```bash
   ./install.sh <project-path>
   ```

3. Show the output. If it fails, diagnose and report the error clearly.

4. If install succeeds and `.ai-office/project.config.md` is missing, ask:
   "Framework installed. Would you like to run the setup wizard now? (yes / no)"
   - If yes: run `./setup.sh <project-path>` or guide through `/office:setup`.

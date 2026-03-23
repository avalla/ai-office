---
name: office-script
description: List, run, or create AI Office markdown scripts. Usage: /office-script <list | run <name> | create <name> | validate <name>>
disable-model-invocation: true

$ARGUMENTS format: `<list | run <name> [--dry-run] | create <name> | validate <name>>`

Scripts directory: `.ai-office/scripts/`

---

## `list`

Scan `.ai-office/scripts/` for `.md` files. For each, read the frontmatter (`title`, `description`) and display:

```
Available Scripts

| Name | Title | Description |
|------|-------|-------------|
| deploy-check | Deploy Checklist | Runs pre-deploy validations |
| ...

Run a script: /office-script run <name>
```

If the directory doesn't exist or is empty: "No scripts found. Create one with /office-script create <name>"

---

## `run <name> [--dry-run]`

1. Read `.ai-office/scripts/<name>.md`
2. Parse the frontmatter for `title` and `description`
3. Parse each step section:
   ```markdown
   ## Step N: <description>
   **Type:** command|file|check|prompt
   **If:** <condition> (optional)
   ```

4. Execute each step in order based on type:

   - **`command`**: Run the shell command in the code block using the Bash tool. Record stdout/stderr and PASS/FAIL.
   - **`file`**: Parse `CREATE <path>` or `DELETE <path>` instructions and perform the file operation. In dry-run mode, just report what would happen.
   - **`check`**: Verify the condition (file exists, command exits 0). Report PASS/FAIL.
   - **`prompt`**: Return the prompt text as a message for the LLM (me) to handle — do not execute as a shell command.

   If `**If:**` condition is present: evaluate it before executing. Skip the step if the condition is false, note it as SKIPPED.

5. In `--dry-run` mode: show each step and what would happen, but don't execute commands or write files.

6. Output execution log:
   ```
   Running script: <title>

   Step 1: <description> ✅ PASS
   Step 2: <description> ⚠️  SKIPPED (condition not met)
   Step 3: <description> ❌ FAIL — <error>

   Result: 2 passed, 1 failed, 1 skipped
   ```

Stop execution on first FAIL unless the step has `**Continue on failure:** true`.

---

## `create <name>`

Create `.ai-office/scripts/<name>.md` with a starter template:

```markdown
---
title: <name>
description: Describe what this script does
---

## Step 1: Example Command
**Type:** command

```bash
echo "Hello from script"
```

## Step 2: Example Check
**Type:** check

Check if file exists package.json

## Step 3: Example Prompt
**Type:** prompt

Summarize the output of the previous steps and suggest next actions.
```

Confirm: "Created `.ai-office/scripts/<name>.md` — edit it to add your steps."

---

## `validate <name>`

Read `.ai-office/scripts/<name>.md`. Parse and validate:
- Frontmatter has `title` and `description`
- Each step has `**Type:**` field with a valid value
- `command` steps have a non-empty code block
- `file` steps have valid `CREATE`/`DELETE` syntax
- No circular references

Output a step-by-step breakdown with any issues flagged.

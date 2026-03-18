---
description: Interactive project setup wizard — configure agency, tech stack, and quality thresholds. Usage: /office:setup
---

You are running the AI Office project setup wizard.

## Step 1 — Check existing config

Read `.ai-office/project.config.md`.

- **If it exists**: enter **reconfigure mode** — show current values and ask what to change
- **If it doesn't exist**: enter **initial setup mode** — ask all questions from scratch

---

## Initial Setup Mode

Ask the following questions one at a time. Wait for each answer before asking the next.

### 1. Project name
"What is your project name? (used in reports and status files)"

### 2. Agency type
"Select an agency type:

1. **software-studio** — Full-stack web/mobile, complete SDLC
2. **lean-startup** — Rapid MVP, minimal process
3. **game-studio** — Game development
4. **creative-agency** — Media & content production
5. **media-agency** — Video and movie production
6. **penetration-test-agency** — Security testing and audits

You can also describe your project and I'll recommend one."

Read their answer. If they describe a project instead of choosing a number, suggest the best fit and confirm.

### 3. Tech stack
"What commands does your project use? (press Enter to keep the suggested default)

- Typecheck: (suggest based on agency — `npm run typecheck` for web projects, `mypy src` for Python, `go vet ./...` for Go)
- Lint: (suggest `npm run lint`, `ruff check .`, or `golangci-lint run`)
- Test: (suggest `npm run test`, `pytest`, or `go test ./...`)
- Test runner name: (vitest / jest / pytest / go test)"

### 4. Design system (skip if no UI framework)
"What UI framework and design system does your project use?
Examples: React + shadcn/ui, Vue + Vuetify, React Native + NativeBase, or 'none' to skip"

### 5. Quality thresholds
"Quality gate thresholds (press Enter for defaults):
- Minimum test coverage: [80]%
- Minimum Lighthouse score: [90] (set to 0 to skip)"

### 6. Advance mode
"How should the pipeline advance between stages?

1. **manual** — pause and ask for confirmation before each stage transition (default, recommended)
2. **auto** — validate and advance automatically without prompting

In both modes you can always override by running `/office:advance <slug>` manually."

Read their answer (1 or 2, or the word). Default: `manual`.

---

## Write the config

After collecting all answers, write `.ai-office/project.config.md` with this format:

```markdown
---
agency: <selected>
project_name: <name>

typecheck_cmd: "<cmd>"
lint_cmd: "<cmd>"
test_cmd: "<cmd>"
test_runner: <runner>

ui_framework: <framework or "">
design_system: "<system or "">"

coverage_min: <N>
lighthouse_min: <N>

# Pipeline behaviour — manual | auto
advance_mode: <advance_mode>
---

# Project Configuration

**Project:** <name>
**Agency:** <selected>
**Created:** <today ISO>

## Notes

> Add project-specific context here.
```

Also write `.ai-office/agency.json`:
```json
{
  "name": "<agency>",
  "selectedAt": "<ISO timestamp>",
  "custom": false
}
```

---

## Reconfigure Mode

Show the current values from the frontmatter in a table:

```
Current configuration (.ai-office/project.config.md)

Field             Current value
───────────────── ─────────────────────────
agency            software-studio
project_name      My Project
typecheck_cmd     npm run typecheck
lint_cmd          npm run lint
test_cmd          npm run test
design_system     shadcn/ui
coverage_min      80
lighthouse_min    90
advance_mode      manual
```

Ask: "What would you like to change? (list field names, or 'all' to redo everything, or 'cancel')"

Accept a list of field names (e.g. "test_cmd, design_system") and ask only for those values. Keep all others unchanged. Then update the frontmatter in-place.

---

## After writing

1. Confirm: "✅ Configuration saved — `.ai-office/project.config.md`"
2. Run the equivalent of `/office:doctor` inline and show the result
3. Suggest: "Run `/office:route <describe your next task>` to get started"

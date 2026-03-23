---
name: office-setup
description: Interactive project setup wizard — configure agency profile, tech stack, and quality thresholds. Usage: $office-setup
disable-model-invocation: true

You are running the AI Office project setup wizard.

## Step 1 — Check existing config

Read `.ai-office/project.config.md`.

- **If it exists**: enter **reconfigure mode** — show current values and ask what to change
- **If it doesn't exist**: enter **initial setup mode** — ask all questions from scratch

---

## Initial Setup Mode

Ask the following questions one at a time. Wait for each answer before asking the next.

### 1. Project name
"What is your project name?"

### 2. Domain
"What kind of project is this?

1. Web app (frontend + backend, SaaS, dashboards)
2. Mobile app (iOS / Android / React Native)
3. API / backend service (no UI)
4. Data pipeline / analytics
5. CLI tool / developer tooling
6. Game
7. Content / media production
8. Other — describe it"

### 3. Team composition
"Who is working on this project?

1. Just me + AI (solo)
2. Small team (2–5 people) + AI
3. Larger team — AI assists specific roles"

### 4. Quality concerns
"What are the critical quality concerns? (pick all that apply, e.g. '1 3')

1. Security-sensitive (auth, payments, PII, compliance)
2. Performance-critical (latency, throughput, scale)
3. High test coverage required
4. Strong UX / accessibility standards
5. Compliance or audit trail required (SOC2, HIPAA, GDPR)
6. None in particular — standard quality"

### 5. Tech stack
"What commands does your project use? (press Enter to accept the suggestion)

- Typecheck: (suggest based on domain — `npm run typecheck` for web/mobile, `mypy src` for Python, `go vet ./...` for Go)
- Lint: (suggest `npm run lint`, `ruff check .`, or `golangci-lint run`)
- Test: (suggest `npm run test`, `pytest`, or `go test ./...`)"

### 6. UI framework (skip if domain is API / data pipeline / CLI)
"What UI framework and design system are you using?
Examples: React + shadcn/ui, Vue + Vuetify, React Native + NativeBase, or 'none'"

### 7. Release cadence
"How do you ship?

1. Continuous deploy (merge to main = ship)
2. Sprint-based (weekly or biweekly releases)
3. Milestone releases (explicit version tags)"

### 8. Advance mode
"How should the pipeline advance between stages?

1. **manual** — pause and ask before each stage transition (default, recommended)
2. **auto** — validate and advance automatically"

---

## Agency Profiling

Based on answers to steps 2–4 and 7, derive the agency profile. Do not ask more questions — generate it from what you know.

**Agent selection rules:**

| Condition | Include agent |
|-----------|--------------|
| Always | `developer`, `qa` |
| Domain = web app or mobile | `designer` |
| Domain = web app or mobile, team > solo | `pm` |
| Quality concern = security, compliance | `security-specialist` |
| Quality concern = performance | `reviewer` (performance focus) |
| Team > solo OR milestone releases | `architect` |
| Continuous deploy OR compliance | `ops` |

**Per-agent focus** — tailor the description to the project's actual stack and concerns, not generic text. Examples:
- developer: "Next.js + Supabase, focus on RLS and edge functions"
- qa: "Vitest unit tests + Playwright E2E, auth flows are highest priority"
- security-specialist: "Stripe webhook validation, Supabase RLS policies, session handling"

**Handoff rules** — derive from cadence:
- Continuous deploy → `dev → qa → review → release` on every PR
- Sprint → `dev → qa → review` mid-sprint, `release` at sprint end
- Milestone → full pipeline per milestone, explicit release gate

---

## Write the config

After collecting all answers, write `.ai-office/project.config.md`:

```markdown
---
agency: <project-slug>
project_name: <name>

typecheck_cmd: "<cmd>"
lint_cmd: "<cmd>"
test_cmd: "<cmd>"
test_runner: <runner>

ui_framework: <framework or "">
design_system: "<system or "">"

coverage_min: <N>
lighthouse_min: <N>

advance_mode: <advance_mode>
release_cadence: <continuous|sprint|milestone>
---

# Project Configuration

**Project:** <name>
**Agency:** <project-slug> (custom)
**Created:** <today ISO>

## Notes

> Add project-specific context here.
```

Write `.ai-office/agencies/<project-slug>/config.md`:

```markdown
# Agency: <project-slug>

**Project:** <name>
**Domain:** <domain>
**Generated:** <today ISO>

## Active Agents

| Agent | Role | Focus for this project |
|-------|------|------------------------|
| developer | Implementation | <tailored focus> |
| qa | Quality assurance | <tailored focus> |
<... other agents ...>

## Handoff Rules

<derived from release cadence>

## Quality Gates

- Test coverage: ≥ <N>%
<... other gates from quality concerns ...>
```

Write `.ai-office/agency.json`:
```json
{
  "name": "<project-slug>",
  "selectedAt": "<ISO timestamp>",
  "custom": true
}
```

---

## Reconfigure Mode

Show the current values from the frontmatter in a table:

```
Current configuration (.ai-office/project.config.md)

Field             Current value
───────────────── ─────────────────────────
agency            my-project (custom)
project_name      My Project
typecheck_cmd     npm run typecheck
lint_cmd          npm run lint
test_cmd          npm run test
design_system     shadcn/ui
coverage_min      80
lighthouse_min    90
advance_mode      manual
release_cadence   sprint
```

Ask: "What would you like to change? (list field names, or 'agency' to re-run profiling, or 'all' to redo everything, or 'cancel')"

If the user says `agency`: re-run the agency profiling questions (steps 2–4, 7) and regenerate `.ai-office/agencies/<project-slug>/config.md`.

Otherwise accept a list of field names and ask only for those values. Keep all others unchanged. Then update the frontmatter in-place.

---

## After writing

1. Confirm: "✅ Configuration saved — `.ai-office/project.config.md`"
2. Show the generated agency roster as a table
3. Run the equivalent of `$office-doctor` inline and show the result
4. Suggest: "Run `$office-route <describe your next task>` to get started"

<!-- ai-office-version: 1.5.0 -->

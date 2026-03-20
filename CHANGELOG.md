## 1.4.0 — 2026-03-19

### Added

**Furniture CAD Studio agency:**
- New custom agency `furniture-cad-studio` for furniture design and manufacturing workflows
- 10 agents mapped to furniture roles: Design Director, Project Manager, Furniture Designer, CAD Modeler, Structural Reviewer, Material Specifier, Manufacturing Spec Writer, Quality Controller, Project Planner, Delivery Manager
- Full pipeline: brief intake → concept → structural review → CAD modeling + materials (parallel) → QA → manufacturing specs → delivery
- Templates: Client Brief, Concept Doc, Structural ADR, Materials Spec, Manufacturing Spec (with cut list and tolerances), CAD Session Log
- Quality thresholds: ±0.5 mm dimensional accuracy, 100% spec coverage, mandatory structural sign-off
- Iteration limits: CAD↔QA max 3, concept↔client max 3, manufacturing spec↔review max 2

**FreeCAD MCP adapter:**
- `freecad` adapter added to `skeleton/.mcp.json` using env vars `FREECAD_MCP_SERVER_PATH` and `FREECAD_CMD_PATH`
- Runs FreeCAD headless via `QT_QPA_PLATFORM=offscreen`
- Added to company-level MCP baseline in `software-mcp-proposals.md`

**Task management improvements:**
- Task Slug field — link tasks to parent features for better tracking
- BLOCKED column — tasks with blockers tracked with explicit unblock criteria
- Labels visible in `/office:task-list` output

**Reporting:**
- Velocity reporting added to `/office:report velocity` — throughput metrics per milestone

**Artifacts:**
- Discuss artifact — context documents at `.ai-office/docs/context/<slug>.md`
- Runbook artifact — deployment runbooks at `.ai-office/docs/runbooks/<slug>-plan.md`

**Italian Legal Studio agency:**
- New agency `italian-legal-studio` for Italian law firms
- 6 agents: Senior Partner, Associate Attorney, Paralegal, Compliance Officer, Reviewer, Practice Manager
- Templates for: Atto di Citazione, Memoria Difensiva, Parere Legale, Contratto, Delibera
- Statute of limitations tracking, billable hours, partner approval workflow

**Status file loop guards:**
- All status files now include a `## Loop Guards` table with iteration counters

**Signal Analyst agent:**
- New `signal-analyst` agent with full technical analysis expertise for crypto trading contexts
- Competencies: EMA/RSI/MACD/ATR/Bollinger/VWAP/Volume Profile, crypto-specific signals (funding rates, OI, liquidation levels, exchange flows), market regime detection, walk-forward testing, overfitting detection
- Owns `25_signal_design` and `40_backtest_review` workflows
- Replaces Tokenomics Strategist as Signal Analyst in `crypto-scalping-studio`

**Crypto Scalping Studio agency:**
- New custom agency `crypto-scalping-studio` for scalping strategy development, signal services, and live trading operations
- 10 agents: Trading Director, PM, Signal Analyst, Scalping Engineer, Quant Developer, Risk Manager, Backtester/QA, Strategy Reviewer, Ops Monitor, Delivery Manager
- Full pipeline: brief → risk params → signal design + implement → backtest → strategy review → paper trade → live deploy → monitor
- Quality thresholds: Sharpe ≥ 1.5, drawdown ≤ 15%, win rate ≥ 52%, paper trade ≥ 7 days
- Templates: Signal Brief, Risk ADR, Backtest Report, Paper Trade Report, Deployment Runbook, Performance Review
- Quickstart guide with worked example pipeline

**Website and presentation:**
- `website/` — Vite + React marketing site with all 9 agencies, 27 agents, commands, quick start, v1.4.0 highlights
- `spectacle-slides/` — Spectacle MDX presentation covering full framework

**Legal agent profile audit:**
- All 5 legal agents (senior-partner, associate-attorney, compliance-officer, paralegal, practice-manager) normalized to standard 6-file structure
- Added `trigger: when_referenced` frontmatter to all legal agent files
- Expanded competencies, skills, triggers, workflows, mcp-adapters to match quality of development agents
- Fixed paralegal and practice-manager MCP adapters (removed non-existent `calendar-management`, `document-editor`, `calendar-integration`, `billing-system`)

**Version annotations:**
- All skeleton command files tagged with `<!-- ai-office-version: 1.4.0 -->`

### Fixed

- `/office:verify` now recommends REVIEW (not DONE) as the next state
- `/office:validate` sprint duration set to a concrete 14 days
- `/office:advance` improved error handling
- Task matching now uses Slug field with filename fallback

---

## 1.3.0 — 2026-03-18

### Added

**Labels support:**
- `/office:task-create` — new `labels:tag1,tag2` argument; `**Labels:**` field added to task file template
- `/office:task-update` — new command to update task metadata (labels, priority, assignee, estimate, deps) without moving the task

**Task history:**
- Task files now include a `## History` section; `/office:task-create` writes the initial `Created in <column>` entry
- `/office:task-move` appends a timestamped `<OLD> → <NEW>` entry to `## History` on every move
- `/office:task-update` appends a `Updated — <changed fields>` entry to `## History`
- `/office:verify` appends verdict and outcome to `## History`

**Discussion phase (GSD-inspired):**
- `/office:route` now runs a two-phase flow: (1) classify the request, (2) ask 4–6 tailored questions before routing and write `.ai-office/docs/context/<slug>.md` with constraints, patterns, and ruled-out approaches; Quick fix requests skip the discussion phase

**Active QA verification:**
- `/office:verify <task-id>` — new command that actively verifies acceptance criteria using auto (tests, typecheck, lint, grep), inspect (code reading), and manual methods; diagnoses root causes of failures; renders an APPROVED or RETURNED verdict; updates the task's `## History`

**Custom agency profiling:**
- `/office:setup` — step 2 replaced: instead of picking from a premade list, Claude interviews you (domain, team, quality concerns, cadence) and generates a custom `.ai-office/agencies/<slug>/config.md` with tailored agent roster, per-agent focus, and handoff rules
- `/office:route` — new pre-check warns if no agency is configured and blocks routing until `/office:setup` is run
- `/office:agency` — simplified to three subcommands: `list` (active roster), `get <name>` (raw config), `profile` (re-run interview independently)

**File version annotations:**
- Modified skeleton command files now include `<!-- ai-office-version: 1.3.0 -->` at the end; `update.sh` uses these annotations to detect per-file staleness

### Changed

- `milestone.md` — `status` command now shows priority breakdown (HIGH/MEDIUM/LOW done counts) and lists all labels in use across the milestone's tasks
- `install.sh` — prints available addons with activation instructions at the end of install
- `update.sh` — compares `ai-office-version` annotations per file; falls back to full diff for unannotated files
- `doctor.md` — command count updated to 23; added agency profile check; added `docs/context/` directory check

# Changelog

## 1.2.1 — 2026-03-18

### Added

**`/office:milestone create` — task generation:**
- New optional argument `tasks:yes|no|ask` (default: `ask`)
- After creating the milestone file, the system reasons about the milestone name plus any related PRD/ADR context to suggest 4–12 tasks covering the full pipeline (backend, API, UI, tests, security, docs)
- Each suggestion includes title, assignee (agent-mapped by task type), priority, and estimate
- In `ask` mode with `advance_mode: manual`: presents a table and asks `all | select <numbers> | edit | none`
- In `ask` mode with `advance_mode: auto`, or with `tasks:yes`: creates all tasks immediately
- The milestone file's `## Definition of Done` is auto-populated from the suggested task titles
- Task numbers are auto-assigned sequentially within the milestone

**New commands (3):**
- `/office:run-tests <slug>` — runs `test_cmd` from `project.config.md`, parses runner output (vitest, jest, pytest, go test), appends `## Test Results` with per-suite breakdown and coverage % to `<slug>-status.md`; warns if coverage is below `coverage_min`
- `/office:validate-secrets [path]` — scans the codebase for hardcoded secrets using pattern matching (passwords, API keys, tokens, private keys, AWS IDs, GitHub tokens); allowlists env-var placeholders and test fixtures; shows redacted snippets and remediation advice
- `/office:role <agent-name>` — displays an agent's `personality.md` enriched with stage-specific focus guidance; warns if viewing a non-active agent's role for the current pipeline state

**Base rules (`CLAUDE.md`):**
- `skeleton/.claude/CLAUDE.md` — always-on quality rules installed at `.claude/CLAUDE.md` in every project; ported and adapted from Windsurf `base-*` + `global.md` + `task-management.md` rule files; covers reasoning & scope control, code quality, TypeScript strict rules, security, git conventions, AI Office workflow, task state transitions, and loop guards

**Opt-in addons (`skeleton/.ai-office/addons/`):**
- `typescript-naming.md` — file naming, identifier casing, boolean/async function prefixes
- `supabase.md` — RLS policies, migrations, Edge Functions, pgTAP patterns
- `bun-monorepo.md` — Bun runtime preferences, workspace protocol, monorepo layout
- `frontend-react.md` — component structure, state management, a11y, performance
- `react-native.md` — Expo conventions, SecureStore, navigation typing
- `mcp-usage.md` — MCP tool preferences and AI Office slash command reference

Addons are activated by adding `@.ai-office/addons/<name>.md` to `.claude/CLAUDE.md`.

### Changed

- `review.md` — **Technical sector**: added TypeScript-specific checks (`any`, unsafe `as` casts, non-null assertions `!`, `@ts-ignore`), SOLID principle checks (S/O/L/I/D each with concrete detection heuristics); **Security sector**: added systematic secret pattern scan (grep for passwords, API keys, tokens, private keys, AWS IDs) with allowlist
- `scaffold.md` — `status` template now includes a `## Loop Guards` table with `qa_iteration`, `review_iteration`, `uat_iteration` counters initialized to 0
- `advance.md` — step 4 now explicitly reads the `## Loop Guards` table, increments the applicable counter, writes it back to the status file, and blocks with `blocked_reason` when the limit is reached (previously the guard logic was described but not given a concrete read/write procedure)
- `doctor.md` — expected command count updated from 18 to 21; output format example updated to reflect v1.2.0
- `install.sh` — copies `skeleton/.claude/CLAUDE.md` to `.claude/CLAUDE.md` (skip if already exists); copies `skeleton/.ai-office/addons/` to `.ai-office/addons/` (skip if already exists)

---

## 1.1.0 — 2026-03-18

### Added
- `setup.sh` — interactive project setup wizard (agency selection, tech stack, thresholds)
- `/office:setup` command — in-editor reconfiguration wizard
- `agencies/` bundle — 5 agency templates ship with the framework (software-studio, lean-startup, game-studio, creative-agency, penetration-test-agency)
- `project.config.md` format — per-project config read by `validate` and `review` commands
- `commands/office/setup.md` — new `/office:setup` slash command

### Changed
- `validate.md` — reads `typecheck_cmd`, `lint_cmd`, `test_cmd`, `coverage_min`, `lighthouse_min` from `project.config.md`; falls back to npm defaults
- `review.md` — reads `design_system` and `ui_framework` for a project-specific UX sector check
- `doctor.md` — added project config and version stamp checks; updated expected command count to 16
- `install.sh` — now hints to run `setup.sh` when `project.config.md` is missing

---

## 1.0.0 — 2026-03-18

Initial release. 15 commands covering the full AI Office pipeline:

- `route` — request routing to pipeline stages
- `status` — get/set pipeline status for a slug
- `advance` — advance to next stage with evidence
- `validate` — quality gate checks per stage
- `scaffold` — create PRD/ADR/plan/review artifacts
- `task-create` — add tasks to the kanban board
- `task-move` — move tasks between columns
- `task-list` — view the board
- `report` — status/investor/tech-debt/audit reports
- `review` — multi-sector document/code review
- `graph` — repository dependency visualization
- `agency` — list/inspect/activate an agency mode
- `script` — run repeatable markdown runbooks
- `doctor` — framework health check
- `_meta` — show installed version and check for updates

## 1.16.0 — 2026-03-30

### Added

**Structured decision choices:**
- New `interactive_choices_mode` project setting with `text` and `buttons-when-available`
- Adapter instructions now tell hosts to prefer structured quick-choice inputs for plan confirmation, approach selection, and cleanup follow-up when the host supports them
- Codex instructions now explicitly prefer `request_user_input` when it is available and fall back to concise text choices otherwise

### Changed

- `office-route`, `office-verify`, the core guide, and README now document the structured-choice behavior and text fallback
- Package versions bumped to `1.16.0` across the framework, website, and slides packages

## 1.15.0 — 2026-03-25

### Added

**Task-end cleanup guidance:**
- Completed tasks now require a short `Cleanup proposal` section with up to three optional, non-blocking cleanup ideas or an explicit `none`
- `office-verify` now includes the cleanup proposal in the successful task-closing path

### Changed

- Package versions bumped to `1.15.0` across the framework, website, and slides packages
- README and core guidance now document the cleanup proposal expectation

## 1.14.0 — 2026-03-25

### Added

**Task closure git workflow:**
- Adapter instructions now require focused end-of-task commits that include only task-related files
- End-of-task guidance now explicitly prefers `task integrate` for the final squash merge when task isolation is enabled
- `office-verify` now recommends commit → review → squash integrate as the default happy path after successful verification

### Changed

- Package versions bumped to `1.14.0` across the framework, website, and slides packages
- README now documents the focused-commit and squash-integration closure flow

## 1.13.0 — 2026-03-25

### Added

**Collaborative planning controls:**
- New `pre_implementation_mode` project setting with `minimal`, `confirm`, and `collaborative` modes
- Adapter instructions and `office-route` now honor the configured pre-implementation behavior before coding starts

**Task completion verification:**
- New optional project config keys `completion_check_cmd_1`, `completion_check_cmd_2`, and `completion_check_cmd_3`
- `setup.sh` now asks for end-of-task verification commands during initialization or reconfiguration
- `validate <slug> qa` now runs configured completion checks in order and still reports coverage when detected in their output
- `office-verify` guidance now treats those commands as the preferred automated verification flow

### Changed

- Package versions bumped to `1.13.0` across the framework, website, and slides packages
- README now documents the new planning and completion-verification project settings

## 1.12.0 — 2026-03-24

### Added

**Runtime adapter engine:**
- New shared adapter renderer in `src/adapter-renderer.ts`
- New Bun runtime entrypoint in `src/adapter-runtime.ts` for install/update/setup metadata and adapter rendering

### Changed

**Single-source adapter generation:**
- `install.sh`, `update.sh`, and `setup.sh` now load adapter metadata from the Bun runtime instead of sourcing a committed generated shell file
- The selected adapter is now rendered on demand during install/update instead of being copied from versioned wrapper bundles
- `bun run build:adapters` remains available for framework maintainers to regenerate preview outputs from the neutral manifest and shared templates
- README and package metadata now reflect the Bun-powered runtime adapter model

### Fixed

- Removed the versioned generated adapter wrapper trees and derived shell metadata from the normal repo state to reduce drift
- Added a duplicate-file hygiene test so exact tracked duplicates fail fast

## 1.11.0 — 2026-03-23

### Added

**OpenCode adapter:**
- New first-party `opencode` adapter with `opencode.json` plus `.opencode/commands/`
- Generated OpenCode command wrappers for the full AI Office command surface

### Changed

**Neutral adapter generation:**
- `src/build-adapters.ts` now renders OpenCode command markdown from the same neutral manifest and shared templates used by the other adapters
- `office-meta` now uses generic wrapper metadata tokens instead of skill-specific wording so it can render cleanly across Codex, Claude Code, and OpenCode
- `install.sh`, `update.sh`, `setup.sh`, and `ai-office doctor` now recognize and manage `opencode`
- README now documents the OpenCode adapter and the correct addon target for config-based adapters

---

## 1.10.0 — 2026-03-23

### Added

**Update cleanup support:**
- `update.sh --prune-legacy` can now remove stale AI Office artifacts from previous adapters while preserving the active adapter
- Legacy cleanup is conservative: it prunes AI Office-managed wrapper files and version stamps without deleting unrelated editor settings or custom files

### Changed

- README now documents the new `--prune-legacy` update flow for adapter migrations and repo cleanup

---

## 1.9.1 — 2026-03-23

### Changed

**Adapter deduplication:**
- Long-form Codex and Claude Code wrappers now render from shared neutral templates in `skeleton/core/templates/skills/`
- `src/build-adapters.ts` now rebuilds the full Codex and Claude Code skill sets from neutral sources instead of mixing generated and duplicated hand-maintained files
- Template-driven wrappers now stamp the current framework version and adapter-specific skill root consistently
- `install.sh` and `update.sh` now consume generated adapter metadata from the neutral manifest instead of maintaining duplicate adapter path tables

### Fixed

- Removed the accidental `autoepoque` agency from the shipped core agency set
- README and setup/build tests now reflect the actual bundled agencies and generated wrapper model

---

## 1.9.0 — 2026-03-23

### Added

**Neutral adapter build system:**
- New shared adapter manifest in `src/adapter-manifest.ts`
- New adapter renderer CLI in `src/build-adapters.ts`
- New shared instruction template at `skeleton/core/templates/adapter-instructions.md.tmpl`
- New `bun run build:adapters` script to regenerate host-specific wrapper files

### Changed

**Generated wrapper layer:**
- The core operational wrapper set is now generated from the neutral manifest: `office`, `office-route`, `office-advance`, `office-doctor`, `office-milestone`, `office-setup`, `office-status`, `office-task-create`, `office-task-integrate`, `office-task-move`, `office-task-update`, and `office-validate`
- Codex core skills, Claude Code core skills, Windsurf core workflows, and adapter instruction files now share that generated source of truth
- Windsurf rule and workflow scaffolding now fits the same modular generation model
- Package versions bumped to `1.9.0` across the framework, website, and slides packages

## 1.8.0 — 2026-03-23

### Added

**Windsurf adapter:**
- New first-party `windsurf` adapter under `skeleton/adapters/windsurf/`
- `AGENTS.md` wrapper tailored for Windsurf
- Workspace rule at `.windsurf/rules/ai-office-workspace.md`
- Reusable Windsurf workflows under `.windsurf/workflows/` for routing, doctor, setup, status, task, milestone, validation, and stage-advance operations

### Changed

**Installer, updater, and doctor:**
- `install.sh` now supports `--adapter=windsurf`
- `update.sh` now detects and updates Windsurf installs using `.windsurf/.version` or the neutral install metadata
- `ai-office doctor` now recognizes the Windsurf adapter and validates `.windsurf/rules/` plus `.windsurf/workflows/`
- CLI validation scans now ignore `.windsurf/` like the other adapter-specific directories

---

## 1.7.0 — 2026-03-23

### Added

**Host-neutral architecture:**
- New `skeleton/core/` layout for the framework engine, templates, agencies, and the canonical `AI-OFFICE.md` guide
- New `skeleton/adapters/` layout with first-party `codex`, `claude-code`, and `base` adapters
- Neutral install metadata at `.ai-office/install.json` with `schemaVersion`, `version`, `adapter`, and `installedAt`

### Changed

**Install and update flow:**
- `install.sh` now supports `--adapter=codex|claude-code|base` and always installs the core guide plus the selected adapter wrapper
- `update.sh` now detects the active adapter from neutral metadata or legacy version stamps and preserves that adapter by default
- `setup.sh` and `create-agency.sh` now resolve agencies from the host-neutral core layout instead of a host-specific skeleton path

**CLI and docs:**
- `ai-office doctor` now detects the installed adapter and validates the appropriate wrapper files for that environment
- README now documents the `core + adapters` model and adapter-aware install/update commands

### Fixed

- Legacy Claude Code installs now update into the neutral metadata model without being migrated to Codex

---

## 1.6.0 — 2026-03-23

### Added

**Task isolation and integration:**
- New project config keys for Git task workflow: `task_isolation_mode`, `task_base_branch`, `task_merge_target`, `task_worktree_root`
- `task move <id> WIP` can now create a dedicated task branch and, in `worktree` mode, a linked worktree for isolated implementation
- New `task integrate <id> [reason]` command for squash-merging a reviewed task branch into the configured integration branch
- Task files now track `**Worktree:**` alongside `**Branch:**`

**Skills and docs:**
- New `office-task-integrate` skill for Codex and Claude installs
- `office-task-move` skill fallback updated to respect configured branch/worktree isolation
- Branch workflow docs updated to describe opt-in task isolation and explicit integration into the configured UAT branch

### Fixed

- Package versions are now aligned with the framework release version
- Skill annotations and doctor output now report the correct release version and skill count

---

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
- Labels visible in `$office-task-list` output

**Reporting:**
- Velocity reporting added to `$office-report velocity` — throughput metrics per milestone

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

- `$office-verify` now recommends REVIEW (not DONE) as the next state
- `$office-validate` sprint duration set to a concrete 14 days
- `$office-advance` improved error handling
- Task matching now uses Slug field with filename fallback

---

## 1.3.0 — 2026-03-18

### Added

**Labels support:**
- `$office-task-create` — new `labels:tag1,tag2` argument; `**Labels:**` field added to task file template
- `$office-task-update` — new command to update task metadata (labels, priority, assignee, estimate, deps) without moving the task

**Task history:**
- Task files now include a `## History` section; `$office-task-create` writes the initial `Created in <column>` entry
- `$office-task-move` appends a timestamped `<OLD> → <NEW>` entry to `## History` on every move
- `$office-task-update` appends a `Updated — <changed fields>` entry to `## History`
- `$office-verify` appends verdict and outcome to `## History`

**Discussion phase (GSD-inspired):**
- `$office-route` now runs a two-phase flow: (1) classify the request, (2) ask 4–6 tailored questions before routing and write `.ai-office/docs/context/<slug>.md` with constraints, patterns, and ruled-out approaches; Quick fix requests skip the discussion phase

**Active QA verification:**
- `$office-verify <task-id>` — new command that actively verifies acceptance criteria using auto (tests, typecheck, lint, grep), inspect (code reading), and manual methods; diagnoses root causes of failures; renders an APPROVED or RETURNED verdict; updates the task's `## History`

**Custom agency profiling:**
- `$office-setup` — step 2 replaced: instead of picking from a premade list, Claude interviews you (domain, team, quality concerns, cadence) and generates a custom `.ai-office/agencies/<slug>/config.md` with tailored agent roster, per-agent focus, and handoff rules
- `$office-route` — new pre-check warns if no agency is configured and blocks routing until `$office-setup` is run
- `$office-agency` — simplified to three subcommands: `list` (active roster), `get <name>` (raw config), `profile` (re-run interview independently)

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

**`$office-milestone create` — task generation:**
- New optional argument `tasks:yes|no|ask` (default: `ask`)
- After creating the milestone file, the system reasons about the milestone name plus any related PRD/ADR context to suggest 4–12 tasks covering the full pipeline (backend, API, UI, tests, security, docs)
- Each suggestion includes title, assignee (agent-mapped by task type), priority, and estimate
- In `ask` mode with `advance_mode: manual`: presents a table and asks `all | select <numbers> | edit | none`
- In `ask` mode with `advance_mode: auto`, or with `tasks:yes`: creates all tasks immediately
- The milestone file's `## Definition of Done` is auto-populated from the suggested task titles
- Task numbers are auto-assigned sequentially within the milestone

**New commands (3):**
- `$office-run-tests <slug>` — runs `test_cmd` from `project.config.md`, parses runner output (vitest, jest, pytest, go test), appends `## Test Results` with per-suite breakdown and coverage % to `<slug>-status.md`; warns if coverage is below `coverage_min`
- `$office-validate-secrets [path]` — scans the codebase for hardcoded secrets using pattern matching (passwords, API keys, tokens, private keys, AWS IDs, GitHub tokens); allowlists env-var placeholders and test fixtures; shows redacted snippets and remediation advice
- `$office-role <agent-name>` — displays an agent's `personality.md` enriched with stage-specific focus guidance; warns if viewing a non-active agent's role for the current pipeline state

**Base rules (`AGENTS.md`):**
- `skeleton/AGENTS.md` — always-on quality rules installed at `AGENTS.md` in every project; ported and adapted from Windsurf `base-*` + `global.md` + `task-management.md` rule files; covers reasoning & scope control, code quality, TypeScript strict rules, security, git conventions, AI Office workflow, task state transitions, and loop guards

**Opt-in addons (`skeleton/.ai-office/addons/`):**
- `typescript-naming.md` — file naming, identifier casing, boolean/async function prefixes
- `supabase.md` — RLS policies, migrations, Edge Functions, pgTAP patterns
- `bun-monorepo.md` — Bun runtime preferences, workspace protocol, monorepo layout
- `frontend-react.md` — component structure, state management, a11y, performance
- `react-native.md` — Expo conventions, SecureStore, navigation typing
- `mcp-usage.md` — MCP tool preferences and AI Office slash command reference

Addons are activated by copying the contents of `.ai-office/addons/<name>.md` into `AGENTS.md`.

### Changed

- `review.md` — **Technical sector**: added TypeScript-specific checks (`any`, unsafe `as` casts, non-null assertions `!`, `@ts-ignore`), SOLID principle checks (S/O/L/I/D each with concrete detection heuristics); **Security sector**: added systematic secret pattern scan (grep for passwords, API keys, tokens, private keys, AWS IDs) with allowlist
- `scaffold.md` — `status` template now includes a `## Loop Guards` table with `qa_iteration`, `review_iteration`, `uat_iteration` counters initialized to 0
- `advance.md` — step 4 now explicitly reads the `## Loop Guards` table, increments the applicable counter, writes it back to the status file, and blocks with `blocked_reason` when the limit is reached (previously the guard logic was described but not given a concrete read/write procedure)
- `doctor.md` — expected command count updated from 18 to 21; output format example updated to reflect v1.2.0
- `install.sh` — copies `skeleton/AGENTS.md` to `AGENTS.md` (skip if already exists); copies `skeleton/.ai-office/addons/` to `.ai-office/addons/` (skip if already exists)

---

## 1.1.0 — 2026-03-18

### Added
- `setup.sh` — interactive project setup wizard (agency selection, tech stack, thresholds)
- `$office-setup` command — in-editor reconfiguration wizard
- `agencies/` bundle — 5 agency templates ship with the framework (software-studio, lean-startup, game-studio, creative-agency, penetration-test-agency)
- `project.config.md` format — per-project config read by `validate` and `review` commands
- `skills/office-setup/SKILL.md` — new `$office-setup` skill

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

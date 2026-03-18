# Changelog

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

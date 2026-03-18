#!/usr/bin/env bash
# AI Office Framework — Setup Wizard
# Configures a project with agency selection and tech stack settings.
# Usage: ./setup.sh [project-root]
#
# Flags:
#   --agency <name>       Skip agency prompt
#   --name <name>         Skip project name prompt
#   --stack <preset>      Apply a stack preset (node-react|python-fastapi|go|mobile-rn)
#   --non-interactive     Use all defaults, no prompts (requires --agency and --name)
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-.}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
AI_OFFICE="$PROJECT_ROOT/.ai-office"
CONFIG_FILE="$AI_OFFICE/project.config.md"
AGENCY_JSON="$AI_OFFICE/agency.json"

# Parse flags
AGENCY_ARG=""
NAME_ARG=""
STACK_ARG=""
NON_INTERACTIVE=false
for arg in "$@"; do
  case "$arg" in
    --agency=*) AGENCY_ARG="${arg#*=}" ;;
    --name=*)   NAME_ARG="${arg#*=}" ;;
    --stack=*)  STACK_ARG="${arg#*=}" ;;
    --non-interactive) NON_INTERACTIVE=true ;;
  esac
done

echo "AI Office — Project Setup"
echo "Project root: $PROJECT_ROOT"
echo ""

# ── Guard: don't overwrite existing config ────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  echo "⚠️  project.config.md already exists."
  echo "   To reconfigure, use /office:setup inside Claude Code."
  echo "   Or delete $CONFIG_FILE and re-run this script."
  exit 0
fi

# ── Ensure .ai-office/ structure exists ──────────────────────────────────────
if [[ ! -d "$AI_OFFICE" ]]; then
  echo "⚠️  .ai-office/ not found. Run install.sh first."
  exit 1
fi

# ── Copy bundled agency templates ────────────────────────────────────────────
echo "→ Installing agency templates..."
for agency_dir in "$FRAMEWORK_DIR/agencies"/*/; do
  agency_name="$(basename "$agency_dir")"
  target="$AI_OFFICE/agencies/$agency_name"
  if [[ ! -d "$target" ]]; then
    mkdir -p "$target"
    cp "$agency_dir"*.md "$target/"
    echo "  ✅ $agency_name"
  else
    echo "  ↩️  $agency_name (already present, skipped)"
  fi
done
echo ""

# ── Agency selection ──────────────────────────────────────────────────────────
AGENCIES=("software-studio" "lean-startup" "game-studio" "creative-agency" "penetration-test-agency")
AGENCY_DESCS=(
  "Full-stack web/mobile — complete SDLC with all quality gates"
  "Rapid MVP — minimal process, maximum speed"
  "Game development — interactive experiences and games"
  "Media & content — creative production pipeline"
  "Security testing — pentests, audits, remediation"
)

if [[ -n "$AGENCY_ARG" ]]; then
  SELECTED_AGENCY="$AGENCY_ARG"
elif [[ "$NON_INTERACTIVE" == true ]]; then
  SELECTED_AGENCY="software-studio"
else
  echo "Select agency type:"
  for i in "${!AGENCIES[@]}"; do
    echo "  $((i+1))) ${AGENCIES[$i]} — ${AGENCY_DESCS[$i]}"
  done
  read -p "Agency [1]: " agency_choice
  agency_choice="${agency_choice:-1}"
  SELECTED_AGENCY="${AGENCIES[$((agency_choice-1))]}"
fi
echo "  → Agency: $SELECTED_AGENCY"
echo ""

# ── Stack presets ─────────────────────────────────────────────────────────────
apply_preset() {
  case "$1" in
    node-react)
      TYPECHECK_CMD="npm run typecheck"
      LINT_CMD="npm run lint"
      TEST_CMD="npm run test"
      TEST_RUNNER="vitest"
      DESIGN_SYSTEM="shadcn/ui"
      UI_FRAMEWORK="react"
      ;;
    python-fastapi)
      TYPECHECK_CMD="mypy src"
      LINT_CMD="ruff check ."
      TEST_CMD="pytest"
      TEST_RUNNER="pytest"
      DESIGN_SYSTEM=""
      UI_FRAMEWORK=""
      ;;
    go)
      TYPECHECK_CMD="go vet ./..."
      LINT_CMD="golangci-lint run"
      TEST_CMD="go test ./..."
      TEST_RUNNER="go test"
      DESIGN_SYSTEM=""
      UI_FRAMEWORK=""
      ;;
    mobile-rn)
      TYPECHECK_CMD="npx tsc --noEmit"
      LINT_CMD="npx eslint ."
      TEST_CMD="npx jest"
      TEST_RUNNER="jest"
      DESIGN_SYSTEM="react-native-paper"
      UI_FRAMEWORK="react-native"
      ;;
  esac
}

# Defaults
TYPECHECK_CMD="npm run typecheck"
LINT_CMD="npm run lint"
TEST_CMD="npm run test"
TEST_RUNNER="vitest"
DESIGN_SYSTEM="shadcn/ui"
UI_FRAMEWORK="react"
COVERAGE_MIN="80"
LIGHTHOUSE_MIN="90"

if [[ -n "$STACK_ARG" ]]; then
  apply_preset "$STACK_ARG"
fi

# ── Interactive prompts ───────────────────────────────────────────────────────
prompt_with_default() {
  local prompt="$1" default="$2" varname="$3"
  if [[ "$NON_INTERACTIVE" == true ]]; then
    eval "$varname=\"\$default\""
    return
  fi
  read -p "$prompt [$default]: " val
  eval "$varname=\"\${val:-$default}\""
}

if [[ -n "$NAME_ARG" ]]; then
  PROJECT_NAME="$NAME_ARG"
else
  read -p "Project name: " PROJECT_NAME
  PROJECT_NAME="${PROJECT_NAME:-my-project}"
fi
echo ""

echo "Tech stack (press Enter to accept defaults):"
prompt_with_default "  Typecheck command" "$TYPECHECK_CMD" TYPECHECK_CMD
prompt_with_default "  Lint command      " "$LINT_CMD"      LINT_CMD
prompt_with_default "  Test command      " "$TEST_CMD"      TEST_CMD
prompt_with_default "  Test runner       " "$TEST_RUNNER"   TEST_RUNNER
echo ""

echo "Design system:"
prompt_with_default "  UI framework  " "$UI_FRAMEWORK"  UI_FRAMEWORK
prompt_with_default "  Design system " "$DESIGN_SYSTEM" DESIGN_SYSTEM
echo ""

echo "Quality thresholds:"
prompt_with_default "  Min coverage (%)      " "$COVERAGE_MIN"   COVERAGE_MIN
prompt_with_default "  Min Lighthouse score  " "$LIGHTHOUSE_MIN" LIGHTHOUSE_MIN
echo ""

TODAY="$(date +%Y-%m-%d)"

# ── Write project.config.md ───────────────────────────────────────────────────
cat > "$CONFIG_FILE" <<EOF
---
agency: $SELECTED_AGENCY
project_name: $PROJECT_NAME

# Tech stack — used by /office:validate (dev stage)
typecheck_cmd: "$TYPECHECK_CMD"
lint_cmd: "$LINT_CMD"
test_cmd: "$TEST_CMD"
test_runner: $TEST_RUNNER

# Design system — used by /office:review (UX sector)
ui_framework: $UI_FRAMEWORK
design_system: "$DESIGN_SYSTEM"

# Quality thresholds — override agency defaults
coverage_min: $COVERAGE_MIN
lighthouse_min: $LIGHTHOUSE_MIN

# Optional: skip pipeline stages for this project
# skip_stages: []
---

# Project Configuration

**Project:** $PROJECT_NAME
**Agency:** $SELECTED_AGENCY
**Created:** $TODAY

## Notes

> Add project-specific context here — tech decisions, constraints, key stakeholders.
EOF

echo "  ✅ Created .ai-office/project.config.md"

# ── Write agency.json ─────────────────────────────────────────────────────────
cat > "$AGENCY_JSON" <<EOF
{
  "name": "$SELECTED_AGENCY",
  "selectedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "custom": false
}
EOF
echo "  ✅ Updated .ai-office/agency.json"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Project configured: $PROJECT_NAME ($SELECTED_AGENCY)"
echo ""
echo "Next steps:"
echo "  /office:doctor       — verify framework health"
echo "  /office:route <task> — start your first request"

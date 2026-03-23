#!/usr/bin/env bash
# AI Office Framework — Setup Wizard
# Configures a project with agency selection and tech stack settings.
# Usage: ./setup.sh [project-root] [flags]
#
# Flags:
#   --agency=<name>         Skip agency prompt
#   --name=<name>           Skip project name prompt
#   --stack=<preset>        Apply a stack preset (node-react|python-fastapi|go|mobile-rn)
#   --advance-mode=<mode>   Pipeline advance mode: manual | auto (default: manual)
#   --task-isolation-mode=<mode>  Task git isolation: none | branch | worktree
#   --task-base-branch=<name>     Base branch for new task branches (default: dev)
#   --task-merge-target=<name>    Integration branch for task squash merges (default: dev)
#   --task-worktree-root=<path>   Root folder for task worktrees (default: .ai-office/worktrees)
#   --non-interactive       Use all defaults or existing values, no prompts
#   --reconfigure           Overwrite an existing project.config.md using current values as defaults
#   --force                 Alias for --reconfigure
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$FRAMEWORK_DIR/generated/adapter-metadata.sh"

# Parse flags
PROJECT_ROOT_ARG=""
AGENCY_ARG=""
NAME_ARG=""
STACK_ARG=""
ADVANCE_MODE_ARG=""
TASK_ISOLATION_MODE_ARG=""
TASK_BASE_BRANCH_ARG=""
TASK_MERGE_TARGET_ARG=""
TASK_WORKTREE_ROOT_ARG=""
NON_INTERACTIVE=false
RECONFIGURE=false
for arg in "$@"; do
  case "$arg" in
    --reconfigure|--force) RECONFIGURE=true ;;
    --agency=*) AGENCY_ARG="${arg#*=}" ;;
    --name=*)   NAME_ARG="${arg#*=}" ;;
    --stack=*)  STACK_ARG="${arg#*=}" ;;
    --advance-mode=*) ADVANCE_MODE_ARG="${arg#*=}" ;;
    --task-isolation-mode=*) TASK_ISOLATION_MODE_ARG="${arg#*=}" ;;
    --task-base-branch=*) TASK_BASE_BRANCH_ARG="${arg#*=}" ;;
    --task-merge-target=*) TASK_MERGE_TARGET_ARG="${arg#*=}" ;;
    --task-worktree-root=*) TASK_WORKTREE_ROOT_ARG="${arg#*=}" ;;
    --non-interactive) NON_INTERACTIVE=true ;;
    -*)
      echo "⚠️  Unknown flag: $arg"
      exit 1
      ;;
    *)
      if [[ -z "$PROJECT_ROOT_ARG" ]]; then
        PROJECT_ROOT_ARG="$arg"
      else
        echo "⚠️  Unexpected extra argument: $arg"
        exit 1
      fi
      ;;
  esac
done

PROJECT_ROOT="${PROJECT_ROOT_ARG:-.}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
AI_OFFICE="$PROJECT_ROOT/.ai-office"
CONFIG_FILE="$AI_OFFICE/project.config.md"
AGENCY_JSON="$AI_OFFICE/agency.json"

echo "AI Office — Project Setup"
echo "Project root: $PROJECT_ROOT"
echo ""

# ── Ensure .ai-office/ structure exists ──────────────────────────────────────
if [[ ! -d "$AI_OFFICE" ]]; then
  echo "⚠️  .ai-office/ not found. Run install.sh first."
  exit 1
fi

# ── Existing config helpers ───────────────────────────────────────────────────
get_config_value() {
  local key="$1"
  awk -v key="$key" '
    BEGIN { in_frontmatter = 0 }
    $0 == "---" {
      if (in_frontmatter == 0) {
        in_frontmatter = 1
        next
      }
      exit
    }
    in_frontmatter == 1 && $0 ~ ("^" key ":") {
      sub(/^[^:]+:[[:space:]]*/, "", $0)
      gsub(/^"|"$/, "", $0)
      print
      exit
    }
  ' "$CONFIG_FILE"
}

get_json_value() {
  local key="$1" file="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1
}

get_extra_frontmatter_lines() {
  awk '
    BEGIN {
      in_frontmatter = 0
    }
    $0 == "---" {
      if (in_frontmatter == 0) {
        in_frontmatter = 1
        next
      }
      exit
    }
    in_frontmatter == 1 {
      if ($0 ~ /^(agency|project_name|typecheck_cmd|lint_cmd|test_cmd|test_runner|ui_framework|design_system|coverage_min|lighthouse_min|advance_mode|task_isolation_mode|task_base_branch|task_merge_target|task_worktree_root):/) {
        next
      }
      if ($0 ~ /^[[:space:]]*[A-Za-z0-9_-]+:[[:space:]]*/) {
        print
      }
    }
  ' "$CONFIG_FILE"
}

get_notes_block() {
  awk '
    /^## Notes$/ {
      in_notes = 1
      next
    }
    in_notes == 1 {
      print
    }
  ' "$CONFIG_FILE"
}

CONFIG_EXISTS=false
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_EXISTS=true
fi

# ── Guard: don't overwrite existing config unless requested ───────────────────
if [[ "$CONFIG_EXISTS" == true && "$RECONFIGURE" == false ]]; then
  echo "⚠️  project.config.md already exists."
  echo "   To reconfigure, use the installed AI Office adapter shortcut if available."
  echo "   Or re-run this script with --reconfigure (or --force)."
  exit 0
fi

if [[ "$CONFIG_EXISTS" == true ]]; then
  echo "→ Reconfiguring existing project settings"
fi

# ── Copy bundled agency templates ────────────────────────────────────────────
echo "→ Installing agency templates..."
for agency_dir in "$FRAMEWORK_DIR/skeleton/core/.ai-office/agencies"/*/; do
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
# Dynamically discover agencies from skeleton directory
AGENCIES=()
AGENCY_DESCS=()
AGENCY_CUSTOMS=()

for agency_dir in "$FRAMEWORK_DIR/skeleton/core/.ai-office/agencies"/*/; do
  [[ -d "$agency_dir" ]] || continue
  agency_slug="$(basename "$agency_dir")"
  config_file="$agency_dir/config.md"
  [[ -f "$config_file" ]] || continue
  desc="$(awk '/^description:/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$config_file")"
  custom="$(awk '/^custom:/{sub(/^custom:[[:space:]]*/, ""); print; exit}' "$config_file")"
  AGENCIES+=("$agency_slug")
  AGENCY_DESCS+=("${desc:-$agency_slug}")
  AGENCY_CUSTOMS+=("${custom:-false}")
done

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

# Defaults / existing values
SELECTED_AGENCY_DEFAULT="software-studio"
PROJECT_NAME_DEFAULT="my-project"
TYPECHECK_CMD="npm run typecheck"
LINT_CMD="npm run lint"
TEST_CMD="npm run test"
TEST_RUNNER="vitest"
DESIGN_SYSTEM="shadcn/ui"
UI_FRAMEWORK="react"
COVERAGE_MIN="80"
LIGHTHOUSE_MIN="90"
ADVANCE_MODE="manual"
TASK_ISOLATION_MODE="none"
TASK_BASE_BRANCH="dev"
TASK_MERGE_TARGET="dev"
TASK_WORKTREE_ROOT=".ai-office/worktrees"
CREATED_DATE=""
EXTRA_FRONTMATTER_LINES=""
NOTES_BLOCK="> Add project-specific context here — tech decisions, constraints, key stakeholders."

if [[ "$CONFIG_EXISTS" == true ]]; then
  SELECTED_AGENCY_DEFAULT="$(get_config_value agency)"
  PROJECT_NAME_DEFAULT="$(get_config_value project_name)"
  TYPECHECK_CMD="$(get_config_value typecheck_cmd)"
  LINT_CMD="$(get_config_value lint_cmd)"
  TEST_CMD="$(get_config_value test_cmd)"
  TEST_RUNNER="$(get_config_value test_runner)"
  UI_FRAMEWORK="$(get_config_value ui_framework)"
  DESIGN_SYSTEM="$(get_config_value design_system)"
  COVERAGE_MIN="$(get_config_value coverage_min)"
  LIGHTHOUSE_MIN="$(get_config_value lighthouse_min)"
  ADVANCE_MODE="$(get_config_value advance_mode)"
  TASK_ISOLATION_MODE="$(get_config_value task_isolation_mode)"
  TASK_BASE_BRANCH="$(get_config_value task_base_branch)"
  TASK_MERGE_TARGET="$(get_config_value task_merge_target)"
  TASK_WORKTREE_ROOT="$(get_config_value task_worktree_root)"
  CREATED_DATE="$(sed -n 's/^\*\*Created:\*\* //p' "$CONFIG_FILE" | head -n 1)"
  EXTRA_FRONTMATTER_LINES="$(get_extra_frontmatter_lines)"
  NOTES_BLOCK="$(get_notes_block)"

  [[ -z "$SELECTED_AGENCY_DEFAULT" && -f "$AGENCY_JSON" ]] && SELECTED_AGENCY_DEFAULT="$(get_json_value name "$AGENCY_JSON")"
  [[ -z "$SELECTED_AGENCY_DEFAULT" ]] && SELECTED_AGENCY_DEFAULT="software-studio"
  [[ -z "$PROJECT_NAME_DEFAULT" ]] && PROJECT_NAME_DEFAULT="my-project"
  [[ -z "$TYPECHECK_CMD" ]] && TYPECHECK_CMD="npm run typecheck"
  [[ -z "$LINT_CMD" ]] && LINT_CMD="npm run lint"
  [[ -z "$TEST_CMD" ]] && TEST_CMD="npm run test"
  [[ -z "$TEST_RUNNER" ]] && TEST_RUNNER="vitest"
  [[ -z "$COVERAGE_MIN" ]] && COVERAGE_MIN="80"
  [[ -z "$LIGHTHOUSE_MIN" ]] && LIGHTHOUSE_MIN="90"
  [[ -z "$ADVANCE_MODE" ]] && ADVANCE_MODE="manual"
  [[ -z "$TASK_ISOLATION_MODE" ]] && TASK_ISOLATION_MODE="none"
  [[ -z "$TASK_BASE_BRANCH" ]] && TASK_BASE_BRANCH="dev"
  [[ -z "$TASK_MERGE_TARGET" ]] && TASK_MERGE_TARGET="dev"
  [[ -z "$TASK_WORKTREE_ROOT" ]] && TASK_WORKTREE_ROOT=".ai-office/worktrees"
  [[ -z "$NOTES_BLOCK" ]] && NOTES_BLOCK="> Add project-specific context here — tech decisions, constraints, key stakeholders."
fi

if [[ -n "$STACK_ARG" ]]; then
  apply_preset "$STACK_ARG"
fi

if [[ -n "$ADVANCE_MODE_ARG" ]]; then
  ADVANCE_MODE="$ADVANCE_MODE_ARG"
fi
if [[ -n "$TASK_ISOLATION_MODE_ARG" ]]; then
  TASK_ISOLATION_MODE="$TASK_ISOLATION_MODE_ARG"
fi
if [[ -n "$TASK_BASE_BRANCH_ARG" ]]; then
  TASK_BASE_BRANCH="$TASK_BASE_BRANCH_ARG"
fi
if [[ -n "$TASK_MERGE_TARGET_ARG" ]]; then
  TASK_MERGE_TARGET="$TASK_MERGE_TARGET_ARG"
fi
if [[ -n "$TASK_WORKTREE_ROOT_ARG" ]]; then
  TASK_WORKTREE_ROOT="$TASK_WORKTREE_ROOT_ARG"
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

if [[ -n "$AGENCY_ARG" ]]; then
  SELECTED_AGENCY="$AGENCY_ARG"
elif [[ "$NON_INTERACTIVE" == true ]]; then
  SELECTED_AGENCY="$SELECTED_AGENCY_DEFAULT"
else
  default_agency_choice=1
  for i in "${!AGENCIES[@]}"; do
    if [[ "${AGENCIES[$i]}" == "$SELECTED_AGENCY_DEFAULT" ]]; then
      default_agency_choice=$((i+1))
      break
    fi
  done

  echo "Select agency type:"
  for i in "${!AGENCIES[@]}"; do
    marker=""
    [[ "${AGENCY_CUSTOMS[$i]}" == "true" ]] && marker=" [custom]"
    echo "  $((i+1))) ${AGENCIES[$i]}${marker} — ${AGENCY_DESCS[$i]}"
  done
  read -p "Agency [$default_agency_choice]: " agency_choice
  agency_choice="${agency_choice:-$default_agency_choice}"
  SELECTED_AGENCY="${AGENCIES[$((agency_choice-1))]}"
fi
echo "  → Agency: $SELECTED_AGENCY"
echo ""

if [[ -n "$NAME_ARG" ]]; then
  PROJECT_NAME="$NAME_ARG"
else
  prompt_with_default "Project name" "$PROJECT_NAME_DEFAULT" PROJECT_NAME
fi
echo ""

echo "Tech stack (press Enter to accept defaults or existing values):"
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

echo "Pipeline behaviour:"
prompt_with_default "  Advance mode (manual|auto)" "$ADVANCE_MODE" ADVANCE_MODE
echo ""

echo "Git task workflow:"
prompt_with_default "  Task isolation (none|branch|worktree)" "$TASK_ISOLATION_MODE" TASK_ISOLATION_MODE
prompt_with_default "  Task base branch                 " "$TASK_BASE_BRANCH" TASK_BASE_BRANCH
prompt_with_default "  Task merge target                " "$TASK_MERGE_TARGET" TASK_MERGE_TARGET
prompt_with_default "  Task worktree root               " "$TASK_WORKTREE_ROOT" TASK_WORKTREE_ROOT
echo ""

TODAY="$(date +%Y-%m-%d)"
WRITTEN_CREATED_DATE="${CREATED_DATE:-$TODAY}"

if [[ "$CONFIG_EXISTS" == true ]]; then
  backup_suffix="$(date +%Y%m%d%H%M%S)"
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak.$backup_suffix"
  if [[ -f "$AGENCY_JSON" ]]; then
    cp "$AGENCY_JSON" "$AGENCY_JSON.bak.$backup_suffix"
  fi
  echo "  🗂️  Backed up previous config to $(basename "$CONFIG_FILE").bak.$backup_suffix"
fi

EXTRA_FRONTMATTER_BLOCK=""
if [[ -n "$EXTRA_FRONTMATTER_LINES" ]]; then
  EXTRA_FRONTMATTER_BLOCK="$(printf '%s\n' "$EXTRA_FRONTMATTER_LINES" | sed '/^[[:space:]]*$/d')"
fi

# ── Write project.config.md ───────────────────────────────────────────────────
cat > "$CONFIG_FILE" <<EOF
---
agency: $SELECTED_AGENCY
project_name: $PROJECT_NAME

# Tech stack — used by \$office-validate (dev stage)
typecheck_cmd: "$TYPECHECK_CMD"
lint_cmd: "$LINT_CMD"
test_cmd: "$TEST_CMD"
test_runner: $TEST_RUNNER

# Design system — used by \$office-review (UX sector)
ui_framework: "$UI_FRAMEWORK"
design_system: "$DESIGN_SYSTEM"

# Quality thresholds — override agency defaults
coverage_min: $COVERAGE_MIN
lighthouse_min: $LIGHTHOUSE_MIN

# Pipeline behaviour — manual | auto
advance_mode: $ADVANCE_MODE

# Git task workflow — opt-in branch/worktree isolation
task_isolation_mode: $TASK_ISOLATION_MODE
task_base_branch: "$TASK_BASE_BRANCH"
task_merge_target: "$TASK_MERGE_TARGET"
task_worktree_root: "$TASK_WORKTREE_ROOT"
$([[ -n "$EXTRA_FRONTMATTER_BLOCK" ]] && printf '\n\n%s' "$EXTRA_FRONTMATTER_BLOCK")

# Optional: skip pipeline stages for this project
# skip_stages: []
---

# Project Configuration

**Project:** $PROJECT_NAME
**Agency:** $SELECTED_AGENCY
**Created:** $WRITTEN_CREATED_DATE

## Notes

$NOTES_BLOCK
EOF

if [[ "$CONFIG_EXISTS" == true ]]; then
  echo "  ✅ Updated .ai-office/project.config.md"
else
  echo "  ✅ Created .ai-office/project.config.md"
fi

# ── Write agency.json ─────────────────────────────────────────────────────────
IS_CUSTOM=false
for i in "${!AGENCIES[@]}"; do
  if [[ "${AGENCIES[$i]}" == "$SELECTED_AGENCY" && "${AGENCY_CUSTOMS[$i]}" == "true" ]]; then
    IS_CUSTOM=true
    break
  fi
done

cat > "$AGENCY_JSON" <<EOF
{
  "name": "$SELECTED_AGENCY",
  "selectedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "custom": $IS_CUSTOM
}
EOF
echo "  ✅ Updated .ai-office/agency.json"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Project configured: $PROJECT_NAME ($SELECTED_AGENCY)"
echo ""
echo "Next steps:"
echo "  ai-office doctor       — verify framework health"
if [[ -d "$PROJECT_ROOT/$(adapter_skill_dest_rel codex)" ]]; then
  echo "  \$office-route <task>  — start from the Codex adapter"
elif [[ -d "$PROJECT_ROOT/$(adapter_skill_dest_rel claude-code)" ]]; then
  echo "  /office route <task>  — start from the Claude Code adapter"
else
  echo "  ai-office status get <slug> — inspect framework state from the CLI"
fi

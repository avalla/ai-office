#!/usr/bin/env bash
# AI Office Framework - Setup Wizard
# Configures a repo-native project office from repository analysis.
# Usage: ./setup.sh [project-root] [flags]
#
# Flags:
#   --auto                  Analyze the repo and generate a custom project office (default)
#   --agency=<name>         Use a legacy preset agency instead of custom office generation
#   --include-legacy-presets Copy all bundled legacy presets into .ai-office/agencies
#   --name=<name>           Skip project name prompt
#   --stack=<preset>        Apply a stack preset (node-react|python-fastapi|go|mobile-rn)
#   --advance-mode=<mode>   Pipeline advance mode: manual | auto (default: manual)
#   --pre-implementation-mode=<mode>  Pre-implementation collaboration: minimal | confirm | collaborative
#   --interactive-choices-mode=<mode> Structured decision input: text | buttons-when-available
#   --completion-check-cmd-1=<cmd>    Optional task completion verification command #1
#   --completion-check-cmd-2=<cmd>    Optional task completion verification command #2
#   --completion-check-cmd-3=<cmd>    Optional task completion verification command #3
#   --task-isolation-mode=<mode>  Task git isolation: none | branch | worktree
#   --task-base-branch=<name>     Base branch for new task branches (default: dev)
#   --task-merge-target=<name>    Integration branch for task squash merges (default: dev)
#   --task-worktree-root=<path>   Root folder for task worktrees (default: .ai-office/worktrees)
#   --enable-github-sync=<yes|no> Enable official AI Office <-> GitHub workflow files
#   --task-commit-traceability=<yes|no>
#   --task-commit-policy=<disabled|suggested|required-for-implementation|required-for-all>
#   --task-commit-link-mode=<manual|detect-current-branch|detect-recent-commit>
#   --github-issue-linking=<disabled|optional|enabled>
#   --github-commit-linking=<disabled|optional|enabled>
#   --commit-reference-style=<task-id|issue-number|task-and-issue|conventional>
#   --github-issue-intake=<disabled|enabled>
#   --scan-agent-instructions
#   --instruction-merge-mode=<section|sidecar|append|skip|overwrite-explicit>
#   --non-interactive       Use all defaults or existing values, no prompts
#   --reconfigure           Overwrite an existing project.config.md using current values as defaults
#   --force                 Alias for --reconfigure
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun is required to configure AI Office from source"
  exit 1
fi

eval "$(bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" emit-shell-metadata)"

# Parse flags
PROJECT_ROOT_ARG=""
AGENCY_ARG=""
INCLUDE_LEGACY_PRESETS=false
AUTO_MODE=true
NAME_ARG=""
STACK_ARG=""
ADVANCE_MODE_ARG=""
PRE_IMPLEMENTATION_MODE_ARG=""
INTERACTIVE_CHOICES_MODE_ARG=""
COMPLETION_CHECK_CMD_1_ARG=""
COMPLETION_CHECK_CMD_2_ARG=""
COMPLETION_CHECK_CMD_3_ARG=""
TASK_ISOLATION_MODE_ARG=""
TASK_BASE_BRANCH_ARG=""
TASK_MERGE_TARGET_ARG=""
TASK_WORKTREE_ROOT_ARG=""
ENABLE_GITHUB_SYNC_ARG=""
TASK_COMMIT_TRACEABILITY_ARG=""
TASK_COMMIT_POLICY_ARG=""
TASK_COMMIT_LINK_MODE_ARG=""
TASK_COMMIT_REQUIRE_VERIFICATION_ARG=""
TASK_COMMIT_ALLOW_NO_CODE_ARG=""
GITHUB_ISSUE_LINKING_ARG=""
GITHUB_COMMIT_LINKING_ARG=""
COMMIT_REFERENCE_STYLE_ARG=""
GITHUB_ISSUE_INTAKE_ARG=""
GITHUB_ISSUE_AUTO_TRIAGE_ARG=""
GITHUB_ISSUE_CREATE_TASK_ARG=""
GITHUB_ISSUE_COMMENT_UPDATES_ARG=""
GITHUB_ISSUE_CLOSE_ON_INTEGRATION_ARG=""
GITHUB_ISSUE_SECURITY_PRIVATE_MODE_ARG=""
AGENT_INSTRUCTION_DISCOVERY_ARG=""
INSTRUCTION_MERGE_MODE_ARG=""
INSTRUCTION_BACKUP_ARG=""
INSTRUCTION_CONFLICT_POLICY_ARG=""
INSTRUCTION_SIDECAR_DIR_ARG=""
NON_INTERACTIVE=false
RECONFIGURE=false
for arg in "$@"; do
  case "$arg" in
    --reconfigure|--force) RECONFIGURE=true ;;
    --auto) AUTO_MODE=true ;;
    --agency=*) AGENCY_ARG="${arg#*=}"; AUTO_MODE=false ;;
    --include-legacy-presets) INCLUDE_LEGACY_PRESETS=true ;;
    --name=*)   NAME_ARG="${arg#*=}" ;;
    --stack=*)  STACK_ARG="${arg#*=}" ;;
    --advance-mode=*) ADVANCE_MODE_ARG="${arg#*=}" ;;
    --pre-implementation-mode=*) PRE_IMPLEMENTATION_MODE_ARG="${arg#*=}" ;;
    --interactive-choices-mode=*) INTERACTIVE_CHOICES_MODE_ARG="${arg#*=}" ;;
    --completion-check-cmd-1=*) COMPLETION_CHECK_CMD_1_ARG="${arg#*=}" ;;
    --completion-check-cmd-2=*) COMPLETION_CHECK_CMD_2_ARG="${arg#*=}" ;;
    --completion-check-cmd-3=*) COMPLETION_CHECK_CMD_3_ARG="${arg#*=}" ;;
    --task-isolation-mode=*) TASK_ISOLATION_MODE_ARG="${arg#*=}" ;;
    --task-base-branch=*) TASK_BASE_BRANCH_ARG="${arg#*=}" ;;
    --task-merge-target=*) TASK_MERGE_TARGET_ARG="${arg#*=}" ;;
    --task-worktree-root=*) TASK_WORKTREE_ROOT_ARG="${arg#*=}" ;;
    --enable-github-sync=*) ENABLE_GITHUB_SYNC_ARG="${arg#*=}" ;;
    --task-commit-traceability=*) TASK_COMMIT_TRACEABILITY_ARG="${arg#*=}" ;;
    --task-commit-policy=*) TASK_COMMIT_POLICY_ARG="${arg#*=}" ;;
    --task-commit-link-mode=*) TASK_COMMIT_LINK_MODE_ARG="${arg#*=}" ;;
    --task-commit-require-verification=*) TASK_COMMIT_REQUIRE_VERIFICATION_ARG="${arg#*=}" ;;
    --task-commit-allow-no-code=*) TASK_COMMIT_ALLOW_NO_CODE_ARG="${arg#*=}" ;;
    --github-issue-linking=*) GITHUB_ISSUE_LINKING_ARG="${arg#*=}" ;;
    --github-commit-linking=*) GITHUB_COMMIT_LINKING_ARG="${arg#*=}" ;;
    --commit-reference-style=*) COMMIT_REFERENCE_STYLE_ARG="${arg#*=}" ;;
    --github-issue-intake=*) GITHUB_ISSUE_INTAKE_ARG="${arg#*=}" ;;
    --github-issue-auto-triage=*) GITHUB_ISSUE_AUTO_TRIAGE_ARG="${arg#*=}" ;;
    --github-issue-create-task=*) GITHUB_ISSUE_CREATE_TASK_ARG="${arg#*=}" ;;
    --github-issue-comment-updates=*) GITHUB_ISSUE_COMMENT_UPDATES_ARG="${arg#*=}" ;;
    --github-issue-close-on-integration=*) GITHUB_ISSUE_CLOSE_ON_INTEGRATION_ARG="${arg#*=}" ;;
    --github-issue-security-private-mode=*) GITHUB_ISSUE_SECURITY_PRIVATE_MODE_ARG="${arg#*=}" ;;
    --scan-agent-instructions) AGENT_INSTRUCTION_DISCOVERY_ARG="enabled" ;;
    --agent-instruction-discovery=*) AGENT_INSTRUCTION_DISCOVERY_ARG="${arg#*=}" ;;
    --instruction-merge-mode=*) INSTRUCTION_MERGE_MODE_ARG="${arg#*=}" ;;
    --instruction-backup=*) INSTRUCTION_BACKUP_ARG="${arg#*=}" ;;
    --instruction-conflict-policy=*) INSTRUCTION_CONFLICT_POLICY_ARG="${arg#*=}" ;;
    --instruction-sidecar-dir=*) INSTRUCTION_SIDECAR_DIR_ARG="${arg#*=}" ;;
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
      if ($0 ~ /^(office|office_mode|legacy_agency_preset|agency|project_name|typecheck_cmd|lint_cmd|test_cmd|test_runner|ui_framework|design_system|coverage_min|lighthouse_min|advance_mode|pre_implementation_mode|interactive_choices_mode|completion_check_cmd_1|completion_check_cmd_2|completion_check_cmd_3|task_isolation_mode|task_base_branch|task_merge_target|task_worktree_root|enable_github_sync|token_budget_mode|token_budget_max_context_files|token_budget_max_roles_per_task|token_budget_max_stage_artifacts|token_budget_max_review_iterations|token_budget_summarize_after_stage|agent_operating_mode|require_intent_check|require_plan_before_code|allow_tiny_fix_fast_path|max_plan_options|stop_on_product_mismatch|background_work_mode|background_max_active_tasks|background_requires_status_file|background_requires_resume_instructions|task_commit_traceability|task_commit_policy|task_commit_link_mode|task_commit_require_verification|task_commit_allow_no_code|task_commit_allow_multiple|task_commit_message_template|github_issue_linking|github_commit_linking|commit_reference_style|github_commit_closes_issue|github_issue_intake|github_issue_auto_triage|github_issue_create_task|github_issue_default_column|github_issue_default_milestone|github_issue_label_sync|github_issue_comment_updates|github_issue_close_on_integration|github_issue_security_private_mode|agent_instruction_discovery|instruction_merge_mode|instruction_backup|instruction_conflict_policy|instruction_sidecar_dir):/) {
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

# ── Legacy preset helpers ─────────────────────────────────────────────────────
copy_legacy_preset() {
  local preset_name="$1"
  local source="$FRAMEWORK_DIR/skeleton/core/.ai-office/agencies/$preset_name"
  local target="$AI_OFFICE/agencies/$preset_name"
  if [[ ! -d "$source" ]]; then
    return
  fi
  if [[ ! -d "$target" ]]; then
    mkdir -p "$target"
    cp "$source"/*.md "$target/"
    echo "  ✅ $preset_name"
  else
    echo "  ↩️  $preset_name (already present, skipped)"
  fi
}

if [[ "$INCLUDE_LEGACY_PRESETS" == true ]]; then
  echo "→ Installing optional legacy presets..."
  for preset_dir in "$FRAMEWORK_DIR/skeleton/core/.ai-office/agencies"/*/; do
    copy_legacy_preset "$(basename "$preset_dir")"
  done
  echo ""
elif [[ -n "$AGENCY_ARG" ]]; then
  echo "→ Installing requested legacy preset..."
  copy_legacy_preset "$AGENCY_ARG"
  echo ""
else
  echo "→ Keeping bundled legacy presets in framework source"
  echo "  Use --agency=<name> or --include-legacy-presets to copy presets into this project."
  echo ""
fi

# ── Legacy preset selection ───────────────────────────────────────────────────
AGENCIES=()
AGENCY_DESCS=()
AGENCY_CUSTOMS=()

for agency_dir in "$FRAMEWORK_DIR/skeleton/core/.ai-office/agencies"/*/ "$AI_OFFICE/agencies"/*/; do
  [[ -d "$agency_dir" ]] || continue
  agency_slug="$(basename "$agency_dir")"
  already_seen=false
  for existing in "${AGENCIES[@]}"; do
    if [[ "$existing" == "$agency_slug" ]]; then
      already_seen=true
      break
    fi
  done
  [[ "$already_seen" == true ]] && continue
  config_file="$agency_dir/config.md"
  [[ -f "$config_file" ]] || continue
  desc="$(awk '/^description:/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$config_file")"
  custom="$(awk '/^custom:/{sub(/^custom:[[:space:]]*/, ""); print; exit}' "$config_file")"
  AGENCIES+=("$agency_slug")
  AGENCY_DESCS+=("${desc:-$agency_slug}")
  AGENCY_CUSTOMS+=("${custom:-false}")
done

# ── Project analysis ──────────────────────────────────────────────────────────
detect_project_settings() {
  bun run "$FRAMEWORK_DIR/src/project-analyzer.ts" "$PROJECT_ROOT"
}

# ── Stack presets ─────────────────────────────────────────────────────────────
script_command_for_manager() {
  local package_manager="$1" script_name="$2"
  case "$package_manager" in
    bun) echo "bun run $script_name" ;;
    pnpm) echo "pnpm run $script_name" ;;
    yarn) echo "yarn $script_name" ;;
    npm) echo "npm run $script_name" ;;
    "") echo "" ;;
    *) echo "npm run $script_name" ;;
  esac
}

NODE_PACKAGE_MANAGER=""

echo "→ Analyzing project tech stack..."
DETECTED_PROJECT_NAME=""
DETECTED_TYPECHECK_CMD=""
DETECTED_LINT_CMD=""
DETECTED_TEST_CMD=""
DETECTED_TEST_RUNNER=""
DETECTED_UI_FRAMEWORK=""
DETECTED_DESIGN_SYSTEM=""
DETECTED_LANGUAGE=""
DETECTED_LANGUAGE_TOOLCHAIN=""
DETECTED_PROJECT_TYPE=""
DETECTED_PIPELINE=""
DETECTED_ROLES=""
DETECTED_RISK_AREAS=""
DETECTED_QUALITY_GATES=""
DETECTED_REPOSITORY_SIGNALS=""
DETECTED_SUMMARY=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    PROJECT_NAME) DETECTED_PROJECT_NAME="$value" ;;
    PACKAGE_MANAGER) NODE_PACKAGE_MANAGER="$value" ;;
    LANGUAGE) DETECTED_LANGUAGE="$value" ;;
    LANGUAGE_TOOLCHAIN) DETECTED_LANGUAGE_TOOLCHAIN="$value" ;;
    PROJECT_TYPE) DETECTED_PROJECT_TYPE="$value" ;;
    TYPECHECK_CMD) DETECTED_TYPECHECK_CMD="$value" ;;
    LINT_CMD) DETECTED_LINT_CMD="$value" ;;
    TEST_CMD) DETECTED_TEST_CMD="$value" ;;
    TEST_RUNNER) DETECTED_TEST_RUNNER="$value" ;;
    UI_FRAMEWORK) DETECTED_UI_FRAMEWORK="$value" ;;
    DESIGN_SYSTEM) DETECTED_DESIGN_SYSTEM="$value" ;;
    PIPELINE) DETECTED_PIPELINE="$value" ;;
    ROLES) DETECTED_ROLES="$value" ;;
    RISK_AREAS) DETECTED_RISK_AREAS="$value" ;;
    QUALITY_GATES) DETECTED_QUALITY_GATES="$value" ;;
    REPOSITORY_SIGNALS) DETECTED_REPOSITORY_SIGNALS="$value" ;;
    SUMMARY) DETECTED_SUMMARY="$value" ;;
  esac
done < <(detect_project_settings)

if [[ -n "$DETECTED_SUMMARY" ]]; then
  echo "  ✅ Detected: $DETECTED_SUMMARY"
else
  echo "  ↩️  No strong signals found; using generic defaults"
fi
echo ""

# ── Stack presets ─────────────────────────────────────────────────────────────
apply_preset() {
  local js_manager="${NODE_PACKAGE_MANAGER:-npm}"
  case "$1" in
    node-react)
      TYPECHECK_CMD="$(script_command_for_manager "$js_manager" typecheck)"
      LINT_CMD="$(script_command_for_manager "$js_manager" lint)"
      TEST_CMD="$(script_command_for_manager "$js_manager" test)"
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
SELECTED_AGENCY_DEFAULT="custom-office"
OFFICE_DEFAULT="custom-office"
LEGACY_AGENCY_PRESET_DEFAULT=""
OFFICE_MODE="custom"
BASE_PROJECT_NAME_DEFAULT="${DETECTED_PROJECT_NAME:-$(basename "$PROJECT_ROOT")}"
BASE_TYPECHECK_CMD="${DETECTED_TYPECHECK_CMD:-$(script_command_for_manager "$NODE_PACKAGE_MANAGER" typecheck)}"
BASE_LINT_CMD="${DETECTED_LINT_CMD:-$(script_command_for_manager "$NODE_PACKAGE_MANAGER" lint)}"
BASE_TEST_CMD="${DETECTED_TEST_CMD:-$(script_command_for_manager "$NODE_PACKAGE_MANAGER" test)}"
BASE_TEST_RUNNER="${DETECTED_TEST_RUNNER:-}"
BASE_DESIGN_SYSTEM="${DETECTED_DESIGN_SYSTEM:-}"
BASE_UI_FRAMEWORK="${DETECTED_UI_FRAMEWORK:-}"
PROJECT_NAME_DEFAULT="$BASE_PROJECT_NAME_DEFAULT"
TYPECHECK_CMD="$BASE_TYPECHECK_CMD"
LINT_CMD="$BASE_LINT_CMD"
TEST_CMD="$BASE_TEST_CMD"
TEST_RUNNER="$BASE_TEST_RUNNER"
DESIGN_SYSTEM="$BASE_DESIGN_SYSTEM"
UI_FRAMEWORK="$BASE_UI_FRAMEWORK"
COVERAGE_MIN="80"
LIGHTHOUSE_MIN="90"
ADVANCE_MODE="manual"
PRE_IMPLEMENTATION_MODE="minimal"
INTERACTIVE_CHOICES_MODE="text"
COMPLETION_CHECK_CMD_1=""
COMPLETION_CHECK_CMD_2=""
COMPLETION_CHECK_CMD_3=""
TASK_ISOLATION_MODE="none"
TASK_BASE_BRANCH="dev"
TASK_MERGE_TARGET="dev"
TASK_WORKTREE_ROOT=".ai-office/worktrees"
ENABLE_GITHUB_SYNC="no"
TOKEN_BUDGET_MODE="conservative"
TOKEN_BUDGET_MAX_CONTEXT_FILES="8"
TOKEN_BUDGET_MAX_ROLES_PER_TASK="2"
TOKEN_BUDGET_MAX_STAGE_ARTIFACTS="3"
TOKEN_BUDGET_MAX_REVIEW_ITERATIONS="2"
TOKEN_BUDGET_SUMMARIZE_AFTER_STAGE="true"
AGENT_OPERATING_MODE="review-first"
REQUIRE_INTENT_CHECK="true"
REQUIRE_PLAN_BEFORE_CODE="true"
ALLOW_TINY_FIX_FAST_PATH="true"
MAX_PLAN_OPTIONS="3"
STOP_ON_PRODUCT_MISMATCH="true"
BACKGROUND_WORK_MODE="simulated"
BACKGROUND_MAX_ACTIVE_TASKS="3"
BACKGROUND_REQUIRES_STATUS_FILE="true"
BACKGROUND_REQUIRES_RESUME_INSTRUCTIONS="true"
TASK_COMMIT_TRACEABILITY="yes"
TASK_COMMIT_POLICY="required-for-implementation"
TASK_COMMIT_LINK_MODE="detect-current-branch"
TASK_COMMIT_REQUIRE_VERIFICATION="yes"
TASK_COMMIT_ALLOW_NO_CODE="yes"
TASK_COMMIT_ALLOW_MULTIPLE="yes"
TASK_COMMIT_MESSAGE_TEMPLATE="{task_id}: {task_title}"
GITHUB_ISSUE_LINKING="optional"
GITHUB_COMMIT_LINKING="optional"
COMMIT_REFERENCE_STYLE="task-and-issue"
GITHUB_COMMIT_CLOSES_ISSUE="false"
GITHUB_ISSUE_INTAKE="enabled"
GITHUB_ISSUE_AUTO_TRIAGE="suggested"
GITHUB_ISSUE_CREATE_TASK="ask"
GITHUB_ISSUE_DEFAULT_COLUMN="BACKLOG"
GITHUB_ISSUE_DEFAULT_MILESTONE="M0"
GITHUB_ISSUE_LABEL_SYNC="yes"
GITHUB_ISSUE_COMMENT_UPDATES="ask"
GITHUB_ISSUE_CLOSE_ON_INTEGRATION="no"
GITHUB_ISSUE_SECURITY_PRIVATE_MODE="true"
AGENT_INSTRUCTION_DISCOVERY="enabled"
INSTRUCTION_MERGE_MODE="section"
INSTRUCTION_BACKUP="yes"
INSTRUCTION_CONFLICT_POLICY="keep-existing"
INSTRUCTION_SIDECAR_DIR=".ai-office/instructions"
CREATED_DATE=""
EXTRA_FRONTMATTER_LINES=""
NOTES_BLOCK="> Add project-specific context here — tech decisions, constraints, key stakeholders."

if [[ "$CONFIG_EXISTS" == true ]]; then
  OFFICE_DEFAULT="$(get_config_value office)"
  LEGACY_AGENCY_PRESET_DEFAULT="$(get_config_value legacy_agency_preset)"
  SELECTED_AGENCY_DEFAULT="$(get_config_value agency)"
  OFFICE_MODE="$(get_config_value office_mode)"
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
  PRE_IMPLEMENTATION_MODE="$(get_config_value pre_implementation_mode)"
  INTERACTIVE_CHOICES_MODE="$(get_config_value interactive_choices_mode)"
  COMPLETION_CHECK_CMD_1="$(get_config_value completion_check_cmd_1)"
  COMPLETION_CHECK_CMD_2="$(get_config_value completion_check_cmd_2)"
  COMPLETION_CHECK_CMD_3="$(get_config_value completion_check_cmd_3)"
  TASK_ISOLATION_MODE="$(get_config_value task_isolation_mode)"
  TASK_BASE_BRANCH="$(get_config_value task_base_branch)"
  TASK_MERGE_TARGET="$(get_config_value task_merge_target)"
  TASK_WORKTREE_ROOT="$(get_config_value task_worktree_root)"
  ENABLE_GITHUB_SYNC="$(get_config_value enable_github_sync)"
  TOKEN_BUDGET_MODE="$(get_config_value token_budget_mode)"
  TOKEN_BUDGET_MAX_CONTEXT_FILES="$(get_config_value token_budget_max_context_files)"
  TOKEN_BUDGET_MAX_ROLES_PER_TASK="$(get_config_value token_budget_max_roles_per_task)"
  TOKEN_BUDGET_MAX_STAGE_ARTIFACTS="$(get_config_value token_budget_max_stage_artifacts)"
  TOKEN_BUDGET_MAX_REVIEW_ITERATIONS="$(get_config_value token_budget_max_review_iterations)"
  TOKEN_BUDGET_SUMMARIZE_AFTER_STAGE="$(get_config_value token_budget_summarize_after_stage)"
  AGENT_OPERATING_MODE="$(get_config_value agent_operating_mode)"
  REQUIRE_INTENT_CHECK="$(get_config_value require_intent_check)"
  REQUIRE_PLAN_BEFORE_CODE="$(get_config_value require_plan_before_code)"
  ALLOW_TINY_FIX_FAST_PATH="$(get_config_value allow_tiny_fix_fast_path)"
  MAX_PLAN_OPTIONS="$(get_config_value max_plan_options)"
  STOP_ON_PRODUCT_MISMATCH="$(get_config_value stop_on_product_mismatch)"
  BACKGROUND_WORK_MODE="$(get_config_value background_work_mode)"
  BACKGROUND_MAX_ACTIVE_TASKS="$(get_config_value background_max_active_tasks)"
  BACKGROUND_REQUIRES_STATUS_FILE="$(get_config_value background_requires_status_file)"
  BACKGROUND_REQUIRES_RESUME_INSTRUCTIONS="$(get_config_value background_requires_resume_instructions)"
  TASK_COMMIT_TRACEABILITY="$(get_config_value task_commit_traceability)"
  TASK_COMMIT_POLICY="$(get_config_value task_commit_policy)"
  TASK_COMMIT_LINK_MODE="$(get_config_value task_commit_link_mode)"
  TASK_COMMIT_REQUIRE_VERIFICATION="$(get_config_value task_commit_require_verification)"
  TASK_COMMIT_ALLOW_NO_CODE="$(get_config_value task_commit_allow_no_code)"
  TASK_COMMIT_ALLOW_MULTIPLE="$(get_config_value task_commit_allow_multiple)"
  TASK_COMMIT_MESSAGE_TEMPLATE="$(get_config_value task_commit_message_template)"
  GITHUB_ISSUE_LINKING="$(get_config_value github_issue_linking)"
  GITHUB_COMMIT_LINKING="$(get_config_value github_commit_linking)"
  COMMIT_REFERENCE_STYLE="$(get_config_value commit_reference_style)"
  GITHUB_COMMIT_CLOSES_ISSUE="$(get_config_value github_commit_closes_issue)"
  GITHUB_ISSUE_INTAKE="$(get_config_value github_issue_intake)"
  GITHUB_ISSUE_AUTO_TRIAGE="$(get_config_value github_issue_auto_triage)"
  GITHUB_ISSUE_CREATE_TASK="$(get_config_value github_issue_create_task)"
  GITHUB_ISSUE_DEFAULT_COLUMN="$(get_config_value github_issue_default_column)"
  GITHUB_ISSUE_DEFAULT_MILESTONE="$(get_config_value github_issue_default_milestone)"
  GITHUB_ISSUE_LABEL_SYNC="$(get_config_value github_issue_label_sync)"
  GITHUB_ISSUE_COMMENT_UPDATES="$(get_config_value github_issue_comment_updates)"
  GITHUB_ISSUE_CLOSE_ON_INTEGRATION="$(get_config_value github_issue_close_on_integration)"
  GITHUB_ISSUE_SECURITY_PRIVATE_MODE="$(get_config_value github_issue_security_private_mode)"
  AGENT_INSTRUCTION_DISCOVERY="$(get_config_value agent_instruction_discovery)"
  INSTRUCTION_MERGE_MODE="$(get_config_value instruction_merge_mode)"
  INSTRUCTION_BACKUP="$(get_config_value instruction_backup)"
  INSTRUCTION_CONFLICT_POLICY="$(get_config_value instruction_conflict_policy)"
  INSTRUCTION_SIDECAR_DIR="$(get_config_value instruction_sidecar_dir)"
  CREATED_DATE="$(sed -n 's/^\*\*Created:\*\* //p' "$CONFIG_FILE" | head -n 1)"
  EXTRA_FRONTMATTER_LINES="$(get_extra_frontmatter_lines)"
  NOTES_BLOCK="$(get_notes_block)"

  if [[ "$RECONFIGURE" == true ]]; then
    [[ -n "$DETECTED_PROJECT_NAME" ]] && PROJECT_NAME_DEFAULT="$DETECTED_PROJECT_NAME"
    [[ -n "$DETECTED_TYPECHECK_CMD" ]] && TYPECHECK_CMD="$DETECTED_TYPECHECK_CMD"
    [[ -n "$DETECTED_LINT_CMD" ]] && LINT_CMD="$DETECTED_LINT_CMD"
    [[ -n "$DETECTED_TEST_CMD" ]] && TEST_CMD="$DETECTED_TEST_CMD"
    [[ -n "$DETECTED_TEST_RUNNER" ]] && TEST_RUNNER="$DETECTED_TEST_RUNNER"
    [[ -n "$DETECTED_UI_FRAMEWORK" ]] && UI_FRAMEWORK="$DETECTED_UI_FRAMEWORK"
    [[ -n "$DETECTED_DESIGN_SYSTEM" ]] && DESIGN_SYSTEM="$DETECTED_DESIGN_SYSTEM"
  fi

  [[ -z "$OFFICE_DEFAULT" ]] && OFFICE_DEFAULT="$SELECTED_AGENCY_DEFAULT"
  [[ -z "$SELECTED_AGENCY_DEFAULT" ]] && SELECTED_AGENCY_DEFAULT="$OFFICE_DEFAULT"
  [[ -z "$SELECTED_AGENCY_DEFAULT" && -f "$AGENCY_JSON" ]] && SELECTED_AGENCY_DEFAULT="$(get_json_value name "$AGENCY_JSON")"
  [[ -z "$SELECTED_AGENCY_DEFAULT" ]] && SELECTED_AGENCY_DEFAULT="custom-office"
  [[ -z "$OFFICE_DEFAULT" ]] && OFFICE_DEFAULT="$SELECTED_AGENCY_DEFAULT"
  [[ -z "$LEGACY_AGENCY_PRESET_DEFAULT" && "$OFFICE_MODE" == "legacy-preset" ]] && LEGACY_AGENCY_PRESET_DEFAULT="$SELECTED_AGENCY_DEFAULT"
  [[ -z "$OFFICE_MODE" ]] && OFFICE_MODE="custom"
  [[ -z "$PROJECT_NAME_DEFAULT" ]] && PROJECT_NAME_DEFAULT="$BASE_PROJECT_NAME_DEFAULT"
  [[ -z "$TYPECHECK_CMD" ]] && TYPECHECK_CMD="$BASE_TYPECHECK_CMD"
  [[ -z "$LINT_CMD" ]] && LINT_CMD="$BASE_LINT_CMD"
  [[ -z "$TEST_CMD" ]] && TEST_CMD="$BASE_TEST_CMD"
  [[ -z "$TEST_RUNNER" ]] && TEST_RUNNER="$BASE_TEST_RUNNER"
  [[ -z "$UI_FRAMEWORK" ]] && UI_FRAMEWORK="$BASE_UI_FRAMEWORK"
  [[ -z "$DESIGN_SYSTEM" ]] && DESIGN_SYSTEM="$BASE_DESIGN_SYSTEM"
  [[ -z "$COVERAGE_MIN" ]] && COVERAGE_MIN="80"
  [[ -z "$LIGHTHOUSE_MIN" ]] && LIGHTHOUSE_MIN="90"
  [[ -z "$ADVANCE_MODE" ]] && ADVANCE_MODE="manual"
  [[ -z "$PRE_IMPLEMENTATION_MODE" ]] && PRE_IMPLEMENTATION_MODE="minimal"
  [[ -z "$INTERACTIVE_CHOICES_MODE" ]] && INTERACTIVE_CHOICES_MODE="text"
  [[ -z "$COMPLETION_CHECK_CMD_1" ]] && COMPLETION_CHECK_CMD_1=""
  [[ -z "$COMPLETION_CHECK_CMD_2" ]] && COMPLETION_CHECK_CMD_2=""
  [[ -z "$COMPLETION_CHECK_CMD_3" ]] && COMPLETION_CHECK_CMD_3=""
  [[ -z "$TASK_ISOLATION_MODE" ]] && TASK_ISOLATION_MODE="none"
  [[ -z "$TASK_BASE_BRANCH" ]] && TASK_BASE_BRANCH="dev"
  [[ -z "$TASK_MERGE_TARGET" ]] && TASK_MERGE_TARGET="dev"
  [[ -z "$TASK_WORKTREE_ROOT" ]] && TASK_WORKTREE_ROOT=".ai-office/worktrees"
  [[ -z "$ENABLE_GITHUB_SYNC" ]] && ENABLE_GITHUB_SYNC="no"
  [[ -z "$TOKEN_BUDGET_MODE" ]] && TOKEN_BUDGET_MODE="conservative"
  [[ -z "$TOKEN_BUDGET_MAX_CONTEXT_FILES" ]] && TOKEN_BUDGET_MAX_CONTEXT_FILES="8"
  [[ -z "$TOKEN_BUDGET_MAX_ROLES_PER_TASK" ]] && TOKEN_BUDGET_MAX_ROLES_PER_TASK="2"
  [[ -z "$TOKEN_BUDGET_MAX_STAGE_ARTIFACTS" ]] && TOKEN_BUDGET_MAX_STAGE_ARTIFACTS="3"
  [[ -z "$TOKEN_BUDGET_MAX_REVIEW_ITERATIONS" ]] && TOKEN_BUDGET_MAX_REVIEW_ITERATIONS="2"
  [[ -z "$TOKEN_BUDGET_SUMMARIZE_AFTER_STAGE" ]] && TOKEN_BUDGET_SUMMARIZE_AFTER_STAGE="true"
  [[ -z "$AGENT_OPERATING_MODE" ]] && AGENT_OPERATING_MODE="review-first"
  [[ -z "$REQUIRE_INTENT_CHECK" ]] && REQUIRE_INTENT_CHECK="true"
  [[ -z "$REQUIRE_PLAN_BEFORE_CODE" ]] && REQUIRE_PLAN_BEFORE_CODE="true"
  [[ -z "$ALLOW_TINY_FIX_FAST_PATH" ]] && ALLOW_TINY_FIX_FAST_PATH="true"
  [[ -z "$MAX_PLAN_OPTIONS" ]] && MAX_PLAN_OPTIONS="3"
  [[ -z "$STOP_ON_PRODUCT_MISMATCH" ]] && STOP_ON_PRODUCT_MISMATCH="true"
  [[ -z "$BACKGROUND_WORK_MODE" ]] && BACKGROUND_WORK_MODE="simulated"
  [[ -z "$BACKGROUND_MAX_ACTIVE_TASKS" ]] && BACKGROUND_MAX_ACTIVE_TASKS="3"
  [[ -z "$BACKGROUND_REQUIRES_STATUS_FILE" ]] && BACKGROUND_REQUIRES_STATUS_FILE="true"
  [[ -z "$BACKGROUND_REQUIRES_RESUME_INSTRUCTIONS" ]] && BACKGROUND_REQUIRES_RESUME_INSTRUCTIONS="true"
  [[ -z "$TASK_COMMIT_TRACEABILITY" ]] && TASK_COMMIT_TRACEABILITY="yes"
  [[ -z "$TASK_COMMIT_POLICY" ]] && TASK_COMMIT_POLICY="required-for-implementation"
  [[ -z "$TASK_COMMIT_LINK_MODE" ]] && TASK_COMMIT_LINK_MODE="detect-current-branch"
  [[ -z "$TASK_COMMIT_REQUIRE_VERIFICATION" ]] && TASK_COMMIT_REQUIRE_VERIFICATION="yes"
  [[ -z "$TASK_COMMIT_ALLOW_NO_CODE" ]] && TASK_COMMIT_ALLOW_NO_CODE="yes"
  [[ -z "$TASK_COMMIT_ALLOW_MULTIPLE" ]] && TASK_COMMIT_ALLOW_MULTIPLE="yes"
  [[ -z "$TASK_COMMIT_MESSAGE_TEMPLATE" ]] && TASK_COMMIT_MESSAGE_TEMPLATE="{task_id}: {task_title}"
  [[ -z "$GITHUB_ISSUE_LINKING" ]] && GITHUB_ISSUE_LINKING="optional"
  [[ -z "$GITHUB_COMMIT_LINKING" ]] && GITHUB_COMMIT_LINKING="optional"
  [[ -z "$COMMIT_REFERENCE_STYLE" ]] && COMMIT_REFERENCE_STYLE="task-and-issue"
  [[ -z "$GITHUB_COMMIT_CLOSES_ISSUE" ]] && GITHUB_COMMIT_CLOSES_ISSUE="false"
  [[ -z "$GITHUB_ISSUE_INTAKE" ]] && GITHUB_ISSUE_INTAKE="enabled"
  [[ -z "$GITHUB_ISSUE_AUTO_TRIAGE" ]] && GITHUB_ISSUE_AUTO_TRIAGE="suggested"
  [[ -z "$GITHUB_ISSUE_CREATE_TASK" ]] && GITHUB_ISSUE_CREATE_TASK="ask"
  [[ -z "$GITHUB_ISSUE_DEFAULT_COLUMN" ]] && GITHUB_ISSUE_DEFAULT_COLUMN="BACKLOG"
  [[ -z "$GITHUB_ISSUE_DEFAULT_MILESTONE" ]] && GITHUB_ISSUE_DEFAULT_MILESTONE="M0"
  [[ -z "$GITHUB_ISSUE_LABEL_SYNC" ]] && GITHUB_ISSUE_LABEL_SYNC="yes"
  [[ -z "$GITHUB_ISSUE_COMMENT_UPDATES" ]] && GITHUB_ISSUE_COMMENT_UPDATES="ask"
  [[ -z "$GITHUB_ISSUE_CLOSE_ON_INTEGRATION" ]] && GITHUB_ISSUE_CLOSE_ON_INTEGRATION="no"
  [[ -z "$GITHUB_ISSUE_SECURITY_PRIVATE_MODE" ]] && GITHUB_ISSUE_SECURITY_PRIVATE_MODE="true"
  [[ -z "$AGENT_INSTRUCTION_DISCOVERY" ]] && AGENT_INSTRUCTION_DISCOVERY="enabled"
  [[ -z "$INSTRUCTION_MERGE_MODE" ]] && INSTRUCTION_MERGE_MODE="section"
  [[ -z "$INSTRUCTION_BACKUP" ]] && INSTRUCTION_BACKUP="yes"
  [[ -z "$INSTRUCTION_CONFLICT_POLICY" ]] && INSTRUCTION_CONFLICT_POLICY="keep-existing"
  [[ -z "$INSTRUCTION_SIDECAR_DIR" ]] && INSTRUCTION_SIDECAR_DIR=".ai-office/instructions"
  [[ -z "$NOTES_BLOCK" ]] && NOTES_BLOCK="> Add project-specific context here — tech decisions, constraints, key stakeholders."
fi

if [[ -n "$STACK_ARG" ]]; then
  apply_preset "$STACK_ARG"
fi

if [[ -n "$ADVANCE_MODE_ARG" ]]; then
  ADVANCE_MODE="$ADVANCE_MODE_ARG"
fi
if [[ -n "$PRE_IMPLEMENTATION_MODE_ARG" ]]; then
  PRE_IMPLEMENTATION_MODE="$PRE_IMPLEMENTATION_MODE_ARG"
fi
if [[ -n "$INTERACTIVE_CHOICES_MODE_ARG" ]]; then
  INTERACTIVE_CHOICES_MODE="$INTERACTIVE_CHOICES_MODE_ARG"
fi
if [[ -n "$COMPLETION_CHECK_CMD_1_ARG" ]]; then
  COMPLETION_CHECK_CMD_1="$COMPLETION_CHECK_CMD_1_ARG"
fi
if [[ -n "$COMPLETION_CHECK_CMD_2_ARG" ]]; then
  COMPLETION_CHECK_CMD_2="$COMPLETION_CHECK_CMD_2_ARG"
fi
if [[ -n "$COMPLETION_CHECK_CMD_3_ARG" ]]; then
  COMPLETION_CHECK_CMD_3="$COMPLETION_CHECK_CMD_3_ARG"
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
if [[ -n "$ENABLE_GITHUB_SYNC_ARG" ]]; then
  ENABLE_GITHUB_SYNC="$ENABLE_GITHUB_SYNC_ARG"
fi
[[ -n "$TASK_COMMIT_TRACEABILITY_ARG" ]] && TASK_COMMIT_TRACEABILITY="$TASK_COMMIT_TRACEABILITY_ARG"
[[ -n "$TASK_COMMIT_POLICY_ARG" ]] && TASK_COMMIT_POLICY="$TASK_COMMIT_POLICY_ARG"
[[ -n "$TASK_COMMIT_LINK_MODE_ARG" ]] && TASK_COMMIT_LINK_MODE="$TASK_COMMIT_LINK_MODE_ARG"
[[ -n "$TASK_COMMIT_REQUIRE_VERIFICATION_ARG" ]] && TASK_COMMIT_REQUIRE_VERIFICATION="$TASK_COMMIT_REQUIRE_VERIFICATION_ARG"
[[ -n "$TASK_COMMIT_ALLOW_NO_CODE_ARG" ]] && TASK_COMMIT_ALLOW_NO_CODE="$TASK_COMMIT_ALLOW_NO_CODE_ARG"
[[ -n "$GITHUB_ISSUE_LINKING_ARG" ]] && GITHUB_ISSUE_LINKING="$GITHUB_ISSUE_LINKING_ARG"
[[ -n "$GITHUB_COMMIT_LINKING_ARG" ]] && GITHUB_COMMIT_LINKING="$GITHUB_COMMIT_LINKING_ARG"
[[ -n "$COMMIT_REFERENCE_STYLE_ARG" ]] && COMMIT_REFERENCE_STYLE="$COMMIT_REFERENCE_STYLE_ARG"
[[ -n "$GITHUB_ISSUE_INTAKE_ARG" ]] && GITHUB_ISSUE_INTAKE="$GITHUB_ISSUE_INTAKE_ARG"
[[ -n "$GITHUB_ISSUE_AUTO_TRIAGE_ARG" ]] && GITHUB_ISSUE_AUTO_TRIAGE="$GITHUB_ISSUE_AUTO_TRIAGE_ARG"
[[ -n "$GITHUB_ISSUE_CREATE_TASK_ARG" ]] && GITHUB_ISSUE_CREATE_TASK="$GITHUB_ISSUE_CREATE_TASK_ARG"
[[ -n "$GITHUB_ISSUE_COMMENT_UPDATES_ARG" ]] && GITHUB_ISSUE_COMMENT_UPDATES="$GITHUB_ISSUE_COMMENT_UPDATES_ARG"
[[ -n "$GITHUB_ISSUE_CLOSE_ON_INTEGRATION_ARG" ]] && GITHUB_ISSUE_CLOSE_ON_INTEGRATION="$GITHUB_ISSUE_CLOSE_ON_INTEGRATION_ARG"
[[ -n "$GITHUB_ISSUE_SECURITY_PRIVATE_MODE_ARG" ]] && GITHUB_ISSUE_SECURITY_PRIVATE_MODE="$GITHUB_ISSUE_SECURITY_PRIVATE_MODE_ARG"
[[ -n "$AGENT_INSTRUCTION_DISCOVERY_ARG" ]] && AGENT_INSTRUCTION_DISCOVERY="$AGENT_INSTRUCTION_DISCOVERY_ARG"
[[ -n "$INSTRUCTION_MERGE_MODE_ARG" ]] && INSTRUCTION_MERGE_MODE="$INSTRUCTION_MERGE_MODE_ARG"
[[ -n "$INSTRUCTION_BACKUP_ARG" ]] && INSTRUCTION_BACKUP="$INSTRUCTION_BACKUP_ARG"
[[ -n "$INSTRUCTION_CONFLICT_POLICY_ARG" ]] && INSTRUCTION_CONFLICT_POLICY="$INSTRUCTION_CONFLICT_POLICY_ARG"
[[ -n "$INSTRUCTION_SIDECAR_DIR_ARG" ]] && INSTRUCTION_SIDECAR_DIR="$INSTRUCTION_SIDECAR_DIR_ARG"

normalize_yes_no() {
  local raw="$1"
  local lowered
  lowered="$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    yes|y|true|1|on) echo "yes" ;;
    no|n|false|0|off|"") echo "no" ;;
    *)
      echo "⚠️  Invalid yes/no value: $raw"
      exit 1
      ;;
  esac
}

ENABLE_GITHUB_SYNC="$(normalize_yes_no "$ENABLE_GITHUB_SYNC")"

validate_choice() {
  local name="$1" value="$2" allowed="$3"
  case " $allowed " in
    *" $value "*) ;;
    *)
      echo "⚠️  Invalid $name value: $value"
      echo "   Allowed: $allowed"
      exit 1
      ;;
  esac
}

TASK_COMMIT_TRACEABILITY="$(normalize_yes_no "$TASK_COMMIT_TRACEABILITY")"
TASK_COMMIT_REQUIRE_VERIFICATION="$(normalize_yes_no "$TASK_COMMIT_REQUIRE_VERIFICATION")"
TASK_COMMIT_ALLOW_NO_CODE="$(normalize_yes_no "$TASK_COMMIT_ALLOW_NO_CODE")"
TASK_COMMIT_ALLOW_MULTIPLE="$(normalize_yes_no "$TASK_COMMIT_ALLOW_MULTIPLE")"
GITHUB_ISSUE_LABEL_SYNC="$(normalize_yes_no "$GITHUB_ISSUE_LABEL_SYNC")"
GITHUB_ISSUE_CLOSE_ON_INTEGRATION="$(normalize_yes_no "$GITHUB_ISSUE_CLOSE_ON_INTEGRATION")"
INSTRUCTION_BACKUP="$(normalize_yes_no "$INSTRUCTION_BACKUP")"
validate_choice task_commit_policy "$TASK_COMMIT_POLICY" "disabled suggested required-for-implementation required-for-all"
validate_choice task_commit_link_mode "$TASK_COMMIT_LINK_MODE" "manual detect-current-branch detect-recent-commit"
validate_choice github_issue_linking "$GITHUB_ISSUE_LINKING" "disabled optional enabled"
validate_choice github_commit_linking "$GITHUB_COMMIT_LINKING" "disabled optional enabled"
validate_choice commit_reference_style "$COMMIT_REFERENCE_STYLE" "task-id issue-number task-and-issue conventional"
validate_choice github_issue_intake "$GITHUB_ISSUE_INTAKE" "disabled enabled"
validate_choice github_issue_auto_triage "$GITHUB_ISSUE_AUTO_TRIAGE" "disabled suggested auto"
validate_choice github_issue_create_task "$GITHUB_ISSUE_CREATE_TASK" "never ask auto-for-actionable"
validate_choice github_issue_comment_updates "$GITHUB_ISSUE_COMMENT_UPDATES" "never ask auto"
validate_choice github_issue_security_private_mode "$GITHUB_ISSUE_SECURITY_PRIVATE_MODE" "true false"
validate_choice agent_instruction_discovery "$AGENT_INSTRUCTION_DISCOVERY" "disabled enabled"
validate_choice instruction_merge_mode "$INSTRUCTION_MERGE_MODE" "section sidecar append skip overwrite-explicit"
validate_choice instruction_conflict_policy "$INSTRUCTION_CONFLICT_POLICY" "ask keep-existing prefer-ai-office sidecar"

if [[ "$ENABLE_GITHUB_SYNC" == "yes" ]]; then
  [[ -z "$GITHUB_ISSUE_LINKING_ARG" ]] && GITHUB_ISSUE_LINKING="enabled"
  [[ -z "$GITHUB_COMMIT_LINKING_ARG" ]] && GITHUB_COMMIT_LINKING="enabled"
  [[ -z "$COMMIT_REFERENCE_STYLE_ARG" ]] && COMMIT_REFERENCE_STYLE="task-and-issue"
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

if [[ "$AUTO_MODE" == true ]]; then
  SELECTED_AGENCY="custom-office"
  OFFICE="custom-office"
  LEGACY_AGENCY_PRESET=""
  OFFICE_MODE="custom"
elif [[ -n "$AGENCY_ARG" ]]; then
  SELECTED_AGENCY="$AGENCY_ARG"
  OFFICE="$AGENCY_ARG"
  LEGACY_AGENCY_PRESET="$AGENCY_ARG"
  OFFICE_MODE="legacy-preset"
elif [[ "$NON_INTERACTIVE" == true ]]; then
  SELECTED_AGENCY="$SELECTED_AGENCY_DEFAULT"
  OFFICE="$OFFICE_DEFAULT"
  LEGACY_AGENCY_PRESET="$LEGACY_AGENCY_PRESET_DEFAULT"
else
  default_agency_choice=1
  for i in "${!AGENCIES[@]}"; do
    if [[ "${AGENCIES[$i]}" == "$SELECTED_AGENCY_DEFAULT" ]]; then
      default_agency_choice=$((i+1))
      break
    fi
  done

  echo "Select legacy preset:"
  for i in "${!AGENCIES[@]}"; do
    marker=""
    [[ "${AGENCY_CUSTOMS[$i]}" == "true" ]] && marker=" [custom]"
    echo "  $((i+1))) ${AGENCIES[$i]}${marker} — ${AGENCY_DESCS[$i]}"
  done
  read -p "Legacy preset [$default_agency_choice]: " agency_choice
  agency_choice="${agency_choice:-$default_agency_choice}"
  SELECTED_AGENCY="${AGENCIES[$((agency_choice-1))]}"
  OFFICE="$SELECTED_AGENCY"
  LEGACY_AGENCY_PRESET="$SELECTED_AGENCY"
  OFFICE_MODE="legacy-preset"
fi
[[ -z "$OFFICE" ]] && OFFICE="$SELECTED_AGENCY"
echo "  → Office mode: $OFFICE_MODE"
if [[ "$OFFICE_MODE" == "legacy-preset" ]]; then
  echo "  → Legacy preset: $LEGACY_AGENCY_PRESET"
fi
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
prompt_with_default "  Pre-implementation mode (minimal|confirm|collaborative)" "$PRE_IMPLEMENTATION_MODE" PRE_IMPLEMENTATION_MODE
prompt_with_default "  Interactive choices (text|buttons-when-available)" "$INTERACTIVE_CHOICES_MODE" INTERACTIVE_CHOICES_MODE
echo ""

echo "Task completion verification (optional, run in order before marking work correct):"
prompt_with_default "  Completion check command 1" "$COMPLETION_CHECK_CMD_1" COMPLETION_CHECK_CMD_1
prompt_with_default "  Completion check command 2" "$COMPLETION_CHECK_CMD_2" COMPLETION_CHECK_CMD_2
prompt_with_default "  Completion check command 3" "$COMPLETION_CHECK_CMD_3" COMPLETION_CHECK_CMD_3
echo ""

echo "Git task workflow:"
prompt_with_default "  Task isolation (none|branch|worktree)" "$TASK_ISOLATION_MODE" TASK_ISOLATION_MODE
prompt_with_default "  Task base branch                 " "$TASK_BASE_BRANCH" TASK_BASE_BRANCH
prompt_with_default "  Task merge target                " "$TASK_MERGE_TARGET" TASK_MERGE_TARGET
prompt_with_default "  Task worktree root               " "$TASK_WORKTREE_ROOT" TASK_WORKTREE_ROOT
echo ""

if [[ "$NON_INTERACTIVE" == true ]]; then
  ENABLE_GITHUB_SYNC="$(normalize_yes_no "$ENABLE_GITHUB_SYNC")"
else
  prompt_with_default "Enable AI Office GitHub sync workflows (yes|no)" "$ENABLE_GITHUB_SYNC" ENABLE_GITHUB_SYNC
  ENABLE_GITHUB_SYNC="$(normalize_yes_no "$ENABLE_GITHUB_SYNC")"
fi
echo ""

echo "Task commit traceability:"
prompt_with_default "  Enable task-to-commit traceability (yes|no)" "$TASK_COMMIT_TRACEABILITY" TASK_COMMIT_TRACEABILITY
prompt_with_default "  Commit policy (disabled|suggested|required-for-implementation|required-for-all)" "$TASK_COMMIT_POLICY" TASK_COMMIT_POLICY
prompt_with_default "  Commit link mode (manual|detect-current-branch|detect-recent-commit)" "$TASK_COMMIT_LINK_MODE" TASK_COMMIT_LINK_MODE
prompt_with_default "  Require verification before DONE (yes|no)" "$TASK_COMMIT_REQUIRE_VERIFICATION" TASK_COMMIT_REQUIRE_VERIFICATION
prompt_with_default "  Allow no-code/docs-only completion (yes|no)" "$TASK_COMMIT_ALLOW_NO_CODE" TASK_COMMIT_ALLOW_NO_CODE
prompt_with_default "  GitHub issue linking (disabled|optional|enabled)" "$GITHUB_ISSUE_LINKING" GITHUB_ISSUE_LINKING
prompt_with_default "  GitHub commit linking (disabled|optional|enabled)" "$GITHUB_COMMIT_LINKING" GITHUB_COMMIT_LINKING
prompt_with_default "  Commit reference style (task-id|issue-number|task-and-issue|conventional)" "$COMMIT_REFERENCE_STYLE" COMMIT_REFERENCE_STYLE
echo ""

echo "GitHub issue intake:"
prompt_with_default "  Enable GitHub issue intake (disabled|enabled)" "$GITHUB_ISSUE_INTAKE" GITHUB_ISSUE_INTAKE
prompt_with_default "  Auto-triage GitHub issues (disabled|suggested|auto)" "$GITHUB_ISSUE_AUTO_TRIAGE" GITHUB_ISSUE_AUTO_TRIAGE
prompt_with_default "  Create tasks from actionable issues (never|ask|auto-for-actionable)" "$GITHUB_ISSUE_CREATE_TASK" GITHUB_ISSUE_CREATE_TASK
prompt_with_default "  Comment back on GitHub issues (never|ask|auto)" "$GITHUB_ISSUE_COMMENT_UPDATES" GITHUB_ISSUE_COMMENT_UPDATES
prompt_with_default "  Close GitHub issues after integration (yes|no)" "$GITHUB_ISSUE_CLOSE_ON_INTEGRATION" GITHUB_ISSUE_CLOSE_ON_INTEGRATION
prompt_with_default "  Private mode for security reports (true|false)" "$GITHUB_ISSUE_SECURITY_PRIVATE_MODE" GITHUB_ISSUE_SECURITY_PRIVATE_MODE
echo ""

echo "Existing agent instructions:"
prompt_with_default "  Scan existing agent instruction files (enabled|disabled)" "$AGENT_INSTRUCTION_DISCOVERY" AGENT_INSTRUCTION_DISCOVERY
prompt_with_default "  Instruction merge mode (section|sidecar|append|skip)" "$INSTRUCTION_MERGE_MODE" INSTRUCTION_MERGE_MODE
prompt_with_default "  Backup existing instruction files (yes|no)" "$INSTRUCTION_BACKUP" INSTRUCTION_BACKUP
prompt_with_default "  Instruction conflict policy (keep-existing|ask|prefer-ai-office|sidecar)" "$INSTRUCTION_CONFLICT_POLICY" INSTRUCTION_CONFLICT_POLICY
echo ""

TASK_COMMIT_TRACEABILITY="$(normalize_yes_no "$TASK_COMMIT_TRACEABILITY")"
TASK_COMMIT_REQUIRE_VERIFICATION="$(normalize_yes_no "$TASK_COMMIT_REQUIRE_VERIFICATION")"
TASK_COMMIT_ALLOW_NO_CODE="$(normalize_yes_no "$TASK_COMMIT_ALLOW_NO_CODE")"
GITHUB_ISSUE_CLOSE_ON_INTEGRATION="$(normalize_yes_no "$GITHUB_ISSUE_CLOSE_ON_INTEGRATION")"
INSTRUCTION_BACKUP="$(normalize_yes_no "$INSTRUCTION_BACKUP")"
validate_choice task_commit_policy "$TASK_COMMIT_POLICY" "disabled suggested required-for-implementation required-for-all"
validate_choice task_commit_link_mode "$TASK_COMMIT_LINK_MODE" "manual detect-current-branch detect-recent-commit"
validate_choice github_issue_linking "$GITHUB_ISSUE_LINKING" "disabled optional enabled"
validate_choice github_commit_linking "$GITHUB_COMMIT_LINKING" "disabled optional enabled"
validate_choice commit_reference_style "$COMMIT_REFERENCE_STYLE" "task-id issue-number task-and-issue conventional"
validate_choice github_issue_intake "$GITHUB_ISSUE_INTAKE" "disabled enabled"
validate_choice github_issue_auto_triage "$GITHUB_ISSUE_AUTO_TRIAGE" "disabled suggested auto"
validate_choice github_issue_create_task "$GITHUB_ISSUE_CREATE_TASK" "never ask auto-for-actionable"
validate_choice github_issue_comment_updates "$GITHUB_ISSUE_COMMENT_UPDATES" "never ask auto"
validate_choice github_issue_security_private_mode "$GITHUB_ISSUE_SECURITY_PRIVATE_MODE" "true false"
validate_choice agent_instruction_discovery "$AGENT_INSTRUCTION_DISCOVERY" "disabled enabled"
validate_choice instruction_merge_mode "$INSTRUCTION_MERGE_MODE" "section sidecar append skip overwrite-explicit"
validate_choice instruction_conflict_policy "$INSTRUCTION_CONFLICT_POLICY" "ask keep-existing prefer-ai-office sidecar"

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

LEGACY_PRESET_LINE=""
LEGACY_PRESET_SUMMARY=""
if [[ "$OFFICE_MODE" == "legacy-preset" ]]; then
  LEGACY_PRESET_LINE="legacy_agency_preset: $LEGACY_AGENCY_PRESET"
  LEGACY_PRESET_SUMMARY="**Legacy preset:** $LEGACY_AGENCY_PRESET"
else
  LEGACY_PRESET_LINE='legacy_agency_preset: ""'
fi

# ── Write project.config.md ───────────────────────────────────────────────────
cat > "$CONFIG_FILE" <<EOF
---
office: $OFFICE
office_mode: $OFFICE_MODE
$LEGACY_PRESET_LINE
# Deprecated compatibility field. Prefer \`office\` and \`legacy_agency_preset\`.
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

# Quality thresholds — override office defaults
coverage_min: $COVERAGE_MIN
lighthouse_min: $LIGHTHOUSE_MIN

# Pipeline behaviour — manual | auto
advance_mode: $ADVANCE_MODE
pre_implementation_mode: $PRE_IMPLEMENTATION_MODE
interactive_choices_mode: $INTERACTIVE_CHOICES_MODE

# Task completion verification — optional ordered commands
completion_check_cmd_1: "$COMPLETION_CHECK_CMD_1"
completion_check_cmd_2: "$COMPLETION_CHECK_CMD_2"
completion_check_cmd_3: "$COMPLETION_CHECK_CMD_3"

# Git task workflow — opt-in branch/worktree isolation
task_isolation_mode: $TASK_ISOLATION_MODE
task_base_branch: "$TASK_BASE_BRANCH"
task_merge_target: "$TASK_MERGE_TARGET"
task_worktree_root: "$TASK_WORKTREE_ROOT"
enable_github_sync: $ENABLE_GITHUB_SYNC

# Token budget - keep generated office context small
token_budget_mode: $TOKEN_BUDGET_MODE
token_budget_max_context_files: $TOKEN_BUDGET_MAX_CONTEXT_FILES
token_budget_max_roles_per_task: $TOKEN_BUDGET_MAX_ROLES_PER_TASK
token_budget_max_stage_artifacts: $TOKEN_BUDGET_MAX_STAGE_ARTIFACTS
token_budget_max_review_iterations: $TOKEN_BUDGET_MAX_REVIEW_ITERATIONS
token_budget_summarize_after_stage: $TOKEN_BUDGET_SUMMARIZE_AFTER_STAGE

# Agent operating model - review-first collaboration gates
agent_operating_mode: $AGENT_OPERATING_MODE
require_intent_check: $REQUIRE_INTENT_CHECK
require_plan_before_code: $REQUIRE_PLAN_BEFORE_CODE
allow_tiny_fix_fast_path: $ALLOW_TINY_FIX_FAST_PATH
max_plan_options: $MAX_PLAN_OPTIONS
stop_on_product_mismatch: $STOP_ON_PRODUCT_MISMATCH

# Background-capable workflow model - markdown/status based by default
background_work_mode: $BACKGROUND_WORK_MODE
background_max_active_tasks: $BACKGROUND_MAX_ACTIVE_TASKS
background_requires_status_file: $BACKGROUND_REQUIRES_STATUS_FILE
background_requires_resume_instructions: $BACKGROUND_REQUIRES_RESUME_INSTRUCTIONS

# Task commit traceability
task_commit_traceability: $TASK_COMMIT_TRACEABILITY
task_commit_policy: $TASK_COMMIT_POLICY
task_commit_link_mode: $TASK_COMMIT_LINK_MODE
task_commit_require_verification: $TASK_COMMIT_REQUIRE_VERIFICATION
task_commit_allow_no_code: $TASK_COMMIT_ALLOW_NO_CODE
task_commit_allow_multiple: $TASK_COMMIT_ALLOW_MULTIPLE
task_commit_message_template: "$TASK_COMMIT_MESSAGE_TEMPLATE"

# GitHub issue / commit linking
github_issue_linking: $GITHUB_ISSUE_LINKING
github_commit_linking: $GITHUB_COMMIT_LINKING
commit_reference_style: $COMMIT_REFERENCE_STYLE
github_commit_closes_issue: $GITHUB_COMMIT_CLOSES_ISSUE

# GitHub issue intake
github_issue_intake: $GITHUB_ISSUE_INTAKE
github_issue_auto_triage: $GITHUB_ISSUE_AUTO_TRIAGE
github_issue_create_task: $GITHUB_ISSUE_CREATE_TASK
github_issue_default_column: $GITHUB_ISSUE_DEFAULT_COLUMN
github_issue_default_milestone: $GITHUB_ISSUE_DEFAULT_MILESTONE
github_issue_label_sync: $GITHUB_ISSUE_LABEL_SYNC
github_issue_comment_updates: $GITHUB_ISSUE_COMMENT_UPDATES
github_issue_close_on_integration: $GITHUB_ISSUE_CLOSE_ON_INTEGRATION
github_issue_security_private_mode: $GITHUB_ISSUE_SECURITY_PRIVATE_MODE

# Agent instruction discovery / merge
agent_instruction_discovery: $AGENT_INSTRUCTION_DISCOVERY
instruction_merge_mode: $INSTRUCTION_MERGE_MODE
instruction_backup: $INSTRUCTION_BACKUP
instruction_conflict_policy: $INSTRUCTION_CONFLICT_POLICY
instruction_sidecar_dir: "$INSTRUCTION_SIDECAR_DIR"
$([[ -n "$EXTRA_FRONTMATTER_BLOCK" ]] && printf '\n\n%s' "$EXTRA_FRONTMATTER_BLOCK")

# Optional: skip pipeline stages for this project
# skip_stages: []
---

# Project Configuration

**Project:** $PROJECT_NAME
**Office:** $OFFICE
**Office mode:** $OFFICE_MODE
$LEGACY_PRESET_SUMMARY
**Created:** $WRITTEN_CREATED_DATE

## Notes

$NOTES_BLOCK
EOF

if [[ "$CONFIG_EXISTS" == true ]]; then
  echo "  ✅ Updated .ai-office/project.config.md"
else
  echo "  ✅ Created .ai-office/project.config.md"
fi

if [[ "$AGENT_INSTRUCTION_DISCOVERY" == "enabled" ]]; then
  (cd "$PROJECT_ROOT" && bun run "$FRAMEWORK_DIR/src/cli.ts" instruction scan >/dev/null)
  echo "  ✅ Scanned agent instruction files"
fi

# ── Generate project office artifacts ─────────────────────────────────────────
OFFICE="$OFFICE" \
OFFICE_MODE="$OFFICE_MODE" \
LEGACY_AGENCY_PRESET="$LEGACY_AGENCY_PRESET" \
SELECTED_AGENCY="$SELECTED_AGENCY" \
PROJECT_NAME="$PROJECT_NAME" \
AI_OFFICE="$AI_OFFICE" \
FRAMEWORK_DIR="$FRAMEWORK_DIR" \
DETECTED_PROJECT_TYPE="$DETECTED_PROJECT_TYPE" \
DETECTED_LANGUAGE="$DETECTED_LANGUAGE" \
DETECTED_LANGUAGE_TOOLCHAIN="$DETECTED_LANGUAGE_TOOLCHAIN" \
NODE_PACKAGE_MANAGER="$NODE_PACKAGE_MANAGER" \
UI_FRAMEWORK="$UI_FRAMEWORK" \
DESIGN_SYSTEM="$DESIGN_SYSTEM" \
TEST_RUNNER="$TEST_RUNNER" \
TYPECHECK_CMD="$TYPECHECK_CMD" \
LINT_CMD="$LINT_CMD" \
TEST_CMD="$TEST_CMD" \
DETECTED_PIPELINE="$DETECTED_PIPELINE" \
DETECTED_ROLES="$DETECTED_ROLES" \
DETECTED_RISK_AREAS="$DETECTED_RISK_AREAS" \
DETECTED_QUALITY_GATES="$DETECTED_QUALITY_GATES" \
DETECTED_REPOSITORY_SIGNALS="$DETECTED_REPOSITORY_SIGNALS" \
TOKEN_BUDGET_MAX_CONTEXT_FILES="$TOKEN_BUDGET_MAX_CONTEXT_FILES" \
TOKEN_BUDGET_MAX_REVIEW_ITERATIONS="$TOKEN_BUDGET_MAX_REVIEW_ITERATIONS" \
bun run "$FRAMEWORK_DIR/src/custom-office-generator.ts"

# ── Write agency.json ─────────────────────────────────────────────────────────
IS_CUSTOM=true
for i in "${!AGENCIES[@]}"; do
  if [[ "${AGENCIES[$i]}" == "$SELECTED_AGENCY" && "${AGENCY_CUSTOMS[$i]}" == "true" ]]; then
    IS_CUSTOM=true
    break
  fi
done
if [[ "$OFFICE_MODE" == "legacy-preset" ]]; then
  IS_CUSTOM=false
  for i in "${!AGENCIES[@]}"; do
    if [[ "${AGENCIES[$i]}" == "$SELECTED_AGENCY" && "${AGENCY_CUSTOMS[$i]}" == "true" ]]; then
      IS_CUSTOM=true
      break
    fi
  done
fi

cat > "$AGENCY_JSON" <<EOF
{
  "name": "$SELECTED_AGENCY",
  "selectedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "custom": $IS_CUSTOM
}
EOF
echo "  ✅ Updated .ai-office/agency.json"

install_github_workflows() {
  local workflows_dir="$PROJECT_ROOT/.github/workflows"
  mkdir -p "$workflows_dir"

  cat > "$workflows_dir/ai-office-sync.yml" <<'EOF'
name: AI Office Sync

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

on:
  workflow_dispatch:
  schedule:
    - cron: "15 * * * *"

permissions:
  contents: read
  issues: write

jobs:
  sync-ai-office:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
      GITHUB_TOKEN: ${{ github.token }}
      GITHUB_REPOSITORY: ${{ github.repository }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Sync AI Office tasks to GitHub Issues
        run: bun run bin/ai-office task sync github
EOF

  cat > "$workflows_dir/ai-office-github-inbound.yml" <<'EOF'
name: AI Office GitHub Inbound

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

on:
  issues:
    types: [reopened, closed]
  issue_comment:
    types: [created]

permissions:
  contents: write
  issues: write

concurrency:
  group: ai-office-github-inbound-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  sync-from-github:
    runs-on: ubuntu-latest
    if: github.event.issue.pull_request == null
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Apply inbound sync
        run: bun run bin/ai-office task sync github --inbound
        env:
          GITHUB_EVENT_PATH: ${{ github.event_path }}
          GITHUB_EVENT_NAME: ${{ github.event_name }}

      - name: Commit changes if any
        run: |
          if git diff --quiet; then
            echo "No changes to commit."
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add .ai-office/tasks
          git commit -m "chore(ai-office): inbound github sync #${{ github.event.issue.number }}"
          git push
EOF
}

if [[ "$ENABLE_GITHUB_SYNC" == "yes" ]]; then
  install_github_workflows
  echo "  ✅ Installed .github/workflows/ai-office-sync.yml"
  echo "  ✅ Installed .github/workflows/ai-office-github-inbound.yml"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Project office configured: $PROJECT_NAME ($OFFICE_MODE)"
echo ""
echo "Next steps:"
echo "  ai-office doctor       — verify framework health"
if [[ -d "$PROJECT_ROOT/$(adapter_skill_dest_rel codex)" ]]; then
  echo "  \$office-route <task>  — start from the Codex adapter"
elif [[ -d "$PROJECT_ROOT/$(adapter_commands_dest_rel opencode)" ]]; then
  echo "  /office-route <task>  — start from the OpenCode adapter"
elif [[ -d "$PROJECT_ROOT/$(adapter_skill_dest_rel claude-code)" ]]; then
  echo "  /office route <task>  — start from the Claude Code adapter"
else
  echo "  ai-office status get <slug> — inspect framework state from the CLI"
fi

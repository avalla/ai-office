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
#   --pre-implementation-mode=<mode>  Pre-implementation collaboration: minimal | confirm | collaborative
#   --completion-check-cmd-1=<cmd>    Optional task completion verification command #1
#   --completion-check-cmd-2=<cmd>    Optional task completion verification command #2
#   --completion-check-cmd-3=<cmd>    Optional task completion verification command #3
#   --task-isolation-mode=<mode>  Task git isolation: none | branch | worktree
#   --task-base-branch=<name>     Base branch for new task branches (default: dev)
#   --task-merge-target=<name>    Integration branch for task squash merges (default: dev)
#   --task-worktree-root=<path>   Root folder for task worktrees (default: .ai-office/worktrees)
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
NAME_ARG=""
STACK_ARG=""
ADVANCE_MODE_ARG=""
PRE_IMPLEMENTATION_MODE_ARG=""
COMPLETION_CHECK_CMD_1_ARG=""
COMPLETION_CHECK_CMD_2_ARG=""
COMPLETION_CHECK_CMD_3_ARG=""
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
    --pre-implementation-mode=*) PRE_IMPLEMENTATION_MODE_ARG="${arg#*=}" ;;
    --completion-check-cmd-1=*) COMPLETION_CHECK_CMD_1_ARG="${arg#*=}" ;;
    --completion-check-cmd-2=*) COMPLETION_CHECK_CMD_2_ARG="${arg#*=}" ;;
    --completion-check-cmd-3=*) COMPLETION_CHECK_CMD_3_ARG="${arg#*=}" ;;
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
      if ($0 ~ /^(agency|project_name|typecheck_cmd|lint_cmd|test_cmd|test_runner|ui_framework|design_system|coverage_min|lighthouse_min|advance_mode|pre_implementation_mode|completion_check_cmd_1|completion_check_cmd_2|completion_check_cmd_3|task_isolation_mode|task_base_branch|task_merge_target|task_worktree_root):/) {
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
# Discover bundled agencies plus any project-local custom agencies
AGENCIES=()
AGENCY_DESCS=()
AGENCY_CUSTOMS=()

for agency_dir in "$AI_OFFICE/agencies"/*/; do
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

# ── Project analysis ──────────────────────────────────────────────────────────
detect_project_settings() {
  PROJECT_ROOT="$PROJECT_ROOT" bun - <<'DETECT_EOF'
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

const root = process.env.PROJECT_ROOT;
const ignoreDirs = new Set([
  ".ai-office",
  ".ai-office-TMP",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);
const interestingFiles = new Set([
  "components.json",
  "deno.json",
  "deno.jsonc",
  "go.mod",
  "postcss.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "pyproject.toml",
  "tailwind.config.cjs",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
]);
const packageJsonPaths = new Set();
const discoveredFiles = new Set();

function walk(dir, depth = 0) {
  if (depth > 5) {
    return;
  }

  for (const entry of readdirSync(dir)) {
    if (ignoreDirs.has(entry)) {
      continue;
    }

    const fullPath = join(dir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      walk(fullPath, depth + 1);
      continue;
    }

    if (entry === "package.json") {
      packageJsonPaths.add(fullPath);
    }

    if (interestingFiles.has(entry)) {
      discoveredFiles.add(entry);
    }
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeReadText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function detectPackageManager() {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(root, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function scriptCommand(packageManager, scriptName) {
  switch (packageManager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

function execCommand(packageManager, binary, args = "") {
  const suffix = args ? ` ${args}` : "";
  switch (packageManager) {
    case "bun":
      return `bunx ${binary}${suffix}`;
    case "pnpm":
      return `pnpm exec ${binary}${suffix}`;
    case "yarn":
      return `yarn ${binary}${suffix}`;
    default:
      return `npx ${binary}${suffix}`;
  }
}

function emit(key, value) {
  if (value) {
    console.log(`${key}\t${String(value).replace(/\r?\n/g, " ").trim()}`);
  }
}

walk(root);

const rootPackagePath = join(root, "package.json");
const rootPackage = existsSync(rootPackagePath) ? safeReadJson(rootPackagePath) : null;
const allPackages = Array.from(packageJsonPaths)
  .map((packagePath) => safeReadJson(packagePath))
  .filter(Boolean);
const dependencyNames = new Set();

for (const pkg of allPackages) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const group = pkg[field];
    if (!group || typeof group !== "object") {
      continue;
    }
    for (const name of Object.keys(group)) {
      dependencyNames.add(name);
    }
  }
}

const dependencies = Array.from(dependencyNames);
const hasDependency = (name) => dependencyNames.has(name);
const hasDependencyPrefix = (prefix) => dependencies.some((name) => name.startsWith(prefix));
const packageManager = detectPackageManager();
const scripts = rootPackage && typeof rootPackage.scripts === "object" ? rootPackage.scripts : {};
const pickScript = (candidates) => candidates.find((candidate) => typeof scripts[candidate] === "string") || "";
const rootDirName = basename(root);

let projectName = rootDirName;
let typecheckCmd = "";
let lintCmd = "";
let testCmd = "";
let testRunner = "";
let uiFramework = "";
let designSystem = "";
let summaryPrefix = "";

const pyprojectText = safeReadText(join(root, "pyproject.toml"));
const goModText = safeReadText(join(root, "go.mod"));
const hasRootDenoConfig = existsSync(join(root, "deno.json")) || existsSync(join(root, "deno.jsonc"));

if (rootPackage) {
  summaryPrefix = packageManager;
  if (typeof rootPackage.name === "string" && rootPackage.name.trim()) {
    projectName = rootPackage.name.replace(/^@[^/]+\//, "");
  }

  const typecheckScript = pickScript(["typecheck", "typecheck:all", "type-check", "check-types", "tsc"]);
  if (typecheckScript) {
    typecheckCmd = scriptCommand(packageManager, typecheckScript);
  } else if (hasDependency("typescript")) {
    typecheckCmd = execCommand(packageManager, "tsc", "--noEmit");
  }

  const lintScript = pickScript(["lint", "lint:all"]);
  if (lintScript) {
    lintCmd = scriptCommand(packageManager, lintScript);
  } else if (hasDependency("eslint")) {
    lintCmd = execCommand(packageManager, "eslint", ".");
  }

  const testScript = pickScript(["test", "test:all", "test:ci", "test:unit", "test:vitest", "test:e2e"]);
  if (testScript) {
    testCmd = scriptCommand(packageManager, testScript);
  } else if (hasDependency("vitest")) {
    testCmd = execCommand(packageManager, "vitest", "run");
  } else if (hasDependency("jest")) {
    testCmd = execCommand(packageManager, "jest");
  } else if (hasDependency("@playwright/test")) {
    testCmd = execCommand(packageManager, "playwright", "test");
  }

  const scriptText = `${testCmd} ${Object.values(scripts).join(" ")}`.toLowerCase();
  if (hasDependency("vitest") || scriptText.includes("vitest")) {
    testRunner = "vitest";
  } else if (hasDependency("jest") || scriptText.includes("jest")) {
    testRunner = "jest";
  } else if (scriptText.includes("bun test")) {
    testRunner = "bun test";
  } else if (hasDependency("@playwright/test") || scriptText.includes("playwright")) {
    testRunner = "playwright";
  }

  if (
    hasDependency("react-native") ||
    hasDependency("expo") ||
    hasDependency("react-native-paper") ||
    hasDependency("nativewind")
  ) {
    uiFramework = "react-native";
  } else if (hasDependency("react") || hasDependency("react-dom") || hasDependency("next")) {
    uiFramework = "react";
  } else if (hasDependency("vue") || hasDependency("nuxt")) {
    uiFramework = "vue";
  } else if (hasDependency("svelte") || hasDependency("@sveltejs/kit")) {
    uiFramework = "svelte";
  } else if (hasDependency("solid-js") || hasDependency("solid-start")) {
    uiFramework = "solid";
  } else if (hasDependency("@angular/core")) {
    uiFramework = "angular";
  }

  if (hasDependency("@shadcn/ui") || discoveredFiles.has("components.json")) {
    designSystem = "shadcn/ui";
  } else if (hasDependency("@mui/material")) {
    designSystem = "MUI";
  } else if (hasDependency("@chakra-ui/react")) {
    designSystem = "Chakra UI";
  } else if (hasDependency("@mantine/core")) {
    designSystem = "Mantine";
  } else if (hasDependency("antd")) {
    designSystem = "Ant Design";
  } else if (hasDependency("react-native-paper")) {
    designSystem = "React Native Paper";
  } else if (
    hasDependency("tailwindcss") ||
    hasDependency("@tailwindcss/cli") ||
    hasDependency("@tailwindcss/vite") ||
    discoveredFiles.has("tailwind.config.js") ||
    discoveredFiles.has("tailwind.config.ts") ||
    discoveredFiles.has("tailwind.config.cjs") ||
    discoveredFiles.has("tailwind.config.mjs")
  ) {
    designSystem = "Tailwind CSS";
  } else if (hasDependencyPrefix("@radix-ui/")) {
    designSystem = "Radix UI";
  }
} else if (pyprojectText) {
  summaryPrefix = "python";
  const pyprojectName =
    pyprojectText.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ||
    pyprojectText.match(/^\s*\[project\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  projectName = pyprojectName || rootDirName;
  typecheckCmd = "mypy src";
  lintCmd = "ruff check .";
  testCmd = "pytest";
  testRunner = "pytest";
} else if (goModText) {
  summaryPrefix = "go";
  const moduleName = goModText.match(/^module\s+(.+)$/m)?.[1]?.trim();
  projectName = moduleName ? moduleName.split("/").pop() || rootDirName : rootDirName;
  typecheckCmd = "go vet ./...";
  lintCmd = "golangci-lint run";
  testCmd = "go test ./...";
  testRunner = "go test";
} else if (hasRootDenoConfig) {
  summaryPrefix = "deno";
  typecheckCmd = "deno check .";
  lintCmd = "deno lint";
  testCmd = "deno test";
  testRunner = "deno test";
}

const summary = [summaryPrefix, uiFramework, designSystem, testRunner].filter(Boolean).join(", ");

emit("PROJECT_NAME", projectName);
emit("PACKAGE_MANAGER", packageManager);
emit("TYPECHECK_CMD", typecheckCmd);
emit("LINT_CMD", lintCmd);
emit("TEST_CMD", testCmd);
emit("TEST_RUNNER", testRunner);
emit("UI_FRAMEWORK", uiFramework);
emit("DESIGN_SYSTEM", designSystem);
emit("SUMMARY", summary);
DETECT_EOF
}

# ── Stack presets ─────────────────────────────────────────────────────────────
script_command_for_manager() {
  local package_manager="$1" script_name="$2"
  case "$package_manager" in
    bun) echo "bun run $script_name" ;;
    pnpm) echo "pnpm run $script_name" ;;
    yarn) echo "yarn $script_name" ;;
    *) echo "npm run $script_name" ;;
  esac
}

NODE_PACKAGE_MANAGER="npm"

echo "→ Analyzing project tech stack..."
DETECTED_PROJECT_NAME=""
DETECTED_TYPECHECK_CMD=""
DETECTED_LINT_CMD=""
DETECTED_TEST_CMD=""
DETECTED_TEST_RUNNER=""
DETECTED_UI_FRAMEWORK=""
DETECTED_DESIGN_SYSTEM=""
DETECTED_SUMMARY=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    PROJECT_NAME) DETECTED_PROJECT_NAME="$value" ;;
    PACKAGE_MANAGER) NODE_PACKAGE_MANAGER="$value" ;;
    TYPECHECK_CMD) DETECTED_TYPECHECK_CMD="$value" ;;
    LINT_CMD) DETECTED_LINT_CMD="$value" ;;
    TEST_CMD) DETECTED_TEST_CMD="$value" ;;
    TEST_RUNNER) DETECTED_TEST_RUNNER="$value" ;;
    UI_FRAMEWORK) DETECTED_UI_FRAMEWORK="$value" ;;
    DESIGN_SYSTEM) DETECTED_DESIGN_SYSTEM="$value" ;;
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
  case "$1" in
    node-react)
      TYPECHECK_CMD="$(script_command_for_manager "$NODE_PACKAGE_MANAGER" typecheck)"
      LINT_CMD="$(script_command_for_manager "$NODE_PACKAGE_MANAGER" lint)"
      TEST_CMD="$(script_command_for_manager "$NODE_PACKAGE_MANAGER" test)"
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
BASE_PROJECT_NAME_DEFAULT="${DETECTED_PROJECT_NAME:-$(basename "$PROJECT_ROOT")}"
BASE_TYPECHECK_CMD="${DETECTED_TYPECHECK_CMD:-$(script_command_for_manager "$NODE_PACKAGE_MANAGER" typecheck)}"
BASE_LINT_CMD="${DETECTED_LINT_CMD:-$(script_command_for_manager "$NODE_PACKAGE_MANAGER" lint)}"
BASE_TEST_CMD="${DETECTED_TEST_CMD:-$(script_command_for_manager "$NODE_PACKAGE_MANAGER" test)}"
BASE_TEST_RUNNER="${DETECTED_TEST_RUNNER:-vitest}"
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
COMPLETION_CHECK_CMD_1=""
COMPLETION_CHECK_CMD_2=""
COMPLETION_CHECK_CMD_3=""
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
  PRE_IMPLEMENTATION_MODE="$(get_config_value pre_implementation_mode)"
  COMPLETION_CHECK_CMD_1="$(get_config_value completion_check_cmd_1)"
  COMPLETION_CHECK_CMD_2="$(get_config_value completion_check_cmd_2)"
  COMPLETION_CHECK_CMD_3="$(get_config_value completion_check_cmd_3)"
  TASK_ISOLATION_MODE="$(get_config_value task_isolation_mode)"
  TASK_BASE_BRANCH="$(get_config_value task_base_branch)"
  TASK_MERGE_TARGET="$(get_config_value task_merge_target)"
  TASK_WORKTREE_ROOT="$(get_config_value task_worktree_root)"
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

  [[ -z "$SELECTED_AGENCY_DEFAULT" && -f "$AGENCY_JSON" ]] && SELECTED_AGENCY_DEFAULT="$(get_json_value name "$AGENCY_JSON")"
  [[ -z "$SELECTED_AGENCY_DEFAULT" ]] && SELECTED_AGENCY_DEFAULT="software-studio"
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
  [[ -z "$COMPLETION_CHECK_CMD_1" ]] && COMPLETION_CHECK_CMD_1=""
  [[ -z "$COMPLETION_CHECK_CMD_2" ]] && COMPLETION_CHECK_CMD_2=""
  [[ -z "$COMPLETION_CHECK_CMD_3" ]] && COMPLETION_CHECK_CMD_3=""
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
if [[ -n "$PRE_IMPLEMENTATION_MODE_ARG" ]]; then
  PRE_IMPLEMENTATION_MODE="$PRE_IMPLEMENTATION_MODE_ARG"
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
prompt_with_default "  Pre-implementation mode (minimal|confirm|collaborative)" "$PRE_IMPLEMENTATION_MODE" PRE_IMPLEMENTATION_MODE
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
pre_implementation_mode: $PRE_IMPLEMENTATION_MODE

# Task completion verification — optional ordered commands
completion_check_cmd_1: "$COMPLETION_CHECK_CMD_1"
completion_check_cmd_2: "$COMPLETION_CHECK_CMD_2"
completion_check_cmd_3: "$COMPLETION_CHECK_CMD_3"

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
elif [[ -d "$PROJECT_ROOT/$(adapter_commands_dest_rel opencode)" ]]; then
  echo "  /office-route <task>  — start from the OpenCode adapter"
elif [[ -d "$PROJECT_ROOT/$(adapter_skill_dest_rel claude-code)" ]]; then
  echo "  /office route <task>  — start from the Claude Code adapter"
else
  echo "  ai-office status get <slug> — inspect framework state from the CLI"
fi

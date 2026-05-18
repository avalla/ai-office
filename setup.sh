#!/usr/bin/env bash
# AI Office Framework - Setup Wizard
# Configures a repo-native project office from repository analysis.
# Usage: ./setup.sh [project-root] [flags]
#
# Flags:
#   --auto                  Analyze the repo and generate a custom project office (default)
#   --agency=<name>         Use a legacy preset agency instead of custom office generation
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
NON_INTERACTIVE=false
RECONFIGURE=false
for arg in "$@"; do
  case "$arg" in
    --reconfigure|--force) RECONFIGURE=true ;;
    --auto) AUTO_MODE=true ;;
    --agency=*) AGENCY_ARG="${arg#*=}"; AUTO_MODE=false ;;
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
      if ($0 ~ /^(agency|office_mode|project_name|typecheck_cmd|lint_cmd|test_cmd|test_runner|ui_framework|design_system|coverage_min|lighthouse_min|advance_mode|pre_implementation_mode|interactive_choices_mode|completion_check_cmd_1|completion_check_cmd_2|completion_check_cmd_3|task_isolation_mode|task_base_branch|task_merge_target|task_worktree_root|enable_github_sync|token_budget_mode|token_budget_max_context_files|token_budget_max_roles_per_task|token_budget_max_stage_artifacts|token_budget_max_review_iterations|token_budget_summarize_after_stage):/) {
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
import { basename, join, relative } from "path";

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
  "Dockerfile",
  "deno.json",
  "deno.jsonc",
  "fly.toml",
  "go.mod",
  "netlify.toml",
  "postcss.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "pyproject.toml",
  "supabase",
  "tailwind.config.cjs",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
  "vercel.json",
  "wrangler.toml",
]);
const packageJsonPaths = new Set();
const discoveredFiles = new Set();
const discoveredPaths = new Set();

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
      if (interestingFiles.has(entry) || entry === ".github" || entry === "migrations" || entry === "apps" || entry === "packages") {
        discoveredPaths.add(relative(root, fullPath));
      }
      walk(fullPath, depth + 1);
      continue;
    }

    if (entry === "package.json") {
      packageJsonPaths.add(fullPath);
    }

    if (interestingFiles.has(entry)) {
      discoveredFiles.add(entry);
      discoveredPaths.add(relative(root, fullPath));
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
let language = "";

const pyprojectText = safeReadText(join(root, "pyproject.toml"));
const goModText = safeReadText(join(root, "go.mod"));
const hasRootDenoConfig = existsSync(join(root, "deno.json")) || existsSync(join(root, "deno.jsonc"));

if (rootPackage) {
  summaryPrefix = packageManager;
  language = hasDependency("typescript") || discoveredPaths.has("tsconfig.json") ? "TypeScript" : "JavaScript";
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
  language = "Python";
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
  language = "Go";
  const moduleName = goModText.match(/^module\s+(.+)$/m)?.[1]?.trim();
  projectName = moduleName ? moduleName.split("/").pop() || rootDirName : rootDirName;
  typecheckCmd = "go vet ./...";
  lintCmd = "golangci-lint run";
  testCmd = "go test ./...";
  testRunner = "go test";
} else if (hasRootDenoConfig) {
  summaryPrefix = "deno";
  language = "TypeScript";
  typecheckCmd = "deno check .";
  lintCmd = "deno lint";
  testCmd = "deno test";
  testRunner = "deno test";
}

const hasPath = (pattern) => Array.from(discoveredPaths).some((value) => pattern.test(value));
const hasSupabase = hasDependency("@supabase/supabase-js") || hasPath(/^supabase(\/|$)/) || hasPath(/migrations/i);
const hasPostgres = hasDependency("pg") || hasDependency("postgres") || hasDependency("drizzle-orm") || hasDependency("prisma") || hasSupabase;
const hasUi = Boolean(uiFramework);
const hasInfra = discoveredFiles.has("Dockerfile") || discoveredFiles.has("wrangler.toml") || discoveredFiles.has("vercel.json") || discoveredFiles.has("netlify.toml") || discoveredFiles.has("fly.toml") || hasPath(/^\.github\/workflows\//);
const hasAuth = hasDependency("next-auth") || hasDependency("@clerk/nextjs") || hasDependency("@auth/core") || hasSupabase;
const hasPayments = hasDependency("stripe") || hasDependency("@stripe/stripe-js");
const hasMonorepo = hasPath(/^(apps|packages)\//) || Boolean(rootPackage?.workspaces);
let projectType = "software project";
if (hasSupabase) {
  projectType = "Supabase/Postgres application";
} else if (hasUi && !hasPostgres) {
  projectType = "frontend application";
} else if (hasInfra && !hasUi) {
  projectType = "infra-heavy project";
} else if (rootPackage) {
  projectType = "TypeScript/JavaScript application";
} else if (pyprojectText) {
  projectType = "Python application";
} else if (goModText) {
  projectType = "Go application";
}

let pipeline = "request -> clarify -> PRD -> architecture -> plan -> implementation -> tests -> review -> release";
if (hasSupabase) {
  pipeline = "request -> data model -> RLS/security design -> migration plan -> pgTAP tests -> implementation -> QA -> review -> release";
} else if (hasUi && !hasPostgres) {
  pipeline = "request -> UX notes -> component plan -> implementation -> visual QA -> accessibility review -> release";
} else if (hasInfra) {
  pipeline = "request -> risk assessment -> architecture -> runbook -> dry-run -> implementation -> validation -> rollback plan -> release";
}

const roles = ["product", "architect", "developer", "qa", "reviewer"];
if (hasSupabase) roles.push("database-security");
if (hasUi) roles.push("ux");
if (hasInfra) roles.push("ops");
if (hasAuth || hasPayments) roles.push("security");

const riskAreas = [];
if (hasAuth) riskAreas.push("auth");
if (hasPayments) riskAreas.push("payments");
if (hasSupabase) riskAreas.push("RLS", "migrations");
if (hasInfra) riskAreas.push("infra");
if (hasPath(/\.env/i)) riskAreas.push("secrets");
if (riskAreas.length === 0) riskAreas.push("general correctness");

const qualityGates = ["typecheck", "lint", "tests", "review"];
if (hasUi) qualityGates.push("visual QA", "accessibility");
if (hasSupabase) qualityGates.push("migration review", "RLS review");
if (hasInfra) qualityGates.push("dry-run", "rollback plan");
if (hasAuth || hasPayments) qualityGates.push("security review");

const signals = [
  `package manager: ${packageManager}`,
  language ? `language: ${language}` : "",
  uiFramework ? `frontend: ${uiFramework}` : "",
  designSystem ? `design system: ${designSystem}` : "",
  testRunner ? `test runner: ${testRunner}` : "",
  hasMonorepo ? "monorepo: yes" : "",
  hasSupabase ? "supabase/postgres: yes" : "",
  hasInfra ? "deployment/infra hints: yes" : "",
].filter(Boolean);
const summary = [summaryPrefix, uiFramework, designSystem, testRunner].filter(Boolean).join(", ");

emit("PROJECT_NAME", projectName);
emit("PACKAGE_MANAGER", packageManager);
emit("LANGUAGE", language);
emit("PROJECT_TYPE", projectType);
emit("TYPECHECK_CMD", typecheckCmd);
emit("LINT_CMD", lintCmd);
emit("TEST_CMD", testCmd);
emit("TEST_RUNNER", testRunner);
emit("UI_FRAMEWORK", uiFramework);
emit("DESIGN_SYSTEM", designSystem);
emit("PIPELINE", pipeline);
emit("ROLES", roles.join(","));
emit("RISK_AREAS", riskAreas.join(", "));
emit("QUALITY_GATES", qualityGates.join(", "));
emit("REPOSITORY_SIGNALS", signals.join("; "));
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
DETECTED_LANGUAGE=""
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
SELECTED_AGENCY_DEFAULT="custom-office"
OFFICE_MODE="custom"
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
CREATED_DATE=""
EXTRA_FRONTMATTER_LINES=""
NOTES_BLOCK="> Add project-specific context here — tech decisions, constraints, key stakeholders."

if [[ "$CONFIG_EXISTS" == true ]]; then
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
  [[ -z "$SELECTED_AGENCY_DEFAULT" ]] && SELECTED_AGENCY_DEFAULT="custom-office"
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
  OFFICE_MODE="custom"
elif [[ -n "$AGENCY_ARG" ]]; then
  SELECTED_AGENCY="$AGENCY_ARG"
  OFFICE_MODE="legacy-preset"
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
  OFFICE_MODE="legacy-preset"
fi
echo "  → Office mode: $OFFICE_MODE"
if [[ "$OFFICE_MODE" == "legacy-preset" ]]; then
  echo "  → Legacy agency preset: $SELECTED_AGENCY"
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
office_mode: $OFFICE_MODE
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
$([[ -n "$EXTRA_FRONTMATTER_BLOCK" ]] && printf '\n\n%s' "$EXTRA_FRONTMATTER_BLOCK")

# Optional: skip pipeline stages for this project
# skip_stages: []
---

# Project Configuration

**Project:** $PROJECT_NAME
**Office mode:** $OFFICE_MODE
**Legacy agency preset:** $SELECTED_AGENCY
**Created:** $WRITTEN_CREATED_DATE

## Notes

$NOTES_BLOCK
EOF

if [[ "$CONFIG_EXISTS" == true ]]; then
  echo "  ✅ Updated .ai-office/project.config.md"
else
  echo "  ✅ Created .ai-office/project.config.md"
fi

# ── Generate custom project office artifacts ─────────────────────────────────
write_role_file() {
  local role_slug="$1"
  local role_title
  role_title="$(echo "$role_slug" | sed 's/-/ /g' | awk '{ for (i=1; i<=NF; i++) $i=toupper(substr($i,1,1)) substr($i,2); print }')"
  local role_path="$AI_OFFICE/roles/$role_slug.md"
  local purpose="Own the $role_slug perspective for the current pipeline stage."
  local invoke="Invoke only when the current stage needs this role's specific judgement."
  local inputs="Current request, office-profile.md, pipeline.md, current stage artifact, and no more than one supporting file unless required."
  local outputs="Short findings, concrete next action, changed artifact paths, and evidence required for the next gate."
  local stop="Stop when the stage output is complete, required evidence is missing, or risk exceeds the role mandate."

  case "$role_slug" in
    product)
      purpose="Clarify user value, scope, acceptance criteria, and tradeoffs."
      ;;
    architect)
      purpose="Select the smallest defensible technical approach for the detected stack."
      ;;
    developer)
      purpose="Implement focused changes that match the generated pipeline and local code patterns."
      ;;
    qa)
      purpose="Verify acceptance criteria with deterministic checks and regression coverage."
      ;;
    reviewer)
      purpose="Find correctness, maintainability, and release risks before handoff."
      ;;
    database-security)
      purpose="Review schema, migrations, RLS, policies, and data access boundaries."
      invoke="Invoke for Supabase/Postgres schema, migration, RLS, or data-permission work."
      ;;
    ux)
      purpose="Review user flows, component behavior, visual quality, and accessibility."
      invoke="Invoke for UI, copy, design-system, accessibility, or visual QA work."
      ;;
    ops)
      purpose="Review deployment, CI, infra, dry-run, validation, and rollback concerns."
      invoke="Invoke for Docker, hosting, CI, Cloudflare, Vercel, Netlify, or operational changes."
      ;;
    security)
      purpose="Review auth, payments, secrets, permissions, and sensitive control paths."
      invoke="Invoke for auth, billing, secrets, permissions, or security-sensitive changes."
      ;;
  esac

  cat > "$role_path" <<EOF
# Role: $role_title

## Purpose
$purpose

## When to invoke
$invoke

## Inputs required
$inputs

## Outputs
$outputs

## Token budget
Load only this role, current stage artifact, and up to $TOKEN_BUDGET_MAX_CONTEXT_FILES total context files. Prefer summaries over full history.

## Stop conditions
$stop
EOF
}

generate_custom_office() {
  local roles_csv="${DETECTED_ROLES:-product,architect,developer,qa,reviewer}"
  local pipeline="${DETECTED_PIPELINE:-request -> clarify -> PRD -> architecture -> plan -> implementation -> tests -> review -> release}"
  local project_type="${DETECTED_PROJECT_TYPE:-software project}"
  local signals="${DETECTED_REPOSITORY_SIGNALS:-package manager: $NODE_PACKAGE_MANAGER}"
  local gates="${DETECTED_QUALITY_GATES:-typecheck, lint, tests, review}"
  local risks="${DETECTED_RISK_AREAS:-general correctness}"

  mkdir -p "$AI_OFFICE/roles"

  cat > "$AI_OFFICE/office-profile.md" <<EOF
# Office Profile

## Project Type
$project_type

## Detected Stack
- Language: ${DETECTED_LANGUAGE:-unknown}
- Package manager: $NODE_PACKAGE_MANAGER
- UI framework: ${UI_FRAMEWORK:-none detected}
- Design system: ${DESIGN_SYSTEM:-none detected}
- Test runner: ${TEST_RUNNER:-none detected}

## Repository Signals
$signals

## Recommended Workflow
$pipeline

## Recommended Roles
$roles_csv

## Quality Gates
$gates

## Risk Areas
$risks

## Token Efficiency Rules
- never load all roles
- never load all historical docs
- load only current stage artifacts
- prefer summaries over full conversations
- use deterministic CLI for state changes
- summarize completed stages into status files
- cap review/QA loops
- ask for missing files only when necessary
EOF

  cat > "$AI_OFFICE/pipeline.md" <<EOF
# Project Pipeline

## Default Flow
$pipeline

## Operating Rules
- Use the current stage artifact as the primary context.
- Run deterministic CLI commands for task and status state changes.
- Record evidence in status files before advancing.
- Stop after $TOKEN_BUDGET_MAX_REVIEW_ITERATIONS review or QA loops and escalate with unblock criteria.
EOF

  cat > "$AI_OFFICE/quality-gates.md" <<EOF
# Quality Gates

## Project-Specific Gates
$gates

## Verification Commands
- Typecheck: $TYPECHECK_CMD
- Lint: $LINT_CMD
- Test: $TEST_CMD

## Risk Gates
$risks
EOF

  rm -f "$AI_OFFICE/roles"/*.md
  IFS=',' read -ra role_items <<< "$roles_csv"
  for role in "${role_items[@]}"; do
    role="$(echo "$role" | xargs)"
    [[ -n "$role" ]] && write_role_file "$role"
  done

  echo "  ✅ Generated .ai-office/office-profile.md"
  echo "  ✅ Generated .ai-office/pipeline.md"
  echo "  ✅ Generated .ai-office/quality-gates.md"
  echo "  ✅ Generated .ai-office/roles/*.md"
}

generate_custom_office

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

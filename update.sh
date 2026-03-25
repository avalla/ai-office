#!/usr/bin/env bash
# AI Office Framework — Updater
# Usage: ./update.sh [project-root] [--adapter=<codex|windsurf|claude-code|opencode|base>] [--prune-legacy]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SKELETON="$FRAMEWORK_DIR/skeleton/core"
AVAILABLE="$(cat "$FRAMEWORK_DIR/VERSION")"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun is required to update AI Office from source"
  exit 1
fi

eval "$(bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" emit-shell-metadata)"

PROJECT_ROOT_ARG=""
ADAPTER_ARG=""
PRUNE_LEGACY=false

for arg in "$@"; do
  case "$arg" in
    --adapter=*) ADAPTER_ARG="${arg#*=}" ;;
    --prune-legacy) PRUNE_LEGACY=true ;;
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
INSTALL_META="$AI_OFFICE/install.json"

validate_adapter() {
  local adapter="$1"
  if ! adapter_exists "$adapter"; then
    echo "❌ Unknown adapter: $adapter"
    echo "Available adapters:"
    for adapter_name in "${AI_OFFICE_ADAPTERS[@]}"; do
      echo "  - $adapter_name"
    done
    exit 1
  fi
}

json_value() {
  local key="$1" file="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1
}

adapter_project_abs() {
  local rel="$1"
  if [[ -n "$rel" ]]; then
    echo "$PROJECT_ROOT/$rel"
  fi
}

adapter_version_file() {
  local rel
  rel="$(adapter_version_file_rel "$1")"
  if [[ -n "$rel" ]]; then
    echo "$PROJECT_ROOT/$rel"
  fi
}

write_install_metadata() {
  local adapter="$1"
  mkdir -p "$AI_OFFICE"
  cat > "$INSTALL_META" <<EOF
{
  "schemaVersion": 1,
  "version": "$AVAILABLE",
  "adapter": "$adapter",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

INSTALLED="unknown"
INSTALLED_ADAPTER=""

if [[ -f "$INSTALL_META" ]]; then
  INSTALLED="$(json_value version "$INSTALL_META")"
  INSTALLED_ADAPTER="$(json_value adapter "$INSTALL_META")"
fi

if [[ -z "$INSTALLED_ADAPTER" ]]; then
  for adapter in windsurf codex claude-code opencode; do
    version_file="$(adapter_version_file "$adapter")"
    if [[ -n "$version_file" && -f "$version_file" ]]; then
      INSTALLED_ADAPTER="$adapter"
      INSTALLED="$(cat "$version_file" 2>/dev/null || echo "unknown")"
      break
    fi
  done
fi

if [[ -z "$INSTALLED_ADAPTER" ]]; then
  windsurf_rules_dir="$(adapter_project_abs "$(adapter_rules_dest_rel windsurf)")"
  windsurf_workflows_dir="$(adapter_project_abs "$(adapter_workflows_dest_rel windsurf)")"
  codex_skills_dir="$(adapter_project_abs "$(adapter_skill_dest_rel codex)")"
  claude_skills_dir="$(adapter_project_abs "$(adapter_skill_dest_rel claude-code)")"
  opencode_commands_dir="$(adapter_project_abs "$(adapter_commands_dest_rel opencode)")"
  if [[ -d "$windsurf_workflows_dir" || -d "$windsurf_rules_dir" ]]; then
    INSTALLED_ADAPTER="windsurf"
  elif [[ -f "$PROJECT_ROOT/$(adapter_instruction_target codex)" || -d "$codex_skills_dir" ]]; then
    INSTALLED_ADAPTER="codex"
  elif [[ -f "$PROJECT_ROOT/$(adapter_instruction_target claude-code)" || -d "$claude_skills_dir" || -f "$PROJECT_ROOT/.claude/CLAUDE.md" ]]; then
    INSTALLED_ADAPTER="claude-code"
  elif [[ -f "$PROJECT_ROOT/$(adapter_instruction_target opencode)" || -d "$opencode_commands_dir" ]]; then
    INSTALLED_ADAPTER="opencode"
  else
    INSTALLED_ADAPTER="base"
  fi
fi

TARGET_ADAPTER="${ADAPTER_ARG:-$INSTALLED_ADAPTER}"
validate_adapter "$TARGET_ADAPTER"

echo "AI Office Framework — Update"
echo ""
echo "  Installed version : ${INSTALLED:-unknown}"
echo "  Installed adapter : ${INSTALLED_ADAPTER:-unknown}"
echo "  Available version : $AVAILABLE"
echo "  Target adapter    : $TARGET_ADAPTER"
echo ""

version_gt() {
  [[ "$1" != "$2" ]] && [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]
}

preview_wrapper_changes() {
  local adapter="$1"
  local kind
  kind="$(adapter_kind "$adapter")"

  case "$kind" in
    skills)
      echo "  ~ regenerates $(adapter_skill_dest_rel "$adapter") from the neutral adapter manifest"
      ;;
    commands)
      echo "  ~ regenerates $(adapter_commands_dest_rel "$adapter") from the neutral adapter manifest"
      ;;
    rules-workflows)
      echo "  ~ regenerates $(adapter_rules_dest_rel "$adapter") and $(adapter_workflows_dest_rel "$adapter") from the neutral adapter manifest"
      ;;
    *)
      echo "  - base adapter uses no host-specific wrapper files"
      ;;
  esac
}

update_adapter_assets() {
  local adapter="$1"
  local kind
  kind="$(adapter_kind "$adapter")"

  case "$kind" in
    skills)
      bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" install \
        --framework-dir "$FRAMEWORK_DIR" \
        --project-root "$PROJECT_ROOT" \
        --adapter "$adapter" \
        --instruction-mode if-missing >/dev/null
      echo "  ✅ $adapter skills updated"
      ;;
    commands)
      bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" install \
        --framework-dir "$FRAMEWORK_DIR" \
        --project-root "$PROJECT_ROOT" \
        --adapter "$adapter" \
        --instruction-mode if-missing >/dev/null
      echo "  ✅ $adapter commands updated"
      ;;
    rules-workflows)
      bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" install \
        --framework-dir "$FRAMEWORK_DIR" \
        --project-root "$PROJECT_ROOT" \
        --adapter "$adapter" \
        --instruction-mode if-missing >/dev/null
      echo "  ✅ $adapter rules and workflows updated"
      ;;
    *)
      echo "  ✅ Base adapter requires no host-specific assets"
      ;;
  esac
}

preview_prune_legacy() {
  local target_adapter="$1"
  local target_instruction
  local any_change=0
  target_instruction="$(adapter_instruction_target "$target_adapter")"

  for adapter in "${AI_OFFICE_ADAPTERS[@]}"; do
    [[ "$adapter" == "$target_adapter" ]] && continue

    local version_file instruction_target skill_dir command_dir workflow_dir rules_dir legacy
    version_file="$(adapter_version_file "$adapter")"
    if [[ -n "$version_file" && -f "$version_file" ]]; then
      echo "  - prune ${version_file#$PROJECT_ROOT/}"
      any_change=1
    fi

    instruction_target="$(adapter_instruction_target "$adapter")"
    if [[ -n "$instruction_target" && "$instruction_target" != "$target_instruction" && -f "$PROJECT_ROOT/$instruction_target" ]]; then
      echo "  - prune $instruction_target"
      any_change=1
    fi

    skill_dir="$(adapter_project_abs "$(adapter_skill_dest_rel "$adapter")")"
    if [[ -n "$skill_dir" && -d "$skill_dir" ]]; then
      for legacy in "$skill_dir"/office*; do
        [[ -e "$legacy" ]] || continue
        echo "  - prune ${legacy#$PROJECT_ROOT/}"
        any_change=1
      done
    fi

    command_dir="$(adapter_project_abs "$(adapter_commands_dest_rel "$adapter")")"
    if [[ -n "$command_dir" && -d "$command_dir" ]]; then
      for legacy in "$command_dir"/office*.md; do
        [[ -e "$legacy" ]] || continue
        echo "  - prune ${legacy#$PROJECT_ROOT/}"
        any_change=1
      done
    fi

    rules_dir="$(adapter_project_abs "$(adapter_rules_dest_rel "$adapter")")"
    if [[ -n "$rules_dir" && -f "$rules_dir/ai-office-workspace.md" ]]; then
      echo "  - prune ${rules_dir#$PROJECT_ROOT/}/ai-office-workspace.md"
      any_change=1
    fi

    workflow_dir="$(adapter_project_abs "$(adapter_workflows_dest_rel "$adapter")")"
    if [[ -n "$workflow_dir" && -d "$workflow_dir" ]]; then
      for legacy in "$workflow_dir"/office*.md; do
        [[ -e "$legacy" ]] || continue
        echo "  - prune ${legacy#$PROJECT_ROOT/}"
        any_change=1
      done
    fi
  done

  if [[ -f "$PROJECT_ROOT/.claude/CLAUDE.md" ]]; then
    echo "  - prune .claude/CLAUDE.md"
    any_change=1
  fi

  if [[ -d "$PROJECT_ROOT/.claude/commands" ]]; then
    for legacy in "$PROJECT_ROOT/.claude/commands"/office* "$PROJECT_ROOT/.claude/commands"/office*.md; do
      [[ -e "$legacy" ]] || continue
      echo "  - prune ${legacy#$PROJECT_ROOT/}"
      any_change=1
    done
  fi

  if [[ "$any_change" -eq 0 ]]; then
    echo "  (no legacy AI Office artifacts detected)"
  fi
}

prune_legacy_assets() {
  local target_adapter="$1"
  local target_instruction
  target_instruction="$(adapter_instruction_target "$target_adapter")"

  for adapter in "${AI_OFFICE_ADAPTERS[@]}"; do
    [[ "$adapter" == "$target_adapter" ]] && continue

    local version_file instruction_target skill_dir command_dir workflow_dir rules_dir legacy
    version_file="$(adapter_version_file "$adapter")"
    if [[ -n "$version_file" && -f "$version_file" ]]; then
      rm -f "$version_file"
    fi

    instruction_target="$(adapter_instruction_target "$adapter")"
    if [[ -n "$instruction_target" && "$instruction_target" != "$target_instruction" && -f "$PROJECT_ROOT/$instruction_target" ]]; then
      rm -f "$PROJECT_ROOT/$instruction_target"
    fi

    skill_dir="$(adapter_project_abs "$(adapter_skill_dest_rel "$adapter")")"
    if [[ -n "$skill_dir" && -d "$skill_dir" ]]; then
      for legacy in "$skill_dir"/office*; do
        [[ -e "$legacy" ]] || continue
        rm -rf "$legacy"
      done
      rmdir "$skill_dir" 2>/dev/null || true
      rmdir "$(dirname "$skill_dir")" 2>/dev/null || true
    fi

    command_dir="$(adapter_project_abs "$(adapter_commands_dest_rel "$adapter")")"
    if [[ -n "$command_dir" && -d "$command_dir" ]]; then
      for legacy in "$command_dir"/office*.md; do
        [[ -e "$legacy" ]] || continue
        rm -f "$legacy"
      done
      rmdir "$command_dir" 2>/dev/null || true
      rmdir "$(dirname "$command_dir")" 2>/dev/null || true
    fi

    rules_dir="$(adapter_project_abs "$(adapter_rules_dest_rel "$adapter")")"
    if [[ -n "$rules_dir" ]]; then
      rm -f "$rules_dir/ai-office-workspace.md"
      rmdir "$rules_dir" 2>/dev/null || true
    fi

    workflow_dir="$(adapter_project_abs "$(adapter_workflows_dest_rel "$adapter")")"
    if [[ -n "$workflow_dir" && -d "$workflow_dir" ]]; then
      for legacy in "$workflow_dir"/office*.md; do
        [[ -e "$legacy" ]] || continue
        rm -f "$legacy"
      done
      rmdir "$workflow_dir" 2>/dev/null || true
    fi
  done

  rm -f "$PROJECT_ROOT/.claude/CLAUDE.md"
  if [[ -d "$PROJECT_ROOT/.claude/commands" ]]; then
    rm -rf "$PROJECT_ROOT/.claude/commands"/office*
    rm -f "$PROJECT_ROOT/.claude/commands"/office*.md
    rmdir "$PROJECT_ROOT/.claude/commands" 2>/dev/null || true
  fi
}

if [[ "$PRUNE_LEGACY" != true && "${INSTALLED:-unknown}" == "$AVAILABLE" && "$INSTALLED_ADAPTER" == "$TARGET_ADAPTER" ]]; then
  echo "✅ Already up to date (v$AVAILABLE, adapter $TARGET_ADAPTER)"
  exit 0
fi

if [[ "${INSTALLED:-unknown}" == "unknown" ]]; then
  echo "⚠️  Installed version unknown — proceeding with update"
elif version_gt "$INSTALLED" "$AVAILABLE"; then
  echo "⚠️  Installed version ($INSTALLED) is newer than framework source ($AVAILABLE)"
  read -p "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
fi

echo "Changes to apply:"
if [[ ! -f "$PROJECT_ROOT/AI-OFFICE.md" ]]; then
  echo "  + AI-OFFICE.md (core guide)"
elif ! diff -q "$CORE_SKELETON/AI-OFFICE.md" "$PROJECT_ROOT/AI-OFFICE.md" > /dev/null 2>&1; then
  echo "  ~ AI-OFFICE.md (core guide differs; will not overwrite existing file)"
fi

preview_wrapper_changes "$TARGET_ADAPTER"

instruction_target="$(adapter_instruction_target "$TARGET_ADAPTER")"
if [[ -n "$instruction_target" && ! -f "$PROJECT_ROOT/$instruction_target" ]]; then
  echo "  + $instruction_target"
fi
if [[ "$PRUNE_LEGACY" == true ]]; then
  echo "Legacy AI Office artifacts to prune:"
  preview_prune_legacy "$TARGET_ADAPTER"
fi
echo ""

read -p "Apply update ${INSTALLED:-unknown} → $AVAILABLE for adapter $TARGET_ADAPTER? [Y/n] " confirm
[[ "$confirm" =~ ^[Nn]$ ]] && echo "Aborted." && exit 0

echo ""
echo "→ Updating core metadata..."
mkdir -p "$AI_OFFICE"
write_install_metadata "$TARGET_ADAPTER"
echo "  ✅ install.json updated"

if [[ ! -f "$PROJECT_ROOT/AI-OFFICE.md" ]]; then
  cp "$CORE_SKELETON/AI-OFFICE.md" "$PROJECT_ROOT/AI-OFFICE.md"
  echo "  ✅ AI-OFFICE.md installed"
fi

if [[ ! -f "$PROJECT_ROOT/.mcp.json" ]]; then
  cp "$CORE_SKELETON/.mcp.json" "$PROJECT_ROOT/.mcp.json"
  echo "  ✅ .mcp.json installed"
fi

echo "→ Updating adapter assets..."
update_adapter_assets "$TARGET_ADAPTER"

if [[ "$PRUNE_LEGACY" == true ]]; then
  echo "→ Pruning legacy AI Office artifacts..."
  prune_legacy_assets "$TARGET_ADAPTER"
  echo "  ✅ Legacy adapter artifacts pruned"
elif [[ -d "$PROJECT_ROOT/.claude/commands/office" ]]; then
  rm -rf "$PROJECT_ROOT/.claude/commands/office"
  rmdir "$PROJECT_ROOT/.claude/commands" 2>/dev/null || true
  echo "  🗑️  Removed legacy .claude/commands/office/"
fi

echo "→ Checking .ai-office/ structure..."
for dir in \
  "$AI_OFFICE/tasks/BACKLOG" "$AI_OFFICE/tasks/TODO" "$AI_OFFICE/tasks/WIP" \
  "$AI_OFFICE/tasks/REVIEW" "$AI_OFFICE/tasks/BLOCKED" "$AI_OFFICE/tasks/REJECTED" "$AI_OFFICE/tasks/DONE" "$AI_OFFICE/tasks/ARCHIVED" \
  "$AI_OFFICE/docs/prd" "$AI_OFFICE/docs/adr" "$AI_OFFICE/docs/runbooks" \
  "$AI_OFFICE/agents" "$AI_OFFICE/agencies" "$AI_OFFICE/milestones" "$AI_OFFICE/scripts" "$AI_OFFICE/memory"
do
  mkdir -p "$dir"
done
echo "  ✅ Structure OK"

echo ""
echo "✅ Updated to v$AVAILABLE ($TARGET_ADAPTER)"
echo ""
echo "See CHANGELOG.md for what changed."

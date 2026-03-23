#!/usr/bin/env bash
# AI Office Framework — Updater
# Usage: ./update.sh [project-root] [--adapter=<codex|windsurf|claude-code|base>]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SKELETON="$FRAMEWORK_DIR/skeleton/core"
AVAILABLE="$(cat "$FRAMEWORK_DIR/VERSION")"
source "$FRAMEWORK_DIR/generated/adapter-metadata.sh"

PROJECT_ROOT_ARG=""
ADAPTER_ARG=""

for arg in "$@"; do
  case "$arg" in
    --adapter=*) ADAPTER_ARG="${arg#*=}" ;;
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

adapter_source_abs() {
  local rel="$1"
  if [[ -n "$rel" ]]; then
    echo "$FRAMEWORK_DIR/$rel"
  fi
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

stamp_adapter_version() {
  local adapter="$1"
  local version_file
  version_file="$(adapter_version_file "$adapter")"
  if [[ -z "$version_file" ]]; then
    return
  fi
  mkdir -p "$(dirname "$version_file")"
  echo "$AVAILABLE" > "$version_file"
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

get_file_version() {
  grep -m1 'ai-office-version:' "$1" 2>/dev/null \
    | sed 's/.*ai-office-version:[[:space:]]*//' \
    | tr -d ' -->' \
    || echo ""
}

INSTALLED="unknown"
INSTALLED_ADAPTER=""

if [[ -f "$INSTALL_META" ]]; then
  INSTALLED="$(json_value version "$INSTALL_META")"
  INSTALLED_ADAPTER="$(json_value adapter "$INSTALL_META")"
fi

if [[ -z "$INSTALLED_ADAPTER" ]]; then
  for adapter in windsurf codex claude-code; do
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
  if [[ -d "$windsurf_workflows_dir" || -d "$windsurf_rules_dir" ]]; then
    INSTALLED_ADAPTER="windsurf"
  elif [[ -f "$PROJECT_ROOT/$(adapter_instruction_target codex)" || -d "$codex_skills_dir" ]]; then
    INSTALLED_ADAPTER="codex"
  elif [[ -f "$PROJECT_ROOT/$(adapter_instruction_target claude-code)" || -d "$claude_skills_dir" || -f "$PROJECT_ROOT/.claude/CLAUDE.md" ]]; then
    INSTALLED_ADAPTER="claude-code"
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
      local skill_src_dir skill_dst_dir any_change src_dir skill_name src dst src_ver dst_ver
      skill_src_dir="$(adapter_source_abs "$(adapter_skill_source_rel "$adapter")")"
      skill_dst_dir="$(adapter_project_abs "$(adapter_skill_dest_rel "$adapter")")"
      any_change=0
      for src_dir in "$skill_src_dir"/office*/; do
        skill_name="$(basename "$src_dir")"
        src="$src_dir/SKILL.md"
        dst="$skill_dst_dir/$skill_name/SKILL.md"
        if [[ ! -f "$dst" ]]; then
          echo "  + $skill_name (new)"
          any_change=1
        else
          src_ver="$(get_file_version "$src")"
          dst_ver="$(get_file_version "$dst")"
          if [[ -n "$src_ver" && -n "$dst_ver" && "$src_ver" != "$dst_ver" ]]; then
            echo "  ~ $skill_name (v$dst_ver → v$src_ver)"
            any_change=1
          elif ! diff -q "$src" "$dst" > /dev/null 2>&1; then
            echo "  ~ $skill_name (changed)"
            any_change=1
          fi
        fi
      done
      if [[ "$any_change" -eq 0 ]]; then
        echo "  (no adapter skill files changed)"
      fi
      ;;
    rules-workflows)
      local rules_src_dir rules_dst_dir workflows_src_dir workflows_dst_dir any_change src name dst
      rules_src_dir="$(adapter_source_abs "$(adapter_rules_source_rel "$adapter")")"
      rules_dst_dir="$(adapter_project_abs "$(adapter_rules_dest_rel "$adapter")")"
      workflows_src_dir="$(adapter_source_abs "$(adapter_workflows_source_rel "$adapter")")"
      workflows_dst_dir="$(adapter_project_abs "$(adapter_workflows_dest_rel "$adapter")")"
      any_change=0
      for src in "$rules_src_dir/"*.md "$workflows_src_dir/"*.md; do
        name="$(basename "$src")"
        if [[ "$src" == "$rules_src_dir/"* ]]; then
          dst="$rules_dst_dir/$name"
        else
          dst="$workflows_dst_dir/$name"
        fi
        if [[ ! -f "$dst" ]]; then
          echo "  + $name (new)"
          any_change=1
        elif ! diff -q "$src" "$dst" > /dev/null 2>&1; then
          echo "  ~ $name (changed)"
          any_change=1
        fi
      done
      if [[ "$any_change" -eq 0 ]]; then
        echo "  (no rules or workflow files changed)"
      fi
      ;;
    *)
      echo "  - base adapter uses no host-specific wrapper files"
      ;;
  esac
}

install_instruction_if_missing() {
  local adapter="$1"
  local instruction_target instruction_source
  instruction_target="$(adapter_instruction_target "$adapter")"
  instruction_source="$(adapter_source_abs "$(adapter_instruction_source_rel "$adapter")")"
  if [[ -z "$instruction_target" || -z "$instruction_source" ]]; then
    return
  fi
  if [[ ! -f "$PROJECT_ROOT/$instruction_target" ]]; then
    cp "$instruction_source" "$PROJECT_ROOT/$instruction_target"
    echo "  ✅ $instruction_target installed"
  fi
}

update_adapter_assets() {
  local adapter="$1"
  local kind
  kind="$(adapter_kind "$adapter")"

  case "$kind" in
    skills)
      local source dest
      source="$(adapter_source_abs "$(adapter_skill_source_rel "$adapter")")"
      dest="$(adapter_project_abs "$(adapter_skill_dest_rel "$adapter")")"
      mkdir -p "$dest"
      cp -r "$source/"* "$dest/"
      stamp_adapter_version "$adapter"
      echo "  ✅ $adapter skills updated"
      install_instruction_if_missing "$adapter"
      ;;
    rules-workflows)
      local rules_source rules_dest workflows_source workflows_dest
      rules_source="$(adapter_source_abs "$(adapter_rules_source_rel "$adapter")")"
      rules_dest="$(adapter_project_abs "$(adapter_rules_dest_rel "$adapter")")"
      workflows_source="$(adapter_source_abs "$(adapter_workflows_source_rel "$adapter")")"
      workflows_dest="$(adapter_project_abs "$(adapter_workflows_dest_rel "$adapter")")"
      mkdir -p "$rules_dest" "$workflows_dest"
      cp -r "$rules_source/"* "$rules_dest/"
      cp -r "$workflows_source/"* "$workflows_dest/"
      stamp_adapter_version "$adapter"
      echo "  ✅ $adapter rules and workflows updated"
      install_instruction_if_missing "$adapter"
      ;;
    *)
      echo "  ✅ Base adapter requires no host-specific assets"
      ;;
  esac
}

if [[ "${INSTALLED:-unknown}" == "$AVAILABLE" && "$INSTALLED_ADAPTER" == "$TARGET_ADAPTER" ]]; then
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

if [[ -d "$PROJECT_ROOT/.claude/commands/office" ]]; then
  rm -rf "$PROJECT_ROOT/.claude/commands/office"
  rmdir "$PROJECT_ROOT/.claude/commands" 2>/dev/null || true
  echo "  🗑️  Removed legacy .claude/commands/office/"
fi

echo "→ Checking .ai-office/ structure..."
for dir in \
  "$AI_OFFICE/tasks/BACKLOG" "$AI_OFFICE/tasks/TODO" "$AI_OFFICE/tasks/WIP" \
  "$AI_OFFICE/tasks/REVIEW" "$AI_OFFICE/tasks/BLOCKED" "$AI_OFFICE/tasks/DONE" "$AI_OFFICE/tasks/ARCHIVED" \
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

#!/usr/bin/env bash
# AI Office Framework — Updater
# Usage: ./update.sh [project-root] [--adapter=<codex|windsurf|claude-code|base>]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SKELETON="$FRAMEWORK_DIR/skeleton/core"
ADAPTERS_DIR="$FRAMEWORK_DIR/skeleton/adapters"
AVAILABLE="$(cat "$FRAMEWORK_DIR/VERSION")"

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
  if [[ ! -d "$ADAPTERS_DIR/$adapter" ]]; then
    echo "❌ Unknown adapter: $adapter"
    echo "Available adapters:"
    for adapter_dir in "$ADAPTERS_DIR"/*/; do
      echo "  - $(basename "$adapter_dir")"
    done
    exit 1
  fi
}

json_value() {
  local key="$1" file="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1
}

adapter_version_file() {
  local adapter="$1"
  case "$adapter" in
    codex) echo "$PROJECT_ROOT/.codex/skills/.version" ;;
    windsurf) echo "$PROJECT_ROOT/.windsurf/.version" ;;
    claude-code) echo "$PROJECT_ROOT/.claude/skills/.version" ;;
    base) echo "" ;;
  esac
}

adapter_instruction_target() {
  local adapter="$1"
  case "$adapter" in
    codex) echo "AGENTS.md" ;;
    windsurf) echo "AGENTS.md" ;;
    claude-code) echo "CLAUDE.md" ;;
    base) echo "AI-OFFICE.md" ;;
  esac
}

adapter_skill_source_dir() {
  local adapter="$1"
  case "$adapter" in
    codex) echo "$ADAPTERS_DIR/$adapter/.codex/skills" ;;
    windsurf) echo "" ;;
    claude-code) echo "$ADAPTERS_DIR/$adapter/.claude/skills" ;;
    base) echo "" ;;
  esac
}

adapter_skill_dest_dir() {
  local adapter="$1"
  case "$adapter" in
    codex) echo "$PROJECT_ROOT/.codex/skills" ;;
    windsurf) echo "" ;;
    claude-code) echo "$PROJECT_ROOT/.claude/skills" ;;
    base) echo "" ;;
  esac
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
  if [[ -f "$PROJECT_ROOT/.windsurf/.version" ]]; then
    INSTALLED_ADAPTER="windsurf"
    INSTALLED="$(cat "$PROJECT_ROOT/.windsurf/.version" 2>/dev/null || echo "unknown")"
  elif [[ -f "$PROJECT_ROOT/.codex/skills/.version" ]]; then
    INSTALLED_ADAPTER="codex"
    INSTALLED="$(cat "$PROJECT_ROOT/.codex/skills/.version" 2>/dev/null || echo "unknown")"
  elif [[ -f "$PROJECT_ROOT/.claude/skills/.version" ]]; then
    INSTALLED_ADAPTER="claude-code"
    INSTALLED="$(cat "$PROJECT_ROOT/.claude/skills/.version" 2>/dev/null || echo "unknown")"
  elif [[ -d "$PROJECT_ROOT/.windsurf/workflows" || -d "$PROJECT_ROOT/.windsurf/rules" ]]; then
    INSTALLED_ADAPTER="windsurf"
  elif [[ -f "$PROJECT_ROOT/AGENTS.md" || -d "$PROJECT_ROOT/.codex/skills" ]]; then
    INSTALLED_ADAPTER="codex"
  elif [[ -f "$PROJECT_ROOT/CLAUDE.md" || -d "$PROJECT_ROOT/.claude/skills" || -f "$PROJECT_ROOT/.claude/CLAUDE.md" ]]; then
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

skill_src_dir="$(adapter_skill_source_dir "$TARGET_ADAPTER")"
skill_dst_dir="$(adapter_skill_dest_dir "$TARGET_ADAPTER")"
if [[ "$TARGET_ADAPTER" == "windsurf" ]]; then
  any_change=0
  for src in "$ADAPTERS_DIR/windsurf/.windsurf/rules/"*.md "$ADAPTERS_DIR/windsurf/.windsurf/workflows/"*.md; do
    name="$(basename "$src")"
    if [[ "$src" == *"/rules/"* ]]; then
      dst="$PROJECT_ROOT/.windsurf/rules/$name"
    else
      dst="$PROJECT_ROOT/.windsurf/workflows/$name"
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
    echo "  (no Windsurf workflow or rule files changed)"
  fi
elif [[ -n "$skill_src_dir" ]]; then
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
else
  echo "  - base adapter uses no host-specific skill files"
fi

instruction_target="$(adapter_instruction_target "$TARGET_ADAPTER")"
if [[ ! -f "$PROJECT_ROOT/$instruction_target" ]]; then
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
case "$TARGET_ADAPTER" in
  codex)
    mkdir -p "$PROJECT_ROOT/.codex/skills"
    cp -r "$ADAPTERS_DIR/codex/.codex/skills/"* "$PROJECT_ROOT/.codex/skills/"
    stamp_adapter_version "$TARGET_ADAPTER"
    echo "  ✅ Codex skills updated"
    if [[ ! -f "$PROJECT_ROOT/AGENTS.md" ]]; then
      cp "$ADAPTERS_DIR/codex/AGENTS.md" "$PROJECT_ROOT/AGENTS.md"
      echo "  ✅ AGENTS.md installed"
    fi
    ;;
  windsurf)
    mkdir -p "$PROJECT_ROOT/.windsurf/rules" "$PROJECT_ROOT/.windsurf/workflows"
    cp -r "$ADAPTERS_DIR/windsurf/.windsurf/rules/"* "$PROJECT_ROOT/.windsurf/rules/"
    cp -r "$ADAPTERS_DIR/windsurf/.windsurf/workflows/"* "$PROJECT_ROOT/.windsurf/workflows/"
    stamp_adapter_version "$TARGET_ADAPTER"
    echo "  ✅ Windsurf rules and workflows updated"
    if [[ ! -f "$PROJECT_ROOT/AGENTS.md" ]]; then
      cp "$ADAPTERS_DIR/windsurf/AGENTS.md" "$PROJECT_ROOT/AGENTS.md"
      echo "  ✅ AGENTS.md installed"
    fi
    ;;
  claude-code)
    mkdir -p "$PROJECT_ROOT/.claude/skills"
    cp -r "$ADAPTERS_DIR/claude-code/.claude/skills/"* "$PROJECT_ROOT/.claude/skills/"
    stamp_adapter_version "$TARGET_ADAPTER"
    echo "  ✅ Claude Code skills updated"
    if [[ ! -f "$PROJECT_ROOT/CLAUDE.md" ]]; then
      cp "$ADAPTERS_DIR/claude-code/CLAUDE.md" "$PROJECT_ROOT/CLAUDE.md"
      echo "  ✅ CLAUDE.md installed"
    fi
    ;;
  base)
    echo "  ✅ Base adapter requires no host-specific assets"
    ;;
esac

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

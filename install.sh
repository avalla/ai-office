#!/usr/bin/env bash
# AI Office Framework — Installer
# Usage: ./install.sh [project-root] [--adapter=<codex|windsurf|claude-code|base>] [--stamp-only]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SKELETON="$FRAMEWORK_DIR/skeleton/core"
ADAPTERS_DIR="$FRAMEWORK_DIR/skeleton/adapters"
VERSION="$(cat "$FRAMEWORK_DIR/VERSION")"

PROJECT_ROOT_ARG=""
ADAPTER="codex"
STAMP_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --stamp-only) STAMP_ONLY=true ;;
    --adapter=*) ADAPTER="${arg#*=}" ;;
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
  if [[ ! -d "$ADAPTERS_DIR/$ADAPTER" ]]; then
    echo "❌ Unknown adapter: $ADAPTER"
    echo "Available adapters:"
    for adapter_dir in "$ADAPTERS_DIR"/*/; do
      echo "  - $(basename "$adapter_dir")"
    done
    exit 1
  fi
}

adapter_instruction_target() {
  case "$ADAPTER" in
    codex) echo "AGENTS.md" ;;
    windsurf) echo "AGENTS.md" ;;
    claude-code) echo "CLAUDE.md" ;;
    base) echo "AI-OFFICE.md" ;;
  esac
}

adapter_version_file() {
  case "$ADAPTER" in
    codex) echo "$PROJECT_ROOT/.codex/skills/.version" ;;
    windsurf) echo "$PROJECT_ROOT/.windsurf/.version" ;;
    claude-code) echo "$PROJECT_ROOT/.claude/skills/.version" ;;
    base) echo "" ;;
  esac
}

stamp_adapter_version() {
  local version_file
  version_file="$(adapter_version_file)"
  if [[ -z "$version_file" ]]; then
    return
  fi
  mkdir -p "$(dirname "$version_file")"
  echo "$VERSION" > "$version_file"
}

write_install_metadata() {
  mkdir -p "$AI_OFFICE"
  cat > "$INSTALL_META" <<EOF
{
  "schemaVersion": 1,
  "version": "$VERSION",
  "adapter": "$ADAPTER",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

install_codex_adapter() {
  local adapter_root="$ADAPTERS_DIR/codex"
  echo "→ Installing Codex adapter"
  mkdir -p "$PROJECT_ROOT/.codex/skills"
  cp -r "$adapter_root/.codex/skills/"* "$PROJECT_ROOT/.codex/skills/"
  stamp_adapter_version
  echo "  ✅ $(find "$adapter_root/.codex/skills" -maxdepth 1 -type d -name 'office*' | wc -l | tr -d ' ') skills installed"

  if [[ ! -f "$PROJECT_ROOT/AGENTS.md" ]]; then
    cp "$adapter_root/AGENTS.md" "$PROJECT_ROOT/AGENTS.md"
    echo "  ✅ AGENTS.md installed"
  else
    echo "  ↩️  AGENTS.md already exists, skipped"
  fi
}

install_windsurf_adapter() {
  local adapter_root="$ADAPTERS_DIR/windsurf"
  echo "→ Installing Windsurf adapter"
  mkdir -p "$PROJECT_ROOT/.windsurf/rules" "$PROJECT_ROOT/.windsurf/workflows"
  cp -r "$adapter_root/.windsurf/rules/"* "$PROJECT_ROOT/.windsurf/rules/"
  cp -r "$adapter_root/.windsurf/workflows/"* "$PROJECT_ROOT/.windsurf/workflows/"
  stamp_adapter_version
  echo "  ✅ $(find "$adapter_root/.windsurf/workflows" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ') workflows installed"
  echo "  ✅ $(find "$adapter_root/.windsurf/rules" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ') rules installed"

  if [[ ! -f "$PROJECT_ROOT/AGENTS.md" ]]; then
    cp "$adapter_root/AGENTS.md" "$PROJECT_ROOT/AGENTS.md"
    echo "  ✅ AGENTS.md installed"
  else
    echo "  ↩️  AGENTS.md already exists, skipped"
  fi
}

install_claude_adapter() {
  local adapter_root="$ADAPTERS_DIR/claude-code"
  echo "→ Installing Claude Code adapter"
  mkdir -p "$PROJECT_ROOT/.claude/skills"
  cp -r "$adapter_root/.claude/skills/"* "$PROJECT_ROOT/.claude/skills/"
  stamp_adapter_version
  echo "  ✅ $(find "$adapter_root/.claude/skills" -maxdepth 1 -type d -name 'office*' | wc -l | tr -d ' ') skills installed"

  if [[ ! -f "$PROJECT_ROOT/CLAUDE.md" ]]; then
    cp "$adapter_root/CLAUDE.md" "$PROJECT_ROOT/CLAUDE.md"
    echo "  ✅ CLAUDE.md installed"
  else
    echo "  ↩️  CLAUDE.md already exists, skipped"
  fi
}

install_base_adapter() {
  echo "→ Using base adapter"
  echo "  ✅ No host-specific wrapper files required"
}

validate_adapter

echo "AI Office Framework v$VERSION"
echo "Installing into: $PROJECT_ROOT"
echo "Adapter: $ADAPTER"
echo ""

if [[ "$STAMP_ONLY" == true ]]; then
  write_install_metadata
  stamp_adapter_version
  echo "✅ Install metadata stamped: v$VERSION ($ADAPTER)"
  exit 0
fi

echo "→ Installing core assets"

if [[ ! -f "$PROJECT_ROOT/AI-OFFICE.md" ]]; then
  cp "$CORE_SKELETON/AI-OFFICE.md" "$PROJECT_ROOT/AI-OFFICE.md"
  echo "  ✅ AI-OFFICE.md installed"
else
  echo "  ↩️  AI-OFFICE.md already exists, skipped"
fi

for dir in \
  "$AI_OFFICE/tasks/BACKLOG" \
  "$AI_OFFICE/tasks/TODO" \
  "$AI_OFFICE/tasks/WIP" \
  "$AI_OFFICE/tasks/REVIEW" \
  "$AI_OFFICE/tasks/BLOCKED" \
  "$AI_OFFICE/tasks/DONE" \
  "$AI_OFFICE/tasks/ARCHIVED" \
  "$AI_OFFICE/docs/prd" \
  "$AI_OFFICE/docs/adr" \
  "$AI_OFFICE/docs/runbooks" \
  "$AI_OFFICE/agents" \
  "$AI_OFFICE/agencies" \
  "$AI_OFFICE/milestones" \
  "$AI_OFFICE/scripts" \
  "$AI_OFFICE/memory"
do
  mkdir -p "$dir"
done

if [[ ! -f "$AI_OFFICE/tasks/README.md" ]]; then
  sed "s/__DATE__/$(date +%Y-%m-%d)/" \
    "$CORE_SKELETON/.ai-office/tasks/README.md" \
    > "$AI_OFFICE/tasks/README.md"
fi

if [[ ! -f "$AI_OFFICE/office-config.md" ]]; then
  cp "$CORE_SKELETON/.ai-office/office-config.md" "$AI_OFFICE/office-config.md"
fi

if [[ ! -f "$PROJECT_ROOT/.mcp.json" ]]; then
  cp "$CORE_SKELETON/.mcp.json" "$PROJECT_ROOT/.mcp.json"
  echo "  ✅ .mcp.json created — fill in env vars for the adapters your agency needs"
else
  echo "  ↩️  .mcp.json already exists, skipped"
fi

if [[ ! -f "$AI_OFFICE/software-mcp-proposals.md" ]]; then
  cp "$CORE_SKELETON/.ai-office/software-mcp-proposals.md" "$AI_OFFICE/software-mcp-proposals.md"
fi

echo "→ Installing agent profiles"
for agent_dir in "$CORE_SKELETON/.ai-office/agents"/*/; do
  agent_name="$(basename "$agent_dir")"
  target="$AI_OFFICE/agents/$agent_name"
  if [[ ! -d "$target" ]]; then
    cp -r "$agent_dir" "$target"
    echo "  ✅ $agent_name"
  else
    echo "  ↩️  $agent_name (already present, skipped)"
  fi
done

if [[ ! -d "$AI_OFFICE/templates" ]]; then
  cp -r "$CORE_SKELETON/.ai-office/templates" "$AI_OFFICE/templates"
  echo "→ Document templates installed ($(ls "$AI_OFFICE/templates/"*.md | wc -l | tr -d ' ') files)"
fi

if [[ ! -d "$AI_OFFICE/addons" ]]; then
  cp -r "$CORE_SKELETON/.ai-office/addons" "$AI_OFFICE/addons"
  echo "→ Rule addons installed ($(ls "$AI_OFFICE/addons/"*.md | wc -l | tr -d ' ') files)"
fi

echo "  ✅ Core .ai-office/ structure ready"

case "$ADAPTER" in
  codex) install_codex_adapter ;;
  windsurf) install_windsurf_adapter ;;
  claude-code) install_claude_adapter ;;
  base) install_base_adapter ;;
esac

write_install_metadata

echo ""
echo "✅ AI Office Framework v$VERSION installed successfully"
echo ""

if [[ ! -f "$AI_OFFICE/project.config.md" ]]; then
  echo "Next: configure your project"
  echo "  ./setup.sh $PROJECT_ROOT"
  echo "  ai-office doctor"
else
  echo "Get started:"
  echo "  ai-office doctor"
  case "$ADAPTER" in
    codex)
      echo "  \$office"
      echo "  \$office-route <describe your task>"
      echo "  \$office-doctor"
      ;;
    windsurf)
      echo "  /office"
      echo "  /office-route <describe your task>"
      echo "  /office-doctor"
      ;;
    claude-code)
      echo "  /office"
      echo "  /office route <describe your task>"
      echo "  /office doctor"
      ;;
    base)
      echo "  ai-office status get <slug>"
      echo "  ai-office task create \"Task title\" column:TODO"
      ;;
  esac
fi

echo ""
echo "Optional addons (review and copy into $(adapter_instruction_target) as needed):"
for addon in "$AI_OFFICE/addons/"*.md; do
  echo "  # @.ai-office/addons/$(basename "$addon")"
done
echo "Append the addon content you need to $(adapter_instruction_target) — each addon adds domain-specific rules."

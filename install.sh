#!/usr/bin/env bash
# AI Office Framework — Installer
# Usage: ./install.sh [project-root] [--adapter=<codex|windsurf|claude-code|opencode|base>] [--stamp-only] [--skip-setup]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SKELETON="$FRAMEWORK_DIR/skeleton/core"
VERSION="$(cat "$FRAMEWORK_DIR/VERSION")"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun is required to install AI Office from source"
  exit 1
fi

eval "$(bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" emit-shell-metadata)"

PROJECT_ROOT_ARG=""
ADAPTER="codex"
STAMP_ONLY=false
SKIP_SETUP=false

for arg in "$@"; do
  case "$arg" in
    --stamp-only) STAMP_ONLY=true ;;
    --skip-setup) SKIP_SETUP=true ;;
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
  if ! adapter_exists "$ADAPTER"; then
    echo "❌ Unknown adapter: $ADAPTER"
    echo "Available adapters:"
    for adapter_name in "${AI_OFFICE_ADAPTERS[@]}"; do
      echo "  - $adapter_name"
    done
    exit 1
  fi
}

adapter_version_file() {
  local rel
  rel="$(adapter_version_file_rel "$ADAPTER")"
  if [[ -n "$rel" ]]; then
    echo "$PROJECT_ROOT/$rel"
  fi
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

addon_target_file() {
  local instruction_target
  instruction_target="$(adapter_instruction_target "$ADAPTER")"
  if [[ -n "$instruction_target" && "$instruction_target" == *.md ]]; then
    echo "$instruction_target"
  else
    echo "AI-OFFICE.md"
  fi
}

install_adapter_assets() {
  local kind instruction_target instruction_existed_before
  kind="$(adapter_kind "$ADAPTER")"

  case "$kind" in
    skills)
      echo "→ Installing ${ADAPTER} adapter"
      instruction_target="$(adapter_instruction_target "$ADAPTER")"
      instruction_existed_before=false
      if [[ -n "$instruction_target" && -f "$PROJECT_ROOT/$instruction_target" ]]; then
        instruction_existed_before=true
      fi
      bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" install \
        --framework-dir "$FRAMEWORK_DIR" \
        --project-root "$PROJECT_ROOT" \
        --adapter "$ADAPTER" \
        --instruction-mode if-missing >/dev/null
      echo "  ✅ $(find "$PROJECT_ROOT/$(adapter_skill_dest_rel "$ADAPTER")" -maxdepth 1 -type d -name 'office*' | wc -l | tr -d ' ') skills installed"
      if [[ -n "$instruction_target" ]]; then
        if [[ "$instruction_existed_before" == true ]]; then
          echo "  ↩️  $instruction_target already exists, skipped"
        else
          echo "  ✅ $instruction_target installed"
        fi
      fi
      ;;
    commands)
      echo "→ Installing ${ADAPTER} adapter"
      instruction_target="$(adapter_instruction_target "$ADAPTER")"
      instruction_existed_before=false
      if [[ -n "$instruction_target" && -f "$PROJECT_ROOT/$instruction_target" ]]; then
        instruction_existed_before=true
      fi
      bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" install \
        --framework-dir "$FRAMEWORK_DIR" \
        --project-root "$PROJECT_ROOT" \
        --adapter "$ADAPTER" \
        --instruction-mode if-missing >/dev/null
      echo "  ✅ $(find "$PROJECT_ROOT/$(adapter_commands_dest_rel "$ADAPTER")" -maxdepth 1 -type f -name 'office*.md' | wc -l | tr -d ' ') commands installed"
      if [[ -n "$instruction_target" ]]; then
        if [[ "$instruction_existed_before" == true ]]; then
          echo "  ↩️  $instruction_target already exists, skipped"
        else
          echo "  ✅ $instruction_target installed"
        fi
      fi
      ;;
    rules-workflows)
      echo "→ Installing ${ADAPTER} adapter"
      instruction_target="$(adapter_instruction_target "$ADAPTER")"
      instruction_existed_before=false
      if [[ -n "$instruction_target" && -f "$PROJECT_ROOT/$instruction_target" ]]; then
        instruction_existed_before=true
      fi
      bun run "$FRAMEWORK_DIR/src/adapter-runtime.ts" install \
        --framework-dir "$FRAMEWORK_DIR" \
        --project-root "$PROJECT_ROOT" \
        --adapter "$ADAPTER" \
        --instruction-mode if-missing >/dev/null
      echo "  ✅ $(find "$PROJECT_ROOT/$(adapter_workflows_dest_rel "$ADAPTER")" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ') workflows installed"
      echo "  ✅ $(find "$PROJECT_ROOT/$(adapter_rules_dest_rel "$ADAPTER")" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ') rules installed"
      if [[ -n "$instruction_target" ]]; then
        if [[ "$instruction_existed_before" == true ]]; then
          echo "  ↩️  $instruction_target already exists, skipped"
        else
          echo "  ✅ $instruction_target installed"
        fi
      fi
      ;;
    *)
      echo "→ Using base adapter"
      echo "  ✅ No host-specific wrapper files required"
      ;;
  esac
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
  "$AI_OFFICE/tasks/REJECTED" \
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

install_adapter_assets

write_install_metadata

echo ""
echo "✅ AI Office Framework v$VERSION installed successfully"
echo ""

if [[ "$SKIP_SETUP" == true ]]; then
  echo "ℹ️  Automatic setup skipped (--skip-setup)."
elif [[ ! -f "$AI_OFFICE/project.config.md" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    echo "→ Launching setup wizard..."
    echo ""
    "$FRAMEWORK_DIR/setup.sh" "$PROJECT_ROOT"
    exit 0
  else
    echo "ℹ️  Skipping automatic setup because this install is running non-interactively."
    echo "   Run ./setup.sh $PROJECT_ROOT to open the wizard,"
    echo "   or ./setup.sh $PROJECT_ROOT --non-interactive <flags> for scripted setup."
    echo ""
  fi
fi

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
    opencode)
      echo "  /office"
      echo "  /office-route <describe your task>"
      echo "  /office-doctor"
      ;;
    base)
      echo "  ai-office status get <slug>"
      echo "  ai-office task create \"Task title\" column:TODO"
      ;;
  esac
fi

echo ""
ADDON_TARGET="$(addon_target_file)"
echo "Optional addons (review and copy into $ADDON_TARGET as needed):"
for addon in "$AI_OFFICE/addons/"*.md; do
  echo "  # @.ai-office/addons/$(basename "$addon")"
done
echo "Append the addon content you need to $ADDON_TARGET — each addon adds domain-specific rules."

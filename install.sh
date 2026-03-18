#!/usr/bin/env bash
# AI Office Framework — Installer
# Usage: ./install.sh [project-root] [--stamp-only]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKELETON="$FRAMEWORK_DIR/skeleton"
PROJECT_ROOT="${1:-.}"
STAMP_ONLY="${2:-}"
VERSION="$(cat "$FRAMEWORK_DIR/VERSION")"

# Resolve absolute project root
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

echo "AI Office Framework v$VERSION"
echo "Installing into: $PROJECT_ROOT"
echo ""

# ── Stamp-only mode ───────────────────────────────────────────────────────────
if [[ "$STAMP_ONLY" == "--stamp-only" ]]; then
  mkdir -p "$PROJECT_ROOT/.claude/commands/office"
  echo "$VERSION" > "$PROJECT_ROOT/.claude/commands/office/.version"
  echo "✅ Version stamped: $VERSION"
  exit 0
fi

# ── Install Claude Code commands ──────────────────────────────────────────────
echo "→ Installing commands to .claude/commands/office/"
mkdir -p "$PROJECT_ROOT/.claude/commands/office"
cp "$SKELETON/.claude/commands/office/"*.md "$PROJECT_ROOT/.claude/commands/office/"
echo "$VERSION" > "$PROJECT_ROOT/.claude/commands/office/.version"
echo "  ✅ $(ls "$SKELETON/.claude/commands/office/"*.md | wc -l | tr -d ' ') commands installed"

# ── Create .ai-office/ structure ──────────────────────────────────────────────
echo "→ Setting up .ai-office/ directory structure"

AI_OFFICE="$PROJECT_ROOT/.ai-office"
for dir in \
  "$AI_OFFICE/tasks/BACKLOG" \
  "$AI_OFFICE/tasks/TODO" \
  "$AI_OFFICE/tasks/WIP" \
  "$AI_OFFICE/tasks/REVIEW" \
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

# tasks/README.md (only if not exists)
if [[ ! -f "$AI_OFFICE/tasks/README.md" ]]; then
  sed "s/__DATE__/$(date +%Y-%m-%d)/" \
    "$SKELETON/.ai-office/tasks/README.md" \
    > "$AI_OFFICE/tasks/README.md"
fi

# office-config.md (only if not exists)
if [[ ! -f "$AI_OFFICE/office-config.md" ]]; then
  cp "$SKELETON/.ai-office/office-config.md" "$AI_OFFICE/office-config.md"
fi

# .mcp.json (only if not exists)
if [[ ! -f "$PROJECT_ROOT/.mcp.json" ]]; then
  cp "$SKELETON/.mcp.json" "$PROJECT_ROOT/.mcp.json"
  echo "  ✅ .mcp.json created — fill in env vars for the adapters your agency needs"
else
  echo "  ↩️  .mcp.json already exists, skipped"
fi

# software-mcp-proposals.md (only if not exists)
if [[ ! -f "$AI_OFFICE/software-mcp-proposals.md" ]]; then
  cp "$SKELETON/.ai-office/software-mcp-proposals.md" "$AI_OFFICE/software-mcp-proposals.md"
fi

# agents/ — copy all agent profiles (skip if already present)
echo "→ Installing agent profiles"
for agent_dir in "$SKELETON/.ai-office/agents"/*/; do
  agent_name="$(basename "$agent_dir")"
  target="$AI_OFFICE/agents/$agent_name"
  if [[ ! -d "$target" ]]; then
    cp -r "$agent_dir" "$target"
    echo "  ✅ $agent_name"
  else
    echo "  ↩️  $agent_name (already present, skipped)"
  fi
done

# templates/ — copy document templates (skip if already present)
if [[ ! -d "$AI_OFFICE/templates" ]]; then
  cp -r "$SKELETON/.ai-office/templates" "$AI_OFFICE/templates"
  echo "→ Document templates installed ($(ls "$AI_OFFICE/templates/"*.md | wc -l | tr -d ' ') files)"
fi

echo "  ✅ .ai-office/ structure ready"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ AI Office Framework v$VERSION installed successfully"
echo ""

if [[ ! -f "$AI_OFFICE/project.config.md" ]]; then
  echo "Next: configure your project"
  echo "  ./setup.sh $PROJECT_ROOT   ← interactive setup (agency, tech stack)"
  echo "  /office:setup              ← same, inside Claude Code"
else
  echo "Get started:"
  echo "  /office:ai-office          ← interactive wizard"
  echo "  /office:route <describe your task>"
  echo "  /office:doctor"
fi

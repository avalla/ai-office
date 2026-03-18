#!/usr/bin/env bash
# AI Office Framework — Installer
# Usage: ./install.sh [project-root] [--stamp-only]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
cp "$FRAMEWORK_DIR/commands/office/"*.md "$PROJECT_ROOT/.claude/commands/office/"
echo "$VERSION" > "$PROJECT_ROOT/.claude/commands/office/.version"
echo "  ✅ $(ls "$FRAMEWORK_DIR/commands/office/"*.md | wc -l | tr -d ' ') commands installed"

# ── Create .ai-office/ structure ──────────────────────────────────────────────
echo "→ Setting up .ai-office/ directory structure"

AI_OFFICE="$PROJECT_ROOT/.ai-office"
for dir in \
  "$AI_OFFICE/tasks/BACKLOG" \
  "$AI_OFFICE/tasks/TODO" \
  "$AI_OFFICE/tasks/WIP" \
  "$AI_OFFICE/tasks/REVIEW" \
  "$AI_OFFICE/tasks/DONE" \
  "$AI_OFFICE/docs/prd" \
  "$AI_OFFICE/docs/adr" \
  "$AI_OFFICE/docs/runbooks" \
  "$AI_OFFICE/agents" \
  "$AI_OFFICE/agencies" \
  "$AI_OFFICE/scripts" \
  "$AI_OFFICE/memory"
do
  mkdir -p "$dir"
done

# tasks/README.md (only if not exists)
if [[ ! -f "$AI_OFFICE/tasks/README.md" ]]; then
  cat > "$AI_OFFICE/tasks/README.md" <<'EOF'
BACKLOG: 0
TODO: 0
WIP: 0
REVIEW: 0
DONE: 0

Updated: $(date +%Y-%m-%d)
EOF
  sed -i.bak "s/\$(date +%Y-%m-%d)/$(date +%Y-%m-%d)/" "$AI_OFFICE/tasks/README.md"
  rm -f "$AI_OFFICE/tasks/README.md.bak"
fi

# office-config.md (only if not exists)
if [[ ! -f "$AI_OFFICE/office-config.md" ]]; then
  cat > "$AI_OFFICE/office-config.md" <<'EOF'
# AI Office Configuration

> Virtual AI Agency structure, roles, and operational parameters

---
trigger: always_on
---

## Agency Identity

**Name:** AI Office
**Type:** Virtual Software Agency
**Mission:** Deliver high-quality software projects through AI-driven multi-role collaboration
**Version:** 1.0

## Default Agency

Software Studio (full SDLC with all quality gates)

## Quality Thresholds

- **Code Coverage:** ≥ 80%
- **Test Pass Rate:** 100%
- **Security Vulnerabilities:** 0 high/critical

## Iteration Limits

- **QA Iterations:** Max 2 (then escalate)
- **Review Iterations:** Max 2 (then escalate)
EOF
fi

echo "  ✅ .ai-office/ structure ready"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ AI Office Framework v$VERSION installed successfully"
echo ""

if [[ ! -f "$AI_OFFICE/project.config.md" ]]; then
  echo "Next: configure your project"
  echo "  ./tools/ai-office-framework/setup.sh   ← interactive setup (agency, tech stack)"
  echo "  /office:setup                          ← same, inside Claude Code"
else
  echo "Get started:"
  echo "  /office:route <describe your task>"
  echo "  /office:doctor"
fi

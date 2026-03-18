#!/usr/bin/env bash
# AI Office Framework — Updater
# Usage: ./update.sh [project-root]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-.}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

AVAILABLE="$(cat "$FRAMEWORK_DIR/VERSION")"
INSTALLED_FILE="$PROJECT_ROOT/.claude/commands/office/.version"
INSTALLED="$(cat "$INSTALLED_FILE" 2>/dev/null || echo "unknown")"

echo "AI Office Framework — Update"
echo ""
echo "  Installed : $INSTALLED"
echo "  Available : $AVAILABLE"
echo ""

# ── Version comparison (simple semver lexicographic) ─────────────────────────
version_gt() {
  # Returns 0 (true) if $1 > $2
  [[ "$1" != "$2" ]] && [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]
}

if [[ "$INSTALLED" == "$AVAILABLE" ]]; then
  echo "✅ Already up to date (v$AVAILABLE)"
  exit 0
fi

if [[ "$INSTALLED" == "unknown" ]]; then
  echo "⚠️  Installed version unknown — proceeding with update"
elif version_gt "$INSTALLED" "$AVAILABLE"; then
  echo "⚠️  Installed version ($INSTALLED) is newer than framework source ($AVAILABLE)"
  read -p "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
fi

# ── Show what will change ─────────────────────────────────────────────────────
echo "Commands to update:"
for src in "$FRAMEWORK_DIR/commands/office/"*.md; do
  name="$(basename "$src")"
  dst="$PROJECT_ROOT/.claude/commands/office/$name"
  if [[ ! -f "$dst" ]]; then
    echo "  + $name (new)"
  elif ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    echo "  ~ $name (changed)"
  fi
done
echo ""

read -p "Apply update v$INSTALLED → v$AVAILABLE? [Y/n] " confirm
[[ "$confirm" =~ ^[Nn]$ ]] && echo "Aborted." && exit 0

# ── Apply update ──────────────────────────────────────────────────────────────
echo ""
echo "→ Updating commands..."
mkdir -p "$PROJECT_ROOT/.claude/commands/office"
cp "$FRAMEWORK_DIR/commands/office/"*.md "$PROJECT_ROOT/.claude/commands/office/"
echo "$AVAILABLE" > "$INSTALLED_FILE"
echo "  ✅ Commands updated"

# ── Ensure .ai-office/ structure still complete ───────────────────────────────
echo "→ Checking .ai-office/ structure..."
AI_OFFICE="$PROJECT_ROOT/.ai-office"
for dir in \
  "$AI_OFFICE/tasks/BACKLOG" "$AI_OFFICE/tasks/TODO" "$AI_OFFICE/tasks/WIP" \
  "$AI_OFFICE/tasks/REVIEW" "$AI_OFFICE/tasks/DONE" \
  "$AI_OFFICE/docs/prd" "$AI_OFFICE/docs/adr" "$AI_OFFICE/docs/runbooks" \
  "$AI_OFFICE/scripts"
do
  mkdir -p "$dir"
done
echo "  ✅ Structure OK"

echo ""
echo "✅ Updated to v$AVAILABLE"
echo ""
echo "See CHANGELOG.md for what changed."

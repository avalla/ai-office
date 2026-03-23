#!/usr/bin/env bash
# AI Office Framework — Updater
# Usage: ./update.sh [project-root]
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-.}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

AVAILABLE="$(cat "$FRAMEWORK_DIR/VERSION")"
INSTALLED_FILE="$PROJECT_ROOT/.codex/skills/.version"
if [[ ! -f "$INSTALLED_FILE" && -f "$PROJECT_ROOT/.claude/skills/.version" ]]; then
  INSTALLED_FILE="$PROJECT_ROOT/.claude/skills/.version"
fi
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

# ── Extract ai-office-version annotation from a file ─────────────────────────
get_file_version() {
  grep -m1 'ai-office-version:' "$1" 2>/dev/null \
    | sed 's/.*ai-office-version:[[:space:]]*//' \
    | tr -d ' -->' \
    || echo ""
}

# ── Show what will change ─────────────────────────────────────────────────────
echo "Skills to update:"
any_change=0
for src_dir in "$FRAMEWORK_DIR/skeleton/.codex/skills/"/office*/; do
  skill_name="$(basename "$src_dir")"
  src="$src_dir/SKILL.md"
  dst="$PROJECT_ROOT/.codex/skills/$skill_name/SKILL.md"
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
  echo "  (no skill files changed)"
fi
echo ""

read -p "Apply update v$INSTALLED → v$AVAILABLE? [Y/n] " confirm
[[ "$confirm" =~ ^[Nn]$ ]] && echo "Aborted." && exit 0

# ── Apply update ──────────────────────────────────────────────────────────────
echo ""
echo "→ Updating skills..."
mkdir -p "$PROJECT_ROOT/.codex/skills"
cp -r "$FRAMEWORK_DIR/skeleton/.codex/skills/"* "$PROJECT_ROOT/.codex/skills/"
echo "$AVAILABLE" > "$PROJECT_ROOT/.codex/skills/.version"
echo "  ✅ Skills updated"

# ── Install AGENTS.md if missing ──────────────────────────────────────────────
if [[ ! -f "$PROJECT_ROOT/AGENTS.md" ]]; then
  cp "$FRAMEWORK_DIR/skeleton/AGENTS.md" "$PROJECT_ROOT/AGENTS.md"
  echo "  ✅ AGENTS.md installed"
fi

# ── Remove legacy commands directory if present ───────────────────────────────
if [[ -d "$PROJECT_ROOT/.claude/commands/office" ]]; then
  rm -rf "$PROJECT_ROOT/.claude/commands/office"
  # Remove parent if now empty
  rmdir "$PROJECT_ROOT/.claude/commands" 2>/dev/null || true
  echo "  🗑️  Removed legacy .claude/commands/office/"
fi

# ── Ensure .ai-office/ structure still complete ───────────────────────────────
echo "→ Checking .ai-office/ structure..."
AI_OFFICE="$PROJECT_ROOT/.ai-office"
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
echo "✅ Updated to v$AVAILABLE"
echo ""
echo "See CHANGELOG.md for what changed."

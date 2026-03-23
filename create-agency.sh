#!/usr/bin/env bash
# AI Office Framework — Create Custom Agency
# Scaffolds a new agency from an existing one.
#
# Usage:
#   ./create-agency.sh <slug> [--from=<base-agency>] [--name=<display-name>] [--desc=<description>]
#
# Examples:
#   ./create-agency.sh autoepoque --from=software-studio --desc="Bespoke fashion & tech studio"
#   ./create-agency.sh my-studio
set -e

FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENCIES_DIR="$FRAMEWORK_DIR/skeleton/core/.ai-office/agencies"

SLUG=""
FROM="software-studio"
DISPLAY_NAME=""
DESCRIPTION=""

for arg in "$@"; do
  case "$arg" in
    --from=*)   FROM="${arg#*=}" ;;
    --name=*)   DISPLAY_NAME="${arg#*=}" ;;
    --desc=*)   DESCRIPTION="${arg#*=}" ;;
    -*) ;;
    *) [[ -z "$SLUG" ]] && SLUG="$arg" ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "Usage: ./create-agency.sh <slug> [--from=<base>] [--name=<display-name>] [--desc=<description>]"
  echo ""
  echo "Available base agencies:"
  for d in "$AGENCIES_DIR"/*/; do echo "  $(basename "$d")"; done
  exit 1
fi

if [[ ! -d "$AGENCIES_DIR/$FROM" ]]; then
  echo "❌ Base agency '$FROM' not found."
  echo "Available agencies:"
  for d in "$AGENCIES_DIR"/*/; do echo "  $(basename "$d")"; done
  exit 1
fi

TARGET="$AGENCIES_DIR/$SLUG"
if [[ -d "$TARGET" ]]; then
  echo "❌ Agency '$SLUG' already exists at $TARGET"
  echo "   Delete it first or choose a different slug."
  exit 1
fi

# Default display name: slug with hyphens → spaces, title-cased via python
if [[ -z "$DISPLAY_NAME" ]]; then
  DISPLAY_NAME="$(python3 -c "import sys; print(sys.argv[1].replace('-', ' ').title())" "$SLUG")"
fi

if [[ -z "$DESCRIPTION" ]]; then
  DESCRIPTION="Custom agency based on $FROM"
fi

echo "AI Office — Create Agency"
echo "  Slug:        $SLUG"
echo "  Display:     $DISPLAY_NAME"
echo "  Description: $DESCRIPTION"
echo "  Based on:    $FROM"
echo ""

mkdir -p "$TARGET"
cp "$AGENCIES_DIR/$FROM/"*.md "$TARGET/"

# Update config.md frontmatter and h1 heading
python3 - "$TARGET/config.md" "$SLUG" "$DISPLAY_NAME" "$DESCRIPTION" <<'PYEOF'
import sys, re

path, slug, name, desc = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
content = open(path).read()

# Replace frontmatter fields (within the first --- block)
content = re.sub(r'(?m)^agency: .*', f'agency: {slug}', content, count=1)
content = re.sub(r'(?m)^name: .*', f'name: {name}', content, count=1)
content = re.sub(r'(?m)^description: .*', f'description: {desc}', content, count=1)

# Inject custom: true after description line in frontmatter (if not present)
if 'custom: true' not in content:
    content = re.sub(r'(?m)^(description: .*)$', r'\1\ncustom: true', content, count=1)

# Update the h1 heading
content = re.sub(r'(?m)^# .+', f'# {name} Configuration', content, count=1)

open(path, 'w').write(content)
PYEOF

echo "✅ Agency '$SLUG' created at:"
echo "   $TARGET"
echo ""
echo "Customize these files:"
echo "  config.md    — agents, quality gates, tech stack"
echo "  pipeline.md  — workflow stages and variants"
echo "  templates.md — project directory templates"
echo ""
echo "Use it in a project:"
echo "  ./setup.sh <project-root> --agency=$SLUG"
echo "  (or select it from the menu when running ./setup.sh)"

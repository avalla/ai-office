---
description: Show installed AI Office framework version and check for updates
---

## Steps

1. Read `.claude/commands/office/.version` (the installed version stamp). If it doesn't exist, report "unknown".

2. Read `tools/ai-office-framework/VERSION` (the available framework version in this project). If it doesn't exist, note that the framework source is not present locally.

3. Compare the two versions using semver rules (major.minor.patch).

4. Output:

```
AI Office Framework

Installed version : 1.0.0
Available version : 1.0.0

Status: ✅ Up to date

Commands installed: .claude/commands/office/ (15 files)
Framework source  : tools/ai-office-framework/
```

If installed < available:
```
Status: ⚠️  Update available (1.0.0 → 1.1.0)

To update, run:
  ./tools/ai-office-framework/update.sh

Or ask me: "update the ai-office commands"
```

If installed version is unknown:
```
Status: ❓ Version unknown — framework may have been installed manually

To stamp the current version, run:
  ./tools/ai-office-framework/install.sh --stamp-only
```

5. Also check: are all 15 expected command files present in `.claude/commands/office/`? List any missing ones.

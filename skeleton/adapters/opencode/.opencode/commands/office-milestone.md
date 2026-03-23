# /office-milestone

Description: Create, inspect, or list AI Office milestones using the deterministic CLI.

Usage: `/office-milestone create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask] | status <id> | list`

Examples:
- `/office-milestone create M1 Billing Sync target:2026-05-01 tasks:yes`
- `/office-milestone status M1`
- `/office-milestone list`

Follow these steps:
1. Determine whether the user wants to create a milestone, inspect a milestone, or list milestones.
2. For create, collect the milestone id, name, and any optional `target:` or `tasks:` arguments, then run `ai-office milestone create ...`.
3. For inspect, run `ai-office milestone status <id>`.
4. For list, run `ai-office milestone list`.
5. Summarize milestone progress and call out any auto-created tasks.

<!-- ai-office-version: 1.11.0 -->

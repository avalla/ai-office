# /office-task-integrate

Description: Integrate a reviewed task branch into the configured merge target.

Arguments: `<task-id> [reason]`

Examples:
- `/office-task-integrate M1_T003`
- `/office-task-integrate M1_T003 "QA approved for UAT"`

1. Confirm the task id to integrate.
2. Read `.ai-office/project.config.md` if needed to understand task isolation settings.
3. Run `ai-office task integrate <task-id>` and include any provided reason if supported by the CLI.
4. Report the integration target branch and any follow-up step for UAT or release.

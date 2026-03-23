# /office-setup

Description: Configure or reconfigure AI Office for the current project.

Arguments: `[setup flags]`

Examples:
- `/office-setup`
- `/office-setup --agency=software-studio --stack=node-react --non-interactive`
- `/office-setup --reconfigure --advance-mode=auto`

1. If the user wants interactive setup, run `./setup.sh .`.
2. If the user wants deterministic setup, collect the needed flags and run `./setup.sh . <flags>`.
3. If the project is already configured and the user wants to change it, prefer `./setup.sh . --reconfigure ...`.
4. Summarize the resulting configuration and the next AI Office command to run.

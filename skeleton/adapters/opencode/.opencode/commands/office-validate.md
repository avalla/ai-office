# /office-validate

Description: Run deterministic AI Office validation for a pipeline stage.

Usage: `/office-validate <slug> <stage>`

Examples:
- `/office-validate billing-sync prd`
- `/office-validate search-rewrite dev`

Follow these steps:
1. Collect the feature slug and stage.
2. Run `ai-office validate <slug> <stage>`.
3. Summarize the pass, warn, and fail results.
4. If validation fails, explain the smallest useful next action instead of claiming the work is complete.

<!-- ai-office-version: 1.11.0 -->

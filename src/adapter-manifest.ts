export type AdapterHost = "base" | "codex" | "claude-code" | "opencode" | "windsurf";

export type CommandSpec = {
  id: string;
  description: string;
  argumentsFormat?: string;
  argumentGuidance?: string[];
  examples?: string[];
  steps: string[];
};

export type AdapterProfile = {
  host: AdapterHost;
  adapterLabel: string;
  instructionFileName?: string;
  instructionOutputPath?: string;
  instructionTemplatePath?: string;
  commandPrefix: "$" | "/";
  skillOutputRoot?: string;
  installedSkillRoot?: string;
  commandOutputRoot?: string;
  installedCommandRoot?: string;
  versionStampPath?: string;
  rulesOutputRoot?: string;
  installedRulesRoot?: string;
  workflowOutputRoot?: string;
  installedWorkflowRoot?: string;
  structuredChoiceGuidance?: string[];
};

export const ADAPTER_PROFILES: AdapterProfile[] = [
  {
    host: "base",
    adapterLabel: "Base adapter",
    commandPrefix: "/",
  },
  {
    host: "codex",
    adapterLabel: "Codex adapter",
    instructionFileName: "AGENTS.md",
    instructionOutputPath: "skeleton/adapters/codex/AGENTS.md",
    commandPrefix: "$",
    skillOutputRoot: "skeleton/adapters/codex/.codex/skills",
    installedSkillRoot: ".codex/skills",
    versionStampPath: ".codex/skills/.version",
    structuredChoiceGuidance: [
      "When `interactive_choices_mode` is `buttons-when-available`, use `request_user_input` when it is available in the current collaboration mode.",
      "Keep structured prompts short, offer 2-3 mutually exclusive buttons, and put the recommended choice first.",
      "If `request_user_input` is unavailable, fall back to concise plain-text choices with the same options.",
    ],
  },
  {
    host: "claude-code",
    adapterLabel: "Claude Code adapter",
    instructionFileName: "CLAUDE.md",
    instructionOutputPath: "skeleton/adapters/claude-code/CLAUDE.md",
    commandPrefix: "/",
    skillOutputRoot: "skeleton/adapters/claude-code/.claude/skills",
    installedSkillRoot: ".claude/skills",
    versionStampPath: ".claude/skills/.version",
  },
  {
    host: "opencode",
    adapterLabel: "OpenCode adapter",
    instructionFileName: "opencode.json",
    instructionOutputPath: "skeleton/adapters/opencode/opencode.json",
    instructionTemplatePath: "skeleton/core/templates/opencode.json.tmpl",
    commandPrefix: "/",
    commandOutputRoot: "skeleton/adapters/opencode/.opencode/commands",
    installedCommandRoot: ".opencode/commands",
    versionStampPath: ".opencode/.version",
  },
  {
    host: "windsurf",
    adapterLabel: "Windsurf adapter",
    instructionFileName: "AGENTS.md",
    instructionOutputPath: "skeleton/adapters/windsurf/AGENTS.md",
    commandPrefix: "/",
    versionStampPath: ".windsurf/.version",
    rulesOutputRoot: "skeleton/adapters/windsurf/.windsurf/rules",
    installedRulesRoot: ".windsurf/rules",
    workflowOutputRoot: "skeleton/adapters/windsurf/.windsurf/workflows",
    installedWorkflowRoot: ".windsurf/workflows",
  },
];

export const GENERATED_COMMAND_IDS = [
  "office",
  "office-advance",
  "office-background",
  "office-doctor",
  "office-instruction-merge",
  "office-instruction-scan",
  "office-instruction-status",
  "office-issue-intake",
  "office-issue-link",
  "office-issue-response",
  "office-issue-triage",
  "office-intent-check",
  "office-milestone",
  "office-plan",
  "office-profile",
  "office-route",
  "office-setup",
  "office-status",
  "office-task-create",
  "office-task-commit",
  "office-task-trace",
  "office-task-integrate",
  "office-task-move",
  "office-task-update",
  "office-validate",
] as const;

export const TEMPLATE_COMMAND_IDS = [
  "office-agency",
  "office-graph",
  "office-meta",
  "office-report",
  "office-review",
  "office-role",
  "office-run-tests",
  "office-scaffold",
  "office-script",
  "office-task-list",
  "office-validate-secrets",
  "office-verify",
] as const;

export const ALL_SUPPORTED_COMMAND_IDS = [...GENERATED_COMMAND_IDS, ...TEMPLATE_COMMAND_IDS] as const;

export const COMMAND_SPECS: CommandSpec[] = [
  {
    id: "office",
    description: "AI Office entrypoint. Route the request to the right workflow or deterministic CLI action.",
    examples: [
      "{{SELF}} help me start a billing feature",
      "{{SELF}} create a task for fixing auth retries",
      "{{SELF}} check project health",
    ],
    steps: [
      "Read `AI-OFFICE.md`, `.ai-office/project.config.md`, `.ai-office/office-profile.md`, `.ai-office/pipeline.md`, `.ai-office/agent-operating-model.md`, and `.ai-office/collaboration-gates.md` when present.",
      "Infer whether the user needs routing, status, task board work, milestone management, validation, setup, or a doctor check.",
      "For non-trivial feature, bug, refactor, audit, or initiative work, route first to `{{CMD:office-intent-check}}` before implementation.",
      "For a new feature, bug, audit, or initiative, call `{{CMD:office-route}}`.",
      "For a requested code or documentation change, ensure an AI Office task exists before implementation.",
      "If the requested change is truly tiny, ask whether to create a task or proceed with the immediate fix.",
      "For task board mutations, prefer `{{CMD:office-task-create}}`, `{{CMD:office-task-move}}`, `{{CMD:office-task-update}}`, or `{{CMD:office-task-integrate}}`.",
      "For milestone operations, call `{{CMD:office-milestone}}`.",
      "For project operating model questions, call `{{CMD:office-profile}}`.",
      "For stage readiness, call `{{CMD:office-validate}}` or `{{CMD:office-advance}}`.",
      "For installation or configuration checks, call `{{CMD:office-doctor}}` or `{{CMD:office-setup}}`.",
      "Prefer deterministic `ai-office` CLI commands for state mutations whenever the CLI supports the operation.",
    ],
  },
  {
    id: "office-profile",
    description: "Read, summarize, or regenerate the custom project office profile.",
    argumentsFormat: "[summary|regenerate]",
    examples: [
      "{{SELF}}",
      "{{SELF}} summary",
      "{{SELF}} regenerate",
    ],
    steps: [
      "Read `.ai-office/project.config.md`, `.ai-office/office-profile.md`, `.ai-office/pipeline.md`, `.ai-office/quality-gates.md`, `.ai-office/agent-operating-model.md`, and `.ai-office/collaboration-gates.md` when present.",
      "List generated roles from `.ai-office/roles/*.md` without loading every role body.",
      "Summarize the office mode, project type, generated pipeline, quality gates, roles, agent operating mode, background work mode, and token-efficiency rules.",
      "If the profile, pipeline, quality gates, or generated roles are stale or missing, suggest `./setup.sh . --reconfigure --auto`.",
      "If the user asks to regenerate, run `./setup.sh . --reconfigure --auto` and summarize the regenerated project office files.",
      "Include `.ai-office/instruction-discovery.md` status when present, including detected host instruction files and whether AI Office is merged or sidecar-only.",
    ],
  },
  {
    id: "office-instruction-scan",
    description: "Scan the repository for existing AI agent instruction files without modifying them.",
    examples: ["{{SELF}}"],
    steps: [
      "Run `ai-office instruction scan`.",
      "Detect known instruction files such as `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursor/rules`, `.windsurf/rules`, `opencode.json`, and prompt-like markdown files.",
      "Write or summarize `.ai-office/instruction-discovery.md`.",
      "Do not modify user-owned instruction files.",
    ],
  },
  {
    id: "office-instruction-merge",
    description: "Merge AI Office managed instructions into existing agent instruction files safely.",
    argumentsFormat: "[--mode=section|sidecar|append|skip|overwrite-explicit] [--target=CLAUDE.md|AGENTS.md|all]",
    examples: [
      "{{SELF}} --mode=section --target=CLAUDE.md",
      "{{SELF}} --mode=sidecar --target=AGENTS.md",
    ],
    steps: [
      "Read `.ai-office/project.config.md` and `.ai-office/instruction-merge-policy.md` when present.",
      "Run `ai-office instruction merge ...` with the requested mode and target.",
      "Preserve user-owned content outside `AI-OFFICE:START/END` blocks.",
      "Create backups before modifying existing files when `instruction_backup` is enabled.",
      "Use sidecar mode when the user does not want AI Office to modify existing prompt files.",
    ],
  },
  {
    id: "office-instruction-status",
    description: "Show detected instruction files and whether AI Office managed blocks or sidecars are installed.",
    examples: ["{{SELF}}"],
    steps: [
      "Run `ai-office instruction status`.",
      "Report each detected instruction file, classified tool, and managed block state: missing, present, duplicate, current, or sidecar-only.",
      "If the expected adapter instruction file is missing or unmerged, suggest `{{CMD:office-instruction-merge}}`.",
    ],
  },
  {
    id: "office-intent-check",
    description: "Review request intent before implementation.",
    argumentsFormat: "<request> [slug:<slug>]",
    examples: [
      "{{SELF}} Add billing retry logic",
      "{{SELF}} Rename agencies to presets slug:terminology-cleanup",
    ],
    steps: [
      "Read `AI-OFFICE.md`, `.ai-office/project.config.md`, `.ai-office/agent-operating-model.md`, and `.ai-office/collaboration-gates.md`.",
      "Read `.ai-office/office-profile.md`, `.ai-office/pipeline.md`, and `.ai-office/quality-gates.md` when present.",
      "Classify the request as feature, bugfix, refactor, docs, infra, security, product-decision, audit, or other.",
      "Assess whether code is required, product fit, architecture fit, naming/UX fit, complexity risk, and security/data/infra risk.",
      "Decide whether tiny-fix-fast-path applies; if not, recommend task creation and `{{CMD:office-plan}}` before implementation.",
      "Optionally create `.ai-office/docs/context/<slug>-intent-check.md` from `.ai-office/templates/intent-check.md` when a slug is provided or the user asks to persist it.",
      "Output task type, product fit, architecture fit, complexity risk, recommended path, stop conditions, and next action.",
    ],
  },
  {
    id: "office-plan",
    description: "Create an implementation plan before coding.",
    argumentsFormat: "<task-or-request> [slug:<slug>]",
    examples: [
      "{{SELF}} M1_T003",
      "{{SELF}} Add office background task files slug:background-work",
    ],
    steps: [
      "Read `.ai-office/project.config.md`, `.ai-office/agent-operating-model.md`, `.ai-office/collaboration-gates.md`, `.ai-office/templates/implementation-plan.md`, and relevant task/status files.",
      "Link to an existing task when possible; otherwise identify the task that should be created.",
      "Identify files likely to change, expected behavior change, validation commands, project-specific gates, risks, and rollback or recovery notes.",
      "Write or propose an implementation plan artifact when persistence is useful.",
      "Do not implement code in this command.",
    ],
  },
  {
    id: "office-background",
    description: "Create, inspect, or resume background-capable AI Office tasks.",
    argumentsFormat: "create <slug> <description> | status <slug> | resume <slug> | list",
    examples: [
      "{{SELF}} create nightly-audit Check stale dependencies weekly",
      "{{SELF}} status nightly-audit",
      "{{SELF}} resume nightly-audit",
      "{{SELF}} list",
    ],
    steps: [
      "Read `.ai-office/project.config.md`, `.ai-office/agent-operating-model.md`, `.ai-office/templates/background-task.md`, and `.ai-office/background/README.md` when present.",
      "Never claim work is running in the background unless the host explicitly supports true background execution.",
      "When `background_work_mode` is `simulated`, represent background work as `.ai-office/background/<slug>-status.md`, queued tasks, scheduled checks, CI/GitHub triggers, and resume instructions.",
      "For `create`, create or propose a background-capable task status file with state, checkpoint strategy, next action, owner, stop conditions, resume instructions, and verification.",
      "For `status`, summarize the current state and next action from the status file.",
      "For `resume`, read the status file, restate the last checkpoint, and continue only from the documented next action.",
      "For `list`, list known `.ai-office/background/*-status.md` files without loading unrelated histories.",
    ],
  },
  {
    id: "office-issue-intake",
    description: "Import or triage a GitHub Issue as an AI Office intake record.",
    argumentsFormat: "<issue-number|issue-url> [--create-task] [--ask-info] [--link-task=<task-id>]",
    examples: ["{{SELF}} #123 --create-task", "{{SELF}} https://github.com/owner/repo/issues/123"],
    steps: [
      "Read `.ai-office/issue-intake.md`, `.ai-office/templates/github-issue-intake.md`, and `.ai-office/project.config.md`.",
      "If GitHub API/sync metadata is unavailable, create a manual intake stub without failing.",
      "Create `.ai-office/intake/issue-<number>.md` preserving issue metadata, classification, severity, actionability, linked task, linked commits, linked PR, and response plan.",
      "Optionally create or link an AI Office task when requested.",
      "Do not comment on or close GitHub issues unless explicitly requested and configured.",
    ],
  },
  {
    id: "office-issue-triage",
    description: "Classify and decide next action for an issue intake record.",
    argumentsFormat: "<issue-number|intake-file>",
    examples: ["{{SELF}} #123", "{{SELF}} .ai-office/intake/issue-123.md"],
    steps: [
      "Read the intake record and `.ai-office/templates/user-report-triage.md`.",
      "Classify the report as bug, feature-request, support, documentation, ux-feedback, performance, security, incident, question, duplicate, invalid, or needs-info.",
      "Identify missing reproduction info, severity, impact, recommended path, and stop conditions.",
      "For security reports, avoid public sensitive details and recommend private escalation.",
    ],
  },
  {
    id: "office-issue-link",
    description: "Link a GitHub Issue to an AI Office task.",
    argumentsFormat: "<issue-number|issue-url> <task-id>",
    examples: ["{{SELF}} #123 M1_T003"],
    steps: [
      "Find the task file and update its `## GitHub` section with issue number and URL when available.",
      "Update the matching `.ai-office/intake/issue-<number>.md` record if present.",
      "Preserve existing commit and PR traceability.",
      "Append task history documenting the link.",
    ],
  },
  {
    id: "office-issue-response",
    description: "Draft a GitHub Issue response from current AI Office state.",
    argumentsFormat: "<issue-number|task-id> [accepted|needs-info|fixed|duplicate|not-planned]",
    examples: ["{{SELF}} #123 fixed", "{{SELF}} M1_T003 needs-info"],
    steps: [
      "Read `.ai-office/templates/issue-response.md`, linked task metadata, GitHub issue metadata, commit links, PR links, and verification evidence.",
      "Draft a markdown response but do not post automatically by default.",
      "For fixed responses, include linked commit or PR and verification evidence when available.",
      "For security reports, avoid sensitive vulnerability details in public comments.",
    ],
  },
  {
    id: "office-route",
    description: "Route a new request through AI Office and recommend the right next step.",
    argumentsFormat: "<request>",
    argumentGuidance: [
      "Treat the full argument string as the incoming request to classify.",
    ],
    examples: [
      "{{SELF}} Add user profile editing",
      "{{SELF}} Audit subscription refunds flow",
    ],
    steps: [
      "Read `AI-OFFICE.md`, `.ai-office/project.config.md`, `.ai-office/office-profile.md`, `.ai-office/pipeline.md`, `.ai-office/agent-operating-model.md`, and `.ai-office/collaboration-gates.md` if they exist.",
      "Summarize the request in one sentence and classify it as quick fix, feature, refactor, audit, or operational task.",
      "Decide whether an intent check is required by `require_intent_check` and whether tiny-fix-fast-path applies.",
      "For non-trivial work, recommend or run `{{CMD:office-intent-check}}` before implementation.",
      "If the request requires code or documentation changes and is not truly tiny, create or identify the AI Office task before implementation.",
      "If it is truly tiny, ask whether the user wants a task created or wants to proceed with the immediate fix.",
      "Check `pre_implementation_mode` in `.ai-office/project.config.md` when present.",
      "Check `interactive_choices_mode` in `.ai-office/project.config.md` when present.",
      "If `pre_implementation_mode` is `minimal`, ask only the minimum clarifying questions needed to avoid routing the work incorrectly.",
      "If `pre_implementation_mode` is `confirm`, finish the analysis, propose one plan, and ask the user to confirm it before implementation starts.",
      "If `pre_implementation_mode` is `collaborative`, finish the analysis, propose the recommended path plus 1-2 viable alternatives for non-trivial work, and ask which approach the user prefers or whether they want a different one.",
      "If `interactive_choices_mode` is `buttons-when-available`, prefer host-provided structured choices for plan confirmation or approach selection, with concise text fallback when unavailable.",
      "Identify the likely next artifact or generated pipeline stage from `.ai-office/pipeline.md`, including whether a PRD, ADR, plan, or direct task work is appropriate.",
      "Create or update the relevant `.ai-office/docs/` context artifact when appropriate.",
      "End with the recommended next action: create task, write plan, ask user, implement tiny fix, audit only, or queue background-capable task.",
    ],
  },
  {
    id: "office-advance",
    description: "Advance work to the next AI Office stage after checking readiness and evidence.",
    argumentsFormat: "<slug> <evidence> [next-stage]",
    argumentGuidance: [
      "The first argument is the pipeline slug.",
      "The second argument is a short evidence summary.",
      "The optional third argument is the target stage if it should not be inferred.",
    ],
    examples: [
      "{{SELF}} billing-sync \"PRD approved and scope frozen\" adr",
      "{{SELF}} search-rewrite \"dev checks passed and review complete\" user_acceptance",
    ],
    steps: [
      "Read `AI-OFFICE.md` and the relevant `.ai-office/docs/runbooks/<slug>-status.md` file if present.",
      "Confirm the current stage, the requested next stage, and the evidence available.",
      "Check that the current artifact set is complete enough for the transition.",
      "If the transition is not ready, explain the exact missing artifact or evidence instead of advancing.",
      "If the transition is ready, update the relevant status artifact and summarize the next owner and next workflow.",
    ],
  },
  {
    id: "office-doctor",
    description: "Check the health of the AI Office installation in the current workspace.",
    steps: [
      "Prefer the deterministic CLI by running `ai-office doctor`.",
      "Report the detected adapter.",
      "Summarize PASS and WARN lines in a concise checklist.",
      "If any required file is missing, say what to reinstall, regenerate, or configure next.",
    ],
  },
  {
    id: "office-milestone",
    description: "Create, inspect, or list AI Office milestones using the deterministic CLI.",
    argumentsFormat: "create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask] | status <id> | list",
    examples: [
      "{{SELF}} create M1 Billing Sync target:2026-05-01 tasks:yes",
      "{{SELF}} status M1",
      "{{SELF}} list",
    ],
    steps: [
      "Determine whether the user wants to create a milestone, inspect a milestone, or list milestones.",
      "For create, collect the milestone id, name, and any optional `target:` or `tasks:` arguments, then run `ai-office milestone create ...`.",
      "For inspect, run `ai-office milestone status <id>`.",
      "For list, run `ai-office milestone list`.",
      "Summarize milestone progress and call out any auto-created tasks.",
    ],
  },
  {
    id: "office-setup",
    description: "Configure or reconfigure a custom project office for the current repository.",
    argumentsFormat: "[setup flags]",
    examples: [
      "{{SELF}}",
      "{{SELF}} --auto --non-interactive",
      "{{SELF}} --agency=software-studio --stack=node-react --non-interactive",
      "{{SELF}} --reconfigure --advance-mode=auto",
    ],
    steps: [
      "If the user wants interactive setup, run `./setup.sh .` and prefer the default custom project office flow.",
      "If the user wants deterministic setup, run `./setup.sh . --auto --non-interactive <flags>` unless they explicitly request a legacy agency preset.",
      "Treat `--agency=<name>` as a legacy preset path, not the default onboarding path.",
      "If the project is already configured and the user wants to change it, prefer `./setup.sh . --reconfigure ...`.",
      "Summarize the generated office profile, pipeline, roles, quality gates, and next AI Office command to run.",
    ],
  },
  {
    id: "office-status",
    description: "Read or update the AI Office status for a pipeline slug.",
    argumentsFormat: "<slug> [state] [owner] [notes]",
    argumentGuidance: [
      "With only a slug, this is a read operation.",
      "With state, owner, and notes, this is a deterministic update.",
    ],
    examples: [
      "{{SELF}} billing-sync",
      "{{SELF}} billing-sync dev Developer \"Implementation started\"",
    ],
    steps: [
      "If the user wants the current state, run `ai-office status get <slug>` and summarize the result.",
      "If the user wants to update state, collect slug, state, owner, and notes, then run `ai-office status set <slug> <state> <owner> \"<notes>\"`.",
      "Report the updated state and any important next-stage implication.",
      "If required update fields are missing, ask only for the missing required values.",
    ],
  },
  {
    id: "office-task-create",
    description: "Create a task on the AI Office board using the deterministic CLI.",
    argumentsFormat: "<title> [ms:M1] [priority:HIGH|MEDIUM|LOW] [column:BACKLOG|TODO] [assignee:name] [deps:id,...] [estimate:4h] [labels:tag1,tag2] [slug:feature-slug]",
    argumentGuidance: [
      "Treat everything before the first keyword flag as the task title.",
      "Pass optional metadata through without inventing missing values.",
    ],
    examples: [
      "{{SELF}} Fix upload timeout",
      "{{SELF}} Add billing page ms:M1 priority:HIGH column:TODO assignee:Developer estimate:4h labels:feature,billing slug:billing-flow",
    ],
    steps: [
      "Parse the task title and any provided metadata flags.",
      "Include whether the task requires an intent check, whether background-capable mode applies, and the suggested owner or role from `.ai-office/roles/` when this can be inferred.",
      "Initialize GitHub and Git Traceability sections so task-to-commit and issue linking can be tracked.",
      "Run `ai-office task create ...` with the parsed values.",
      "Return the created task id, column, and filename.",
      "If the task should move immediately after creation, suggest `{{CMD:office-task-move}}`.",
    ],
  },
  {
    id: "office-task-commit",
    description: "Link one or more Git commits to an AI Office task.",
    argumentsFormat: "<task-id> [commit-sha] [status:committed|integrated|no-code|docs-only|superseded] [verification:<summary>] [issue:#123] [pr:#456] [--detect]",
    examples: [
      "{{SELF}} M1_T003 abc1234 verification:\"bun test passed\"",
      "{{SELF}} M1_T003 --detect verification:\"typecheck, lint, tests passed\"",
      "{{SELF}} M1_T003 no-code verification:\"README only\"",
    ],
    steps: [
      "Find the task file by task id.",
      "Validate provided commit SHAs with local git; for `--detect`, link current HEAD.",
      "Update the task `## Git Traceability` section without overwriting existing commit links.",
      "Update the task `## GitHub` section when issue or PR metadata is provided.",
      "Append task history and preserve human-readable markdown.",
    ],
  },
  {
    id: "office-task-trace",
    description: "Show task, commit, GitHub issue, PR, verification, and integration traceability.",
    argumentsFormat: "<task-id|commit-sha|issue-number>",
    examples: ["{{SELF}} M1_T003", "{{SELF}} abc1234", "{{SELF}} #123"],
    steps: [
      "Search task files by task id, linked commit SHA, or GitHub issue number.",
      "Show linked commits, branch, worktree, issue, PR, verification, and integration status.",
      "If no match exists, suggest `{{CMD:office-task-commit}}` or `{{CMD:office-issue-link}}`.",
    ],
  },
  {
    id: "office-task-integrate",
    description: "Integrate a reviewed task branch into the configured merge target.",
    argumentsFormat: "<task-id> [reason]",
    examples: [
      "{{SELF}} M1_T003",
      "{{SELF}} M1_T003 \"QA approved for UAT\"",
    ],
    steps: [
      "Confirm the task id to integrate.",
      "Read `.ai-office/project.config.md` if needed to understand task isolation settings.",
      "Ensure the task branch or worktree has only committed task-related changes before integrating.",
      "Run `ai-office task integrate <task-id>` and include any provided reason if supported by the CLI.",
      "Report the integration target branch and any follow-up step for UAT or release.",
    ],
  },
  {
    id: "office-task-move",
    description: "Move a task between AI Office board columns and keep history consistent.",
    argumentsFormat: "<task-id> <column> [reason]",
    examples: [
      "{{SELF}} M0_T001 WIP \"started work\"",
      "{{SELF}} M1_T004 REVIEW \"acceptance criteria met\"",
    ],
    steps: [
      "Collect the task id, destination column, and optional reason.",
      "Run `ai-office task move <task-id> <column> \"<reason>\"`.",
      "Summarize the move and call out any branch or worktree information created as part of task isolation.",
      "If the move implies a next workflow, suggest it explicitly.",
    ],
  },
  {
    id: "office-task-update",
    description: "Update AI Office task metadata without moving the task.",
    argumentsFormat: "<task-id> [priority:...] [assignee:...] [estimate:...] [labels:...] [slug:...]",
    examples: [
      "{{SELF}} M0_T001 priority:HIGH labels:billing,backend estimate:3h",
    ],
    steps: [
      "Collect the task id and only the fields the user wants to change.",
      "Run `ai-office task update <task-id> ...`.",
      "Confirm the updated metadata and mention any meaningful effect on milestone or workflow tracking.",
    ],
  },
  {
    id: "office-validate",
    description: "Run deterministic AI Office validation for a pipeline stage.",
    argumentsFormat: "<slug> <stage>",
    examples: [
      "{{SELF}} billing-sync prd",
      "{{SELF}} search-rewrite dev",
    ],
    steps: [
      "Collect the feature slug and stage.",
      "Read `.ai-office/quality-gates.md` when present so project-specific gates are included in the validation summary.",
      "Read `.ai-office/collaboration-gates.md` and check whether required intent check and implementation plan artifacts exist when `require_intent_check` or `require_plan_before_code` are enabled.",
      "Run `ai-office validate <slug> <stage>`.",
      "Summarize the pass, warn, and fail results.",
      "If validation fails, explain the smallest useful next action instead of claiming the work is complete.",
    ],
  },
];

export const WINDSURF_RULE_BODY = `---
trigger: model_decision
description: Use this rule when the user mentions AI Office, .ai-office artifacts, milestones, task board operations, status files, or any /office workflow.
---

# AI Office Workspace Rule

1. Read \`AI-OFFICE.md\` before making assumptions about workflow stages, artifacts, or handoffs.
2. Treat \`.ai-office/\` artifacts as the source of truth for project state.
3. Prefer the deterministic \`ai-office\` CLI for state changes such as task creation, task moves, status updates, milestone operations, and validation.
4. Use the matching \`/office-*\` workflow when the user is asking for a repeatable AI Office operation.
5. Keep Windsurf-specific wrapper behavior thin. The framework logic lives in \`AI-OFFICE.md\`, \`.ai-office/\`, and the CLI.
`;

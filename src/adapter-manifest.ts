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
  "office-doctor",
  "office-milestone",
  "office-route",
  "office-setup",
  "office-status",
  "office-task-create",
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
      "Read `AI-OFFICE.md` and check `.ai-office/project.config.md` when present.",
      "Infer whether the user needs routing, status, task board work, milestone management, validation, setup, or a doctor check.",
      "For a new feature, bug, audit, or initiative, call `{{CMD:office-route}}`.",
      "For task board mutations, prefer `{{CMD:office-task-create}}`, `{{CMD:office-task-move}}`, `{{CMD:office-task-update}}`, or `{{CMD:office-task-integrate}}`.",
      "For milestone operations, call `{{CMD:office-milestone}}`.",
      "For stage readiness, call `{{CMD:office-validate}}` or `{{CMD:office-advance}}`.",
      "For installation or configuration checks, call `{{CMD:office-doctor}}` or `{{CMD:office-setup}}`.",
      "Prefer deterministic `ai-office` CLI commands for state mutations whenever the CLI supports the operation.",
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
      "Read `AI-OFFICE.md` and `.ai-office/project.config.md` if it exists.",
      "Summarize the request in one sentence and classify it as quick fix, feature, refactor, audit, or operational task.",
      "Check `pre_implementation_mode` in `.ai-office/project.config.md` when present.",
      "If `pre_implementation_mode` is `minimal`, ask only the minimum clarifying questions needed to avoid routing the work incorrectly.",
      "If `pre_implementation_mode` is `confirm`, finish the analysis, propose one plan, and ask the user to confirm it before implementation starts.",
      "If `pre_implementation_mode` is `collaborative`, finish the analysis, propose the recommended path plus 1-2 viable alternatives for non-trivial work, and ask which approach the user prefers or whether they want a different one.",
      "Identify the likely next artifact or pipeline stage, including whether a PRD, ADR, plan, or direct task work is appropriate.",
      "Create or update the relevant `.ai-office/docs/` context artifact when appropriate.",
      "End with the recommended next action, including the next AI Office command or CLI operation.",
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
    description: "Configure or reconfigure AI Office for the current project.",
    argumentsFormat: "[setup flags]",
    examples: [
      "{{SELF}}",
      "{{SELF}} --agency=software-studio --stack=node-react --non-interactive",
      "{{SELF}} --reconfigure --advance-mode=auto",
    ],
    steps: [
      "If the user wants interactive setup, run `./setup.sh .`.",
      "If the user wants deterministic setup, collect the needed flags and run `./setup.sh . <flags>`.",
      "If the project is already configured and the user wants to change it, prefer `./setup.sh . --reconfigure ...`.",
      "Summarize the resulting configuration and the next AI Office command to run.",
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
      "Run `ai-office task create ...` with the parsed values.",
      "Return the created task id, column, and filename.",
      "If the task should move immediately after creation, suggest `{{CMD:office-task-move}}`.",
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

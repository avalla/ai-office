import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";

export interface OfficeGenerationInput {
  aiOfficeDir: string;
  frameworkDir?: string;
  office: string;
  officeMode: "custom" | "legacy-preset" | "custom-from-preset";
  legacyAgencyPreset?: string;
  projectName: string;
  projectType?: string;
  language?: string;
  languageToolchain?: string;
  jsPackageManager?: string;
  uiFramework?: string;
  designSystem?: string;
  testRunner?: string;
  typecheckCmd?: string;
  lintCmd?: string;
  testCmd?: string;
  pipeline?: string;
  roles?: string[];
  riskAreas?: string[];
  qualityGates?: string[];
  repositorySignals?: string[];
  maxContextFiles: string;
  maxReviewIterations: string;
}

function listMarkdown(items: string[] | undefined, fallback: string): string {
  const values = items?.map((item) => item.trim()).filter(Boolean);
  if (!values?.length) return `- ${fallback}`;
  return values.map((item) => `- ${item}`).join("\n");
}

function titleize(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function writeRoleFile(input: OfficeGenerationInput, roleSlug: string): void {
  const roleTitle = titleize(roleSlug);
  const rolePath = join(input.aiOfficeDir, "roles", `${roleSlug}.md`);
  let purpose = `Own the ${roleSlug} perspective for the current pipeline stage.`;
  let invoke = "Invoke only when the current stage needs this role's specific judgement.";
  const inputs = "Current request, office-profile.md, pipeline.md, current stage artifact, and no more than one supporting file unless required.";
  const outputs = "Short findings, concrete next action, changed artifact paths, and evidence required for the next gate.";
  let stop = "Stop when the stage output is complete, required evidence is missing, or risk exceeds the role mandate.";

  if (roleSlug === "product") purpose = "Clarify user value, scope, acceptance criteria, and tradeoffs.";
  if (roleSlug === "architect") purpose = "Select the smallest defensible technical approach for the detected stack.";
  if (roleSlug === "developer") purpose = "Implement focused changes that match the generated pipeline and local code patterns.";
  if (roleSlug === "qa") purpose = "Verify acceptance criteria with deterministic checks and regression coverage.";
  if (roleSlug === "reviewer") purpose = "Find correctness, maintainability, and release risks before handoff.";
  if (roleSlug === "database-security") {
    purpose = "Review schema, migrations, RLS, policies, and data access boundaries.";
    invoke = "Invoke for Supabase/Postgres schema, migration, RLS, or data-permission work.";
  }
  if (roleSlug === "ux") {
    purpose = "Review user flows, component behavior, visual quality, and accessibility.";
    invoke = "Invoke for UI, copy, design-system, accessibility, or visual QA work.";
  }
  if (roleSlug === "ops") {
    purpose = "Review deployment, CI, infra, dry-run, validation, and rollback concerns.";
    invoke = "Invoke for Docker, hosting, CI, Cloudflare, Vercel, Netlify, or operational changes.";
  }
  if (roleSlug === "security") {
    purpose = "Review auth, payments, secrets, permissions, and sensitive control paths.";
    invoke = "Invoke for auth, billing, secrets, permissions, or security-sensitive changes.";
  }

  writeFileSync(rolePath, `# Role: ${roleTitle}

## Purpose
${purpose}

## When to invoke
${invoke}

## Inputs required
${inputs}

## Outputs
${outputs}

## Token budget
Load only this role, current stage artifact, and up to ${input.maxContextFiles} total context files. Prefer summaries over full history.

## Stop conditions
${stop}
`);
}

function readPresetTitle(input: OfficeGenerationInput): string {
  const preset = input.legacyAgencyPreset || input.office;
  const presetConfig = input.frameworkDir ? join(input.frameworkDir, "skeleton/core/.ai-office/agencies", preset, "config.md") : "";
  if (!presetConfig || !existsSync(presetConfig)) return titleize(preset);
  const text = readFileSync(presetConfig, "utf8");
  return text.match(/^name:\s*(.+)$/m)?.[1]?.trim() || titleize(preset);
}

function cleanRoles(aiOfficeDir: string): void {
  const rolesDir = join(aiOfficeDir, "roles");
  rmSync(rolesDir, { recursive: true, force: true });
  mkdirSync(rolesDir, { recursive: true });
}

function generateAgentOperatingArtifacts(input: OfficeGenerationInput): void {
  const templatesDir = join(input.aiOfficeDir, "templates");
  const backgroundDir = join(input.aiOfficeDir, "background");
  const intakeDir = join(input.aiOfficeDir, "intake");
  mkdirSync(templatesDir, { recursive: true });
  mkdirSync(backgroundDir, { recursive: true });
  mkdirSync(intakeDir, { recursive: true });

  writeFileSync(join(input.aiOfficeDir, "agent-operating-model.md"), `# Agent Operating Model

## Purpose

AI Office makes AI coding agents less reactive and more disciplined.

Before implementation, agents should verify intent, classify the work, identify risks, propose a minimal safe plan, and only then modify files.

## Default Mode

review-first

## Operating Principles

- Do not implement non-trivial changes before an intent check.
- Do not create code when documentation, configuration, or a smaller refactor is enough.
- Prefer the smallest safe change.
- Prefer deterministic CLI commands for AI Office state mutations.
- Use generated project office artifacts as source of truth.
- Link implementation tasks to commits, verification evidence, and integration status.
- Link GitHub issues and PRs when issue sync or issue intake is enabled.
- Load only the current stage context and relevant files.
- Stop when product or architecture mismatch is detected.
- Escalate when the task is too ambiguous, too broad, or risks hidden complexity.

## Task Modes

| Mode | Meaning |
|------|---------|
| review-first | Review intent and plan before implementation |
| execute-after-plan | Implement only after plan is accepted or clearly safe |
| tiny-fix-fast-path | Allow immediate fix for very small, low-risk changes |
| background-capable | Queue or schedule resumable work when true background execution is unavailable |
| audit-only | Review and report findings, no code changes |

## Stop Conditions

Stop before coding when:

- the requested change conflicts with the product model
- naming or UX would become misleading
- the change adds avoidable complexity
- required context is missing
- security, data, billing, auth, RLS, infra, or migration risk is unclear
- the work is too broad for one task
- a required implementation task has no commit, no verification, and no no-code/docs-only/superseded status
`);

  writeFileSync(join(input.aiOfficeDir, "collaboration-gates.md"), `# Collaboration Gates

## Gate 1: Intent Check

Required for every non-trivial request.

The agent must answer:

- What is the user really trying to achieve?
- Is this a code change, documentation change, configuration change, or product decision?
- Is the requested implementation actually the best path?
- Is there a simpler solution?
- What could go wrong?

## Gate 2: Plan Before Code

Required before implementation unless the task qualifies for tiny-fix-fast-path.

The plan must include:

- files likely to change
- expected behavior change
- tests or validation commands
- risk level
- rollback or recovery note if relevant

## Gate 3: Implementation

Implementation must follow the accepted or clearly safe plan.

The agent should avoid unrelated refactors.

## Gate 4: Verification

The agent must run or recommend deterministic checks:

- typecheck
- lint
- tests
- project-specific quality gates
- generated quality-gates.md checks

## Gate 5: Summary and Memory

The agent must summarize:

- what changed
- why it changed
- how it was verified
- linked task, commit, issue, PR, and integration status when applicable
- what remains risky or incomplete
- which AI Office artifacts should be updated

## Tiny Fix Fast Path

A task qualifies as tiny only if all are true:

- one or two files maximum
- no schema, auth, payment, infra, RLS, security, or public API impact
- no naming/product model ambiguity
- no architectural decision needed
- easy to verify

Even tiny fixes should end with a short summary and verification note.
`);

  writeFileSync(join(templatesDir, "intent-check.md"), `# Intent Check: [Request]

## Request Summary

...

## Task Type

feature | bugfix | refactor | docs | infra | security | product-decision | audit | other

## Is Code Required?

yes | no | unclear

## Product Fit

...

## Architecture Fit

...

## Naming / UX Fit

...

## Complexity Risk

low | medium | high

## Security / Data / Infra Risk

low | medium | high

## Recommended Path

...

## Alternative Paths

1. ...
2. ...

## Stop Conditions

...

## Next Action

create-task | write-plan | ask-user | implement-tiny-fix | audit-only | queue-background-task
`);

  writeFileSync(join(templatesDir, "implementation-plan.md"), `# Implementation Plan: [Task]

## Goal

...

## Scope

### In Scope

- ...

### Out of Scope

- ...

## Files Likely to Change

- ...

## Steps

1. ...
2. ...
3. ...

## Validation

- Typecheck:
- Lint:
- Tests:
- Project-specific gates:

## Traceability

- AI Office Task:
- GitHub Issue:
- Planned Commit Reference:
- Verification Evidence:

## Risks

...

## Rollback / Recovery

...

## Completion Criteria

- ...
`);

  writeFileSync(join(templatesDir, "background-task.md"), `# Background-Capable Task: [Task]

## Purpose

...

## Background Mode

queued | scheduled | watcher | long-running | manual-resume

## Host Capability

true-background | simulated-background | manual-resume-only

## Trigger

manual | schedule | file-change | CI | GitHub issue | status-change

## Inputs

- ...

## Expected Outputs

- ...

## State File

.ai-office/background/[slug]-status.md

## Checkpoint Strategy

- ...

## Stop Conditions

- ...

## Resume Instructions

...

## Verification

...

## Traceability

- Linked task:
- Linked issue:
- Linked commits:
- Integration status:
`);

  writeFileSync(join(backgroundDir, "README.md"), `# Background Work

This directory tracks background-capable AI Office tasks.

AI Office does not assume every host can run agents in the background.

When true background execution is unavailable, background work is represented as:

- queued task files
- scheduled checks
- resumable status files
- manual continuation instructions
- CI/GitHub-triggered workflows

Each background task should have a status file with:

- current state
- last checkpoint
- next action
- owner
- stop condition
- verification evidence
`);

  writeFileSync(join(input.aiOfficeDir, "task-commit-policy.md"), `# Task Commit Policy

AI Office links implementation tasks to Git commits for traceability.

## Rule

Each implementation task should have at least one linked commit before it is marked DONE, unless the task is explicitly marked:

- no-code
- docs-only
- superseded

## GitHub Issues

When GitHub issue linking is enabled, tasks may also be linked to GitHub issues and pull requests.

Recommended traceability chain:

\`\`\`text
AI Office Task -> GitHub Issue -> Commit(s) -> Pull Request -> Integration
\`\`\`

## Commit Message

Preferred formats depend on commit_reference_style.

Task only:

\`\`\`text
M1_T003: fix upload timeout handling
\`\`\`

Task and GitHub issue:

\`\`\`text
M1_T003: fix upload timeout handling (#123)
\`\`\`

Conventional:

\`\`\`text
fix(M1_T003): prevent upload timeout
\`\`\`

Do not use closing keywords such as \`Fixes #123\` unless explicitly configured.

## Verification

Before linking or creating a commit, record verification evidence:

- typecheck
- lint
- tests
- project-specific quality gates

## Integration

When a task branch or worktree is integrated, record the integration commit or merge commit when available.
`);

  writeFileSync(join(input.aiOfficeDir, "issue-intake.md"), `# Issue Intake

AI Office can process user-reported GitHub Issues as structured work.

## Flow

\`\`\`text
GitHub Issue
-> Intake
-> Classification
-> Task
-> Intent Check
-> Plan
-> Commit / PR
-> Verification
-> Issue Update
\`\`\`

## Intake Rules

- Do not treat every issue as immediately actionable.
- Classify first.
- Ask for missing reproduction details when needed.
- Link each actionable issue to an AI Office task.
- Link commits and PRs back to the issue when work is done.
- Preserve user-provided context.
- Avoid exposing private/security-sensitive details in public comments.
- Security reports should be escalated and not discussed publicly unless safe.

## Issue Classes

| Type | Meaning | Default Action |
|------|---------|----------------|
| bug | Something is broken | triage + reproduce |
| feature-request | New requested behavior | product review |
| support | User needs help | respond or document |
| documentation | Missing/wrong docs | docs task |
| ux-feedback | Usability issue | UX review |
| performance | Slow or inefficient behavior | benchmark/reproduce |
| security | Vulnerability or sensitive issue | private escalation |
| incident | Production-impacting issue | incident workflow |
| question | User asks how something works | answer or docs task |
| duplicate | Existing issue covers it | link duplicate |
| invalid | Not actionable | close with explanation |
| needs-info | Missing details | ask user for info |

## Security Reports

- Do not post detailed vulnerability analysis publicly by default.
- Do not expose secrets, exploit details, tokens, or private infrastructure details.
- Mark as security.
- Set severity.
- Recommend private escalation.
- If GitHub private vulnerability reporting is not available, advise maintainers to move discussion to a private channel.
`);

  writeFileSync(join(templatesDir, "github-issue-intake.md"), `# GitHub Issue Intake: #[issue-number]

## Source

| Field | Value |
|-------|-------|
| Issue | #[issue-number] |
| URL | [issue-url] |
| Author | [author] |
| Created | [created-at] |
| Labels | [labels] |

## Summary

...

## User-Reported Problem

...

## Expected Behavior

...

## Actual Behavior

...

## Reproduction Steps

1. ...

## Environment

- OS:
- Browser:
- Version:
- Deployment:
- Logs/screenshots:

## Classification

bug | feature-request | support | documentation | ux-feedback | performance | security | incident | question | duplicate | invalid | needs-info

## Severity

low | medium | high | critical

## Confidence

low | medium | high

## Is Actionable?

yes | no | needs-info

## Suggested AI Office Task

...

## Linked Task

...

## Linked Commits

...

## Linked PR

...

## Response Plan

...

## Next Action

create-task | ask-for-info | mark-duplicate | close-invalid | investigate | escalate-security | create-docs-task
`);

  writeFileSync(join(templatesDir, "user-report-triage.md"), `# User Report Triage

## Report Summary

...

## Classification

...

## Severity

...

## Impact

- Users affected:
- Frequency:
- Business impact:
- Security/data impact:

## Reproduction

- Reproduced: yes | no | not attempted
- Steps:
- Evidence:

## Root Cause Hypothesis

...

## Recommended Path

...

## AI Office Task

...

## GitHub Issue Response

...

## Stop Conditions

- Missing reproduction details
- Security-sensitive report
- Duplicate issue found
- Not enough product context
`);

  writeFileSync(join(templatesDir, "issue-response.md"), `# Issue Response

## Acknowledge

Thanks for the report. I am going to triage this and check whether it is reproducible.

## Needs Info

Could you provide:

- steps to reproduce
- expected behavior
- actual behavior
- environment/version
- screenshots/logs if available

## Accepted

Thanks, this is reproducible and has been linked to internal task \`[task-id]\`.

## Fixed

This has been addressed in \`[commit-or-pr]\`. Verification: \`[summary]\`.

## Duplicate

Thanks, this appears to be covered by #[existing-issue]. I am linking this there to keep the discussion in one place.

## Not Planned

Thanks for the suggestion. This does not fit the current product direction because \`[reason]\`.
`);

  writeFileSync(join(intakeDir, "README.md"), `# Intake

This directory stores structured intake records created from external reports, especially GitHub Issues.

Each intake record should preserve:

- original issue metadata
- classification
- severity
- reproduction status
- linked AI Office task
- linked commits
- linked PR
- response status

Intake records are not a replacement for GitHub Issues.
They are the AI Office memory layer for turning user reports into traceable work.
`);
}

export function generateCustomOffice(input: OfficeGenerationInput): void {
  mkdirSync(input.aiOfficeDir, { recursive: true });
  cleanRoles(input.aiOfficeDir);
  generateAgentOperatingArtifacts(input);

  const roles = input.roles?.length ? input.roles : ["product", "architect", "developer", "qa", "reviewer"];
  const pipeline = input.pipeline || "request -> clarify -> PRD -> architecture -> plan -> implementation -> tests -> review -> release";

  writeFileSync(join(input.aiOfficeDir, "office-profile.md"), `# Office Profile

## Project Type
${input.projectType || "software project"}

## Detected Stack
- Language: ${input.language || "unknown"}
- Toolchain: ${input.languageToolchain || "none detected"}
- JavaScript package manager: ${input.jsPackageManager || "none detected"}
- UI framework: ${input.uiFramework || "none detected"}
- Design system: ${input.designSystem || "none detected"}
- Test runner: ${input.testRunner || "none detected"}

## Repository Signals
${listMarkdown(input.repositorySignals, "No strong repository signals detected")}

## Recommended Workflow
${pipeline}

## Recommended Roles
${listMarkdown(roles, "developer")}

## Quality Gates
${listMarkdown(input.qualityGates, "review")}

## Risk Areas
${listMarkdown(input.riskAreas, "general correctness")}

## Token Efficiency Rules
- never load all roles
- never load all historical docs
- load only current stage artifacts
- prefer summaries over full conversations
- use deterministic CLI for state changes
- summarize completed stages into status files
- cap review/QA loops
- ask for missing files only when necessary
`);

  writeFileSync(join(input.aiOfficeDir, "pipeline.md"), `# Project Pipeline

## Default Flow
${pipeline}

## Operating Rules
- Use the current stage artifact as the primary context.
- Run deterministic CLI commands for task and status state changes.
- Record evidence in status files before advancing.
- Stop after ${input.maxReviewIterations} review or QA loops and escalate with unblock criteria.
`);

  writeFileSync(join(input.aiOfficeDir, "quality-gates.md"), `# Quality Gates

## Project-Specific Gates
${listMarkdown(input.qualityGates, "review")}

## Verification Commands
- Typecheck: ${input.typecheckCmd || "none configured"}
- Lint: ${input.lintCmd || "none configured"}
- Test: ${input.testCmd || "none configured"}

## Risk Gates
${listMarkdown(input.riskAreas, "general correctness")}
`);

  for (const role of roles) writeRoleFile(input, role);
}

export function generateLegacyOfficeSummary(input: OfficeGenerationInput): void {
  mkdirSync(input.aiOfficeDir, { recursive: true });
  cleanRoles(input.aiOfficeDir);
  generateAgentOperatingArtifacts(input);
  const preset = input.legacyAgencyPreset || input.office;
  const presetTitle = readPresetTitle(input);
  const presetPipeline = input.frameworkDir ? join(input.frameworkDir, "skeleton/core/.ai-office/agencies", preset, "pipeline.md") : "";
  const pipelineText = presetPipeline && existsSync(presetPipeline)
    ? `Preset pipeline source: ${presetPipeline.replace(input.frameworkDir || "", "").replace(/^\//, "")}`
    : "Preset pipeline source: bundled legacy preset";

  writeFileSync(join(input.aiOfficeDir, "office-profile.md"), `# Office Profile

## Office
${input.office}

## Office Mode
legacy-preset

## Legacy Preset
${preset}

## Summary
This workspace is configured to use the \`${preset}\` legacy preset. It is not a repository-analyzed custom office.

## Preset Name
${presetTitle}

## Token Efficiency Rules
- never load all legacy role profiles
- load only the current command, current task, and relevant stage artifact
- prefer generated summaries over historical conversations
- use deterministic CLI for state changes
- cap review/QA loops
`);

  writeFileSync(join(input.aiOfficeDir, "pipeline.md"), `# Legacy Preset Pipeline

## Mode
legacy-preset

## Legacy Preset
${preset}

## Source
${pipelineText}
`);

  writeFileSync(join(input.aiOfficeDir, "quality-gates.md"), `# Quality Gates

## Mode
legacy-preset

## Legacy Preset
${preset}

Use this preset's bundled quality guidance as compatibility context. Prefer project-specific gates from a regenerated custom office when moving to the default v1.17 workflow.
`);
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) || [];
}

if (import.meta.main) {
  const input: OfficeGenerationInput = {
    aiOfficeDir: process.env.AI_OFFICE || ".ai-office",
    frameworkDir: process.env.FRAMEWORK_DIR,
    office: process.env.OFFICE || process.env.SELECTED_AGENCY || "custom-office",
    officeMode: (process.env.OFFICE_MODE as OfficeGenerationInput["officeMode"]) || "custom",
    legacyAgencyPreset: process.env.LEGACY_AGENCY_PRESET || undefined,
    projectName: process.env.PROJECT_NAME || basename(process.cwd()),
    projectType: process.env.DETECTED_PROJECT_TYPE,
    language: process.env.DETECTED_LANGUAGE,
    languageToolchain: process.env.DETECTED_LANGUAGE_TOOLCHAIN,
    jsPackageManager: process.env.NODE_PACKAGE_MANAGER,
    uiFramework: process.env.UI_FRAMEWORK,
    designSystem: process.env.DESIGN_SYSTEM,
    testRunner: process.env.TEST_RUNNER,
    typecheckCmd: process.env.TYPECHECK_CMD,
    lintCmd: process.env.LINT_CMD,
    testCmd: process.env.TEST_CMD,
    pipeline: process.env.DETECTED_PIPELINE,
    roles: splitList(process.env.DETECTED_ROLES),
    riskAreas: splitList(process.env.DETECTED_RISK_AREAS),
    qualityGates: splitList(process.env.DETECTED_QUALITY_GATES),
    repositorySignals: process.env.DETECTED_REPOSITORY_SIGNALS?.split(";").map((item) => item.trim()).filter(Boolean),
    maxContextFiles: process.env.TOKEN_BUDGET_MAX_CONTEXT_FILES || "8",
    maxReviewIterations: process.env.TOKEN_BUDGET_MAX_REVIEW_ITERATIONS || "2",
  };

  if (input.officeMode === "legacy-preset") {
    generateLegacyOfficeSummary(input);
    console.log("  ✅ Generated .ai-office/office-profile.md (legacy preset summary)");
    console.log("  ✅ Generated .ai-office/pipeline.md (legacy preset summary)");
    console.log("  ✅ Generated .ai-office/quality-gates.md (legacy preset summary)");
    console.log("  ✅ Generated .ai-office/agent-operating-model.md");
    console.log("  ✅ Generated .ai-office/collaboration-gates.md");
  } else {
    generateCustomOffice(input);
    console.log("  ✅ Generated .ai-office/office-profile.md");
    console.log("  ✅ Generated .ai-office/pipeline.md");
    console.log("  ✅ Generated .ai-office/quality-gates.md");
    console.log("  ✅ Generated .ai-office/roles/*.md");
    console.log("  ✅ Generated .ai-office/agent-operating-model.md");
    console.log("  ✅ Generated .ai-office/collaboration-gates.md");
  }
}

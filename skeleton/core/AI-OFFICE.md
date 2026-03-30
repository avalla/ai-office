# AI Office — Core Guide

This project uses the **AI Office framework**.

`AI-OFFICE.md` is the host-neutral contract for the framework. The source of truth lives in:

1. `.ai-office/docs/`
2. `.ai-office/project.config.md`
3. `.ai-office/memory/`
4. this conversation/session

## Core Rules

- Start new work by routing the request before implementation.
- Keep the pipeline explicit: requirements, architecture, plan, tasks, implementation, QA, review, release.
- Treat `.ai-office/` artifacts as the operational state of the project.
- Record evidence before claiming work is complete.
- Prefer the deterministic `ai-office` CLI for state changes.

## Core Commands

Use these commands directly when no host-specific shortcuts are available:

```bash
ai-office doctor
ai-office task create "Task title" column:TODO assignee:Developer
ai-office task move M0_T001 WIP "started implementation"
ai-office task update M0_T001 priority:HIGH
ai-office milestone list
ai-office milestone create M1 "Milestone name"
ai-office status get feature-slug
ai-office status set feature-slug dev Developer "Implementation started"
ai-office validate feature-slug prd
```

## Adapter Model

AI Office is split into:

- `core`: `.ai-office/`, templates, agencies, agents, validation, CLI
- `adapter`: the files that expose AI Office inside a specific host

Examples:

- Codex adapter: `AGENTS.md` + `.codex/skills/`
- Claude Code adapter: `CLAUDE.md` + `.claude/skills/`
- Base adapter: no host-specific wrappers, only this guide plus the CLI

## Workflow Expectations

- Keep diffs focused and avoid unrelated refactors.
- Never invent APIs, file paths, or schema details without checking.
- Honor `pre_implementation_mode` from `.ai-office/project.config.md` when present: `minimal` asks only blocking questions, `confirm` asks for plan approval before coding, and `collaborative` offers alternatives and asks the user to choose before implementation.
- Honor `interactive_choices_mode` from `.ai-office/project.config.md` when present: `text` keeps decisions in plain text, and `buttons-when-available` prefers host-provided structured choices for plan approvals, cleanup follow-up, and similar user decisions with text fallback when unsupported.
- At task completion, commit only the files related to that task and prefer `ai-office task integrate <task-id>` for the final squash merge when task isolation is enabled.
- End each completed task with a short `Cleanup proposal` section listing 0-3 optional cleanup ideas, or explicitly say there is no cleanup proposal.
- Move tasks as soon as state changes.
- Validate artifacts before advancing stages.
- Respect loop guards recorded in status files.
- Use English for artifacts, code identifiers, and framework state unless the project explicitly requires otherwise.

## Project-Specific Rules

Read these files when present:

- `.ai-office/project.config.md`
- `.ai-office/office-config.md`
- `.ai-office/tasks/README.md`
- `.ai-office/docs/runbooks/<slug>-status.md`

## Optional Addons

Project-specific addons live in `.ai-office/addons/`.

If the installed adapter supports persistent instruction files, those files can import or copy addon content as needed.

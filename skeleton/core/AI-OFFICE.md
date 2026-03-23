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

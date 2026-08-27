# ADR-0012: Project shared guidance and repository-local host skills

- Status: Accepted
- Date: 2026-08-27
- Supersedes: ADR-0007

## Context

The first client-integration contract compiled all project guidance into
`AGENTS.md` and used `CLAUDE.md` to import it. That made a Codex-specific
discovery file appear to be the tool-independent artifact, duplicated a large
managed document at the repository root, and installed no discoverable project
skill for either supported host. A real installation could therefore report a
configured client while the user found no `ai-office` skill in the project.

Codex discovers project instructions through `AGENTS.md` and project skills
under `.agents/skills`. Claude Code supports `@path` imports from `CLAUDE.md`
and project skills under `.claude/skills`. These are host conventions, not
authoritative AI Office state.

## Decision

Compile the tool-independent project instruction contract into one shared,
AI Office-owned `AI-OFFICE.md` at the integration root. Keep host discovery
files small:

```text
<project-root>/
├── AI-OFFICE.md                         shared derived project guidance
├── AGENTS.md                            minimal managed Codex pointer
├── CLAUDE.md                            managed @AI-OFFICE.md bridge
├── .agents/skills/ai-office/SKILL.md    primary repository skill
└── .claude/skills/ai-office/SKILL.md    minimal Claude skill wrapper
```

The Codex pointer explicitly instructs the host to read `AI-OFFICE.md`; it is
not a Markdown include mechanism. The Claude bridge uses Claude's native
`@AI-OFFICE.md` import. The primary skill is deterministic and self-contained;
the Claude wrapper points to that shared skill and guide instead of duplicating
the workflow. It uses Claude Code's documented `${CLAUDE_PROJECT_DIR}` project
root variable rather than directory-depth-relative paths.

All five files are derived repository integration artifacts. SQLite office
manifests and project state remain authoritative. The files contain no runtime
path, project database ID, credential, secret, capability grant, approval, or
provider configuration. They may be committed so clones visibly retain the
project's AI Office integration, but normal install always reconciles them
against the selected runtime authority.

The existing client application service continues to orchestrate
`inspect -> plan -> approve exact hash -> apply -> validate`. Client adapters
own filenames, host conventions, managed markers, preconditions, and atomic
per-file writes. Missing nested directories are created only beneath the
canonical integration root; symlinked or non-directory parents fail closed.

AI Office never overwrites an unmarked `AI-OFFICE.md`, `AGENTS.md`, repository
skill, or user-owned `CLAUDE.md` content. It may append or update only its
marked Claude bridge. An unmanaged artifact is preserved and reported as
unmanaged, not configured.

Managed ownership parsing treats LF and CRLF as equivalent without normalizing
or rewriting user-owned bytes. Deterministic host pointers and skill bodies are
compared with the compiler output, so preserved ownership markers do not hide
content drift. Offline status can attest those artifacts without a daemon. It
cannot reconstruct `AI-OFFICE.md` without the authoritative manifest, so a
fully intact offline integration is reported as `unverified`; certain drift in
a deterministic pointer or skill remains `drifted`.

The lifecycle status envelope advances to schema version 3 for the new
`unverified` client configuration state. Binding schema version 2 and the
authoritative database schema are unchanged.

## Migration and lifecycle

An AI Office-managed schema-v1 `AGENTS.md` is recognized as the previous
derived layout. A newly approved install writes the compiled schema-v2 content
to `AI-OFFICE.md`, replaces the old managed `AGENTS.md` with the minimal
pointer, updates the managed Claude bridge from `@AGENTS.md` to
`@AI-OFFICE.md`, and installs both skills. The operation remains sequential and
repairable; rerunning install reconciles partial state without creating another
authority.

Direct single-client uninstall respects shared dependencies. Claude uninstall
removes its skill wrapper and only its managed bridge. Codex uninstall removes
its pointer. The adapter removing the final host reference also removes shared
guidance and the primary skill; either adapter preserves them while a Codex
instruction file, Claude bridge, or direct user import still depends on them.
An unmarked, user-owned `AGENTS.md` is conservatively treated as a surviving
host dependency: uninstall cannot prove which shared guidance it consumes and
must not delete `AI-OFFICE.md` or the primary skill beneath it. Dependency
preconditions are revalidated immediately before shared deletion so a host file
created or replaced after approval stops the remaining removal.
The user-facing lifecycle removes Claude before Codex, preflights the exact
aggregate plan, and reports partial filesystem changes if a later boundary
fails.

Only AI Office-owned files are deleted. User content, unrelated skills, the
portable `.ai-office/project.json` identity, authoritative runtime state, and
global memory are preserved. Empty `.agents` or `.claude` directories may
remain because directory ownership is not inferred from containing one managed
file.

## Alternatives considered

### Keep full guidance in `AGENTS.md`

Rejected. It leaves the shared contract coupled to one host convention and
does not solve repository skill discovery.

### Use symlinks between host skill directories

Rejected. Symlink behavior differs across clones and platforms and would weaken
the existing path-safety contract.

### Duplicate the complete skill for each host

Rejected. Two generated workflow copies could drift. A small Claude wrapper
keeps one workflow projection while satisfying native discovery.

### Store the guide or skill as authoritative configuration

Rejected. Markdown remains a deterministic one-way projection; validation,
policy, persistence, and audit stay behind the daemon and SQLite boundary.

## Consequences

- A successful supported-client installation exposes a discoverable
  repository-local `ai-office` skill.
- Project guidance has one clearly named shared file and host files remain
  minimal.
- Existing managed installations migrate on ordinary idempotent install.
- More repository-local files are managed, so exact planning and partial-state
  reporting cover a larger ordered set.
- Direct user imports can intentionally keep shared derived artifacts alive
  until the user removes that dependency.

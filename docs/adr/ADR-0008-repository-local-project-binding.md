# ADR-0008: Use a repository-local project identity binding

- Status: Accepted
- Date: 2026-08-23

## Context

AI Office can import several source repositories into one daemon runtime, but
the imported repository previously contained no durable indication that it was
known to AI Office. Project identity lived only in the runtime's authoritative
`project.sqlite`, while coding-client files were configured through a separate
integration-root workflow.

That separation is architecturally valid but creates a poor product lifecycle:
an operator entering a repository cannot discover its project ID, distinguish a
valid installation from a partial one, or resolve project-scoped commands
without repeating machine-oriented import and integration steps.

The local artifact must not become a second source of project authority, expose
machine-specific paths, or imply that a committed project ID is automatically
valid in another runtime.

## Decision

Create one strict repository-local binding at
`<project-root>/.ai-office/project.json`:

```json
{
  "schemaVersion": 1,
  "managedBy": "ai-office",
  "projectId": "<authoritative-project-id>"
}
```

The contract rejects unknown fields. It contains no project name, canonical
path, runtime root, socket location, hostname, user identity, credential,
capability, client detection result, or copied authoritative state.

The binding is intended to be committed with the repository. It is a portable
signal that the repository participates in AI Office and records the project ID
chosen by the creating runtime. It is not portable authority: each runtime must
verify both that the project ID exists in its own `project.sqlite` and that the
current canonical repository path is associated with that exact project.

If a clone, moved checkout, purged runtime, or different runtime cannot verify
both facts, the binding is stale or conflicting. AI Office fails closed and
requires an explicit rebind. Rebinding may create a new project association; it
never deletes or rewrites the old runtime's authoritative state. Preserving an
old project's history while relocating its canonical source is a distinct
future recovery operation, not an implicit install heuristic.

Install canonicalizes and targets its explicit directory exactly, which permits
creating an intentional nested project without an outer binding capturing the
operation. Status, uninstall, and automatic project-scoped command resolution
walk ancestors on the same filesystem device. The nearest binding wins, which
gives nested projects deterministic precedence. Traversal stops at the
filesystem root or before crossing a filesystem-device boundary. A symlinked `.ai-office`, symlinked
`project.json`, non-directory state path, non-regular binding, malformed JSON,
unsupported schema, or foreign ownership is an invalid binding and stops
discovery.

Binding mutation uses an infrastructure adapter behind an application port.
Plans bind the canonical root, expected file hash, action, and next contract.
Apply re-inspects state and uses atomic create/update behavior. Uninstall removes
only the exact AI Office-owned binding and removes `.ai-office/` only when it is
empty; unrelated entries are preserved.

The user-facing lifecycle is application orchestration over existing project
import, office-manifest, and coding-client services:

```text
install/status/uninstall
  -> project binding port
  -> existing project, office, and client application services
  -> existing SQLite and filesystem adapters
```

`project.sqlite` remains authoritative for project state. `global.sqlite`
remains durable user-level reusable memory. The binding is neither database
authority nor a Markdown projection. Coding-client ownership remains governed
by its existing plan/hash/precondition workflow.

## Considered alternatives

### Put `project.sqlite` in every repository

Rejected because it fragments one logical office, duplicates operational state,
and weakens the existing multi-project runtime model.

### Store the runtime root or socket path in the binding

Rejected because absolute machine paths are not portable, create avoidable
privacy leakage, and would make a committed repository select local runtime
infrastructure.

### Ignore the entire binding in Git

Rejected because a fresh clone would again contain no visible, durable signal
that the project participates in AI Office.

### Introduce a second portable repository identity and map it to project IDs

Rejected for this slice because it creates another identity namespace and a
database migration without evidence that cross-runtime identity federation is
needed. A future shared or remote runtime may revisit that model explicitly.

## Consequences

- A repository visibly declares its AI Office association without carrying
  authoritative or secret state.
- Status can distinguish missing, invalid, stale, conflicting, unverified, and
  valid bindings, including while the daemon is unavailable.
- Project-scoped CLI commands can resolve the nearest binding automatically.
- Clones and moves may require explicit recovery instead of silently selecting
  or creating project authority.
- Repository-local uninstall remains distinct from project-state deletion,
  offline runtime purge, and global-memory deletion.
- Published packaging, background service management, cross-runtime identity,
  and relocation that preserves an old project's authority remain separate
  productization work.

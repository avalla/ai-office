# ADR-0007: Use canonical project instructions and external client adapters

- Status: Accepted
- Date: 2026-08-20

## Context

AI Office needs to integrate with external coding clients without making its
operating policy depend on Codex, Claude, editor configuration, or user-home
filesystem conventions. Existing project guidance lived in `CODEX.md`, although
its contents were project-level truths. External configuration is user-owned and
must not be silently overwritten.

Codex supports `AGENTS.md` as its native hierarchical instruction file. Claude
Code supports project `CLAUDE.md` instructions and `@path` imports. The runtime
does not yet assemble prompts for internal agents, and `global.sqlite` does not
yet have a production owner for machine preferences.

## Decision

Make `AGENTS.md` the canonical, tool-independent project instruction artifact.
Keep client-specific compatibility files minimal and non-duplicative. For this
repository, `CLAUDE.md` imports `AGENTS.md`; `CODEX.md` is a temporary pointer for
older links, not a second source of truth.

Represent the initial operating policy and project instruction contract as a
small strict domain value. Compile it deterministically in the application
layer. Keep client detection, external file conventions, managed sections,
preconditions, and atomic writes in infrastructure adapters behind an
application port.

Use this mutation sequence:

```text
detect -> inspect -> plan -> present -> approve exact plan hash -> apply -> validate
```

Do not route owner-invoked client setup through controlled actions. It is not an
agent capability request. Instead, require an explicit plan hash, recompute the
plan at apply time, verify file preconditions, preserve user-owned content, and
write atomically. Do not persist installed-client detection or copies of
external configuration.

## Consequences

- Adding a client requires a new infrastructure adapter, not domain changes to
  encode its file names or configuration format.
- Codex and Claude share one project instruction source.
- User-owned `AGENTS.md` is never overwritten; Claude integration changes only
  its identifiable managed bridge section or creates a missing bridge.
- Plans become stale when relevant files change and must be approved again.
- Machine preference persistence, global client configuration, removal, version
  probing, and internal-agent prompt composition remain future work.
- The initial contract is intentionally not a universal prompt DSL or M8.5
  effective-context builder.

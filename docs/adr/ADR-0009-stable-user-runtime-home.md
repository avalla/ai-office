# ADR-0009: Select user runtime data independently from program location

- Status: Accepted
- Date: 2026-08-23

## Context

The linkable entry point previously bootstrapped with its distribution checkout
as `projectRoot`. That made the program location also own `project.sqlite` and
`daemon.sock`: moving, relinking, or reinstalling AI Office could accidentally
select a different office.

## Decision

The normal `ai-office` entry point selects one stable user runtime home:

```text
AI_OFFICE_HOME, when explicitly set
otherwise ~/.ai-office
```

The runtime home directly contains `project.sqlite`, `daemon.sock`, drafts,
generated projections, and `global.sqlite`. A single runtime-path resolver owns
these paths and is shared by daemon bootstrap, CLI socket lookup, database
opening, lifecycle status, and offline runtime purge. The distribution root is
used only to locate program assets and to detect legacy checkout-local data; it
never selects current authority.

The resolver canonicalizes existing ancestors, rejects a symlink or
non-directory runtime home, and verifies the selected directory is usable
before daemon startup. `AI_OFFICE_HOME` is an explicit runtime selection and is
never inferred from the working repository.

Development commands retain an explicit compatibility mode:
`bun run daemon` and `bun run cli -- ...` use `<cwd>/.ai-office`. Development
mode is not used by the linkable user entry point.

An existing `<distribution-root>/.ai-office/project.sqlite` is detected and
reported with an actionable `AI_OFFICE_HOME=<legacy-directory>` instruction.
It is not moved, copied, opened, or deleted automatically; copying a live SQLite
database would be unsafe.

`runtime:purge` operates only on the resolved runtime home. It preserves
`global.sqlite` and unknown entries, remains offline and exact-plan protected,
and never follows the current repository or distribution path.

## Consequences

- Moving or reinstalling the program does not change user authority.
- Commands from different repositories resolve the same daemon socket unless
  the user explicitly selects another runtime.
- Multiple explicit `AI_OFFICE_HOME` values remain possible for isolation and
  testing, but selection is visible rather than cwd-derived.
- Existing development workflows remain available with deliberately different
  path semantics.
- Automatic legacy database migration is deferred; the safe compatibility path
  is explicit runtime selection after stopping any daemon that owns it.

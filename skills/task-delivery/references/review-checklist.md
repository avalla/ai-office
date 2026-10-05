# Review checklist

For the independent reviewer. Review the diff against the task and its
acceptance criteria. Do not rely on the implementer's description of what the
change does: read the code.

## Correctness

- Does the change satisfy every acceptance criterion, and only those?
- Are failure paths, empty inputs, boundaries, and concurrent use handled?
- Are errors surfaced with a type or code, never swallowed?
- Could existing callers or stored data break?

## Scope

- Is every changed file needed for this task?
- Are there unrelated refactors, renames, formatting changes, or new features?
- Are deferred items recorded as follow-ups rather than half-done?

## Design and architecture

- Does the change respect the repository's documented boundaries and
  invariants?
- Does it introduce a new mechanism where an existing one would do?
- Does it make an architectural decision that was not authorized?
- Is there hidden coupling, duplicated logic, or a second source of truth?

## Tests

- Do tests fail without the change and pass with it?
- Are failure modes covered, not only the success path?
- Are tests deterministic and isolated from local state, network, and time?
- Do tests assert behavior rather than restating the implementation?

## Safety

- Any secret, credential, or personal data in code, fixtures, logs, or output?
- Input validation and path handling at trust boundaries?
- Destructive operations guarded, reversible, or explicitly confirmed?
- Persistence changes forward-only and upgrade-tested?

## Operability

- Clear failure messages and non-zero exit codes for tools and scripts?
- Documentation updated where behavior or commands changed?
- Does it run unattended in continuous integration?

## Reporting findings

Report each finding with: severity (blocking, major, minor), file and line, what
is wrong, a concrete scenario that triggers it, and a suggested direction.
Rank most severe first. State explicitly what was reviewed and what was not. If
there are no findings, say so and list what was examined.

A finding is **blocking** when it breaks an acceptance criterion, corrupts or
loses data, weakens a security boundary, or violates a documented invariant.

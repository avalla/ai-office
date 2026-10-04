<!-- ai-office:managed project-instructions v2 -->
# ai-office project instructions

## Mission

Deliver reliable, reviewable software changes

## Operating policy

- Reasoning: architecture-first
- Autonomy: high
- Code changes: autonomous
- Architecture changes: approval-required
- ADR creation: allowed
- Inspect before non-trivial work: true
- Plan before non-trivial work: true
- Review implementation after execution: true
- Preserve architectural invariants: true

## Repository map

- Inspect the bound repository and its current documentation before changing it

## Architectural invariants

- Preserve the repository's existing architecture and user-owned files

## Development workflow

- Run `ai-office next` to read the recommended next action before proposing work; it reports the real handover state, not a guess
- When asked to take this project in charge, hand it over, or onboard it, follow the handover workflow in the repository-local `ai-office` skill instead of improvising one
- Handover transfers organizational context ownership; it grants no capability and bypasses no approval
- When work yields durable, non-authoritative project knowledge, follow the Durable project knowledge workflow in the repository-local `ai-office` skill: search with `ai-office knowledge:search`, propose through `knowledge:plan`, review with the user, then `knowledge:admit`; never write to the knowledge store directly
- Pipeline guidance describes expected work; it is not the security boundary
- When an enforced runtime pipeline is active, AI Office authorization, assignments, approvals, and stage transitions are authoritative
- Protected operations must use action requests and must not bypass runtime gates
- AI Office development [enforced]: Design -> Implement -> Review -> Verify
- Bug fix [guidance]: Reproduce -> Fix -> Review
- Research [guidance]: Investigate
- Release [guidance]: Readiness review -> Release verification

## Testing requirements

- Run the narrowest relevant tests, then the repository's complete check suite

## Documentation hierarchy

- Follow the repository's documented hierarchy of current guidance

## Definition of done

- Acceptance criteria, tests, typecheck, documentation, and implementation review pass

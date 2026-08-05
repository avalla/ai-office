# Governance

M5 stores milestones, requirements, architecture decisions, reviews, and approvals in `project.sqlite`. Creation and lifecycle updates pass through the application service; SQLite constraints and foreign keys protect references.

`review:decide` writes the approval and finalizes its review in one SQLite transaction. `governance:profile` renders current state, while `governance:export` regenerates `.ai-office/generated/governance.md`. The generated file is never read as authoritative input.

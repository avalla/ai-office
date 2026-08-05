# Governance

M5 stores milestones, requirements, architecture decisions, reviews, and approvals in `project.sqlite`. Creation and lifecycle updates pass through the application service; SQLite constraints and foreign keys protect references.

Requirements may reference only milestones in the same project. Requirement keys are unique per project and intentionally case-sensitive. Review subjects use a closed type union and must exist in the same project.

`review:decide` checks `pending`, writes the immutable approval, and changes the review to the matching `approved` or `rejected` status in one immediate SQLite transaction. Concurrent decisions have one winner. Reviewer and decision-maker identities are stored as `{type, id, displayName?}`; the current CLI's name option is an MVP shorthand mapped to a user actor and is not an externally verified identity.

The lifecycle state machines are:

- milestone: `planned -> active -> completed`, with `planned|active -> cancelled`;
- requirement: `proposed -> accepted -> implemented -> verified`, with explicit rejection only from `proposed` or `accepted`;
- ADR: `proposed -> accepted -> deprecated|superseded` or `proposed -> rejected`.

Creation and status changes append one immutable governance event containing IDs and minimal metadata. `governance:profile` renders current state, while `governance:export` atomically regenerates `.ai-office/generated/governance.md` through a temporary file and rename. Rendering has stable ordering/newlines and protects its structure from user-authored Markdown headings. The generated file is never read as authoritative input.

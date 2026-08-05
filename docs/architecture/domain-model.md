# Domain model

## Main aggregates

- Project
- Milestone
- Task
- ArchitectureDecision
- Role
- Agent
- AgentRun
- Review
- Budget
- Pattern
- Lesson

## Traceability

```text
Requirement
  -> Architecture decision
  -> Task
  -> Agent run
  -> Artifact / commit
  -> Review
  -> Test result
```

## Task states

```text
pending -> assigned -> running -> waiting_review -> completed
                       |             |
                       v             v
                     blocked       failed
```

Transitions must be validated in the domain layer.

## Agent run states

```text
queued -> preparing -> running -> reviewing -> completed
                    \-> cancelled
                    \-> failed
```

Every transition is checked by the domain model and projected into the append-only `agent_run_event` table. A task lock is acquired when a run is queued and released after completion, failure, or cancellation.

## Governance lifecycles

- milestones: `planned -> active -> completed` (or `cancelled`);
- requirements: `proposed -> accepted -> implemented -> verified` (or `rejected`);
- ADRs: `proposed -> accepted`, with later `deprecated` or `superseded` states;
- reviews: `pending -> approved | rejected`, finalized by an immutable approval decision.

## Pattern scopes

- project;
- workspace;
- user/global.

A project-specific decision must not automatically become a global pattern.
Promotion requires a deliberate extraction step and evidence.

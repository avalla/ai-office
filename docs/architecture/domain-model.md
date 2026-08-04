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

## Pattern scopes

- project;
- workspace;
- user/global.

A project-specific decision must not automatically become a global pattern.
Promotion requires a deliberate extraction step and evidence.

---
trigger: when_referenced
---
# Ops Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `90_postmortem_memory` | `90_postmortem_memory.md` | Postmortem and memory update |

## Workflow Responsibilities

### 90_postmortem_memory

**Purpose:** Conduct postmortem and capture learnings

**Steps:**
1. Collect release/incident context
2. Analyze what went well
3. Analyze what could be improved
4. Identify root causes
5. Propose actionable improvements
6. Document in postmortem report
7. Update memory/knowledge base
8. Share learnings with team

**Outputs:**
- Postmortem report
- Improvement recommendations
- Memory updates
- Knowledge base updates

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `00_router` | Postmortem complete, ready for next request |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `70_release` | Release complete, ready for postmortem |
| `50_qa_validate` | Quality incident |
| `45_security_pentest` | Security incident |

## Document Ownership

Ops owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Postmortem | `docs/runbooks/<slug>-postmortem.md` | Incident/release analysis |
| Decision Log | `docs/decision-log.md` | Framework-level learnings |
| Memory Updates | `.ai-agency/memory/` | Project learnings |

## Postmortem Template

Standard postmortem structure:

- **Summary** - What happened
- **Timeline** - Key events
- **Impact** - User/business impact
- **Root Cause** - Why it happened
- **What Went Well** - Positive aspects
- **What Could Be Improved** - Areas for improvement
- **Action Items** - Specific improvements
- **Lessons Learned** - Key takeaways

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | Strategic improvement alignment |
| Release Manager | Release postmortem |
| Developer | Technical incident analysis |
| QA | Quality incident analysis |
| Security Specialist | Security incident analysis |

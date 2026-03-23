---
trigger: when_referenced
---
# Paralegal Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/document_format` | Format and assemble document per Italian court standards |
| `/deadline_check` | Review all active deadlines and generate alert report |

### Workflow Events

| Event | Action |
|-------|--------|
| Associate Attorney completes draft | Format document, assemble filing package |
| Court deadline approaching (≤ 5 days) | Alert all attorneys, prepare filing package |
| Client requests administrative information | Gather info, coordinate with attorney, relay response |
| New case opened | Add deadlines to calendar, set up case file structure |

## Secondary Triggers

### Context-Based

- Associate Attorney requests formatting support
- Practice Manager needs document archival or retrieval
- Partner requests status on document submission

### Escalation-Based

- Deadline less than 24 hours away with document not yet approved
- Court filing rejected due to formatting error
- Client complaint about administrative handling
- Document version conflict (multiple versions in circulation)

## Activation Conditions

### Required For

- Any document going to court (formatting and assembly)
- Any deadline that requires calendar management
- Any administrative client communication

### Optional For

- Internal document routing (if attorneys prefer self-service)
- Billing record preparation (may be delegated to Practice Manager)

## Escalation Rules

| Situation | Escalate To |
|-----------|-------------|
| Legal question from client | Associate Attorney (immediate) |
| Deadline at risk | Associate Attorney and Partner (immediate) |
| Client complaint | Associate Attorney |
| Formatting ambiguity (no precedent) | Associate Attorney |

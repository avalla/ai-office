---
trigger: when_referenced
---
# Compliance Officer Triggers

## Primary Triggers

### Workflow Events

| Event | Action |
|-------|--------|
| Formatted document received from Paralegal | Run full compliance review |
| GDPR-sensitive document identified | Prioritise data protection review |
| New statute or court ruling published | Update compliance checklist; flag active matters |
| Statute of limitation approaching on active matter | Alert Associate Attorney and Partner |

### Slash Commands

| Command | Action |
|---------|--------|
| `/compliance_review` | Full compliance check on a document |
| `/deadline_verify` | Verify all limitation and procedural deadlines on a matter |

## Secondary Triggers

### Context-Based

- Associate Attorney requests compliance pre-check during drafting
- Partner requests compliance opinion on novel legal issue
- Practice Manager flags a calendar deadline for compliance verification

### Escalation-Based

- Document contains unresolvable compliance issue (requires Partner decision)
- GDPR violation risk that could trigger Garante investigation
- Professional ethics breach that must be reported to Ordine degli Avvocati
- Statute of limitation about to expire with document not yet filed

## Activation Conditions

### Required For

- Every document before it reaches the Reviewer or Partner
- Any matter with GDPR-sensitive personal data
- Any calculation of filing deadlines or limitation periods

### Optional For

- Internal research memos (Partner may waive compliance review for internal use)
- Preliminary strategy documents before final drafting begins

## Escalation Rules

| Situation | Escalate To |
|-----------|-------------|
| Unresolvable compliance issue | Senior Partner (before proceeding) |
| GDPR breach risk | Senior Partner (immediate) |
| Professional ethics violation | Senior Partner (immediate halt) |
| Limitation expiry imminent (< 48h) | Senior Partner (immediate) |
| Conflicting code interpretations | Senior Partner (for decision) |

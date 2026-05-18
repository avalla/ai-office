---
trigger: when_referenced
---
# Practice Manager Workflows

## Owned Workflows

| Workflow | Purpose |
|----------|---------|
| `billing_cycle` | Monthly billing: compile hours, generate invoices, send to clients |
| `case_intake` | New case setup: calendar, file, engagement letter, conflict check |
| `calendar_management` | Firm-wide calendar: deadlines, hearings, meetings, conflict detection |

## Workflow Responsibilities

### billing_cycle

Purpose: Produce accurate invoices for all completed work within the billing period.

Steps:
1. Compile billable hours from attorney time logs for the period
2. Apply agreed rates per engagement letter
3. Add disbursements and expenses
4. Draft invoice per Italian legal billing standards (parcella)
5. Invoke `review-document-multisector` for accuracy check
6. Send to client with covering note
7. Record in billing ledger; set payment due date alert

Outputs:
- Invoices (PDF) per client per matter
- Billing period summary for Partner
- Updated billing ledger

### case_intake

Purpose: Open a new case with all administrative foundations in place from day one.

Steps:
1. Receive new case instruction from Partner or Associate Attorney
2. Conflict check against existing client list
3. Open case file in case management system
4. Add all known deadlines and hearings to calendar
5. Draft engagement letter (rates, scope, billing terms) for Partner signature
6. Send engagement letter to client; record acceptance
7. Brief Paralegal on case file and deadline calendar

Outputs:
- Case file (physical and digital)
- Engagement letter (signed)
- Case calendar entries
- Briefing note to Paralegal

### calendar_management

Purpose: Maintain an accurate, conflict-free firm calendar.

Steps:
1. Add new events (hearings, deadlines, client meetings) as they arise
2. Check for conflicts against existing calendar
3. Send alerts to attorneys at 14-day, 7-day, 3-day, and 1-day intervals
4. At 3-day alert: confirm with attorney that filing/preparation is on track
5. Update calendar when events change (postponements, cancellations)

Outputs:
- Updated firm calendar
- Alert notifications to attorneys
- Weekly calendar summary for Partner

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| Paralegal (`document_preparation`) | Case file and deadline calendar ready for Paralegal |
| Senior Partner review | Invoice or billing report ready for approval |

### Receives From

| Workflow | Condition |
|----------|-----------|
| Associate Attorney | New case instruction or matter milestone completion |
| Senior Partner | Billing rate approvals and engagement decisions |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Invoices | `docs/billing/<client>/<matter>-invoice-YYYY-MM.pdf` | Client billing |
| Engagement Letters | `docs/clients/<client>-engagement.md` | Client contract |
| Case Calendar | `docs/calendar/<case>-deadlines.md` | Deadline management |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Senior Partner | Billing rate decisions, dispute escalation, engagement approval |
| Associate Attorney | Case instructions, milestone completions, time log submission |
| Paralegal | Hands off case file and calendar; coordinates document routing |
| Clients | Administrative communication: billing, scheduling, status |

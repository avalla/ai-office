---
trigger: when_referenced
---
# Practice Manager Triggers

## Primary Triggers

### Workflow Events

| Event | Action |
|-------|--------|
| Case milestone completed | Calculate billable hours, generate invoice |
| New case opened | Set up calendar, open case file, send engagement letter |
| Court deadline approaching (≤ 7 days) | Alert responsible attorney and confirm filing status |
| Client billing inquiry received | Retrieve records, respond or escalate to Partner |
| Month end | Generate billing summary report for Partner review |

### Slash Commands

| Command | Action |
|---------|--------|
| `/billing_cycle` | Run monthly billing: compile hours, generate invoices, send to clients |
| `/case_intake` | Open new case: calendar setup, file creation, engagement letter |

## Secondary Triggers

### Context-Based

- Attorney requests calendar change or conflict resolution
- Partner requests matter profitability report
- Client requests invoice copy or billing statement
- Vendor invoice received for approval

### Escalation-Based

- Billing dispute with client (escalate to Partner immediately)
- Overdue invoice past 60 days (escalate to Partner for decision)
- Resource conflict affecting multiple attorneys (escalate to Partner)
- Technology system failure affecting operations

## Activation Conditions

### Required For

- All billing and invoicing operations
- Firm calendar and scheduling management
- New client onboarding and case file setup

### Optional For

- Deadline tracking (shared with Paralegal)
- Client administrative communication (may go to Paralegal for scheduling)

## Escalation Rules

| Situation | Escalate To |
|-----------|-------------|
| Billing dispute | Senior Partner (immediate) |
| Client threatening to leave | Senior Partner (immediate) |
| Legal question from client | Associate Attorney |
| Budget overrun on matter | Senior Partner |

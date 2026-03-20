---
trigger: when_referenced
---
# Paralegal Workflows

## Owned Workflows

| Workflow | Purpose |
|----------|---------|
| `document_preparation` | Format, assemble, and validate documents for submission |
| `deadline_management` | Track, alert, and escalate all court and filing deadlines |
| `client_coordination` | Handle non-legal administrative client communication |

## Workflow Responsibilities

### document_preparation

Purpose: Produce a correctly formatted, complete filing package ready for Compliance review.

Steps:
1. Receive draft document from Associate Attorney
2. Apply Italian court formatting standards (font, margins, headers, page numbers)
3. Add required cover sheet, signature blocks, and date fields
4. Assemble exhibits and attachments with proper labels
5. Run completeness check (`review-document-multisector`)
6. Hand off to Compliance Officer with a routing note

Outputs:
- Formatted document (PDF and editable source)
- Filing package (document + exhibits)
- Routing note for Compliance Officer

### deadline_management

Purpose: Ensure no court deadline, SOL, or hearing date is missed.

Steps:
1. On case intake: extract all deadlines from brief and add to calendar
2. Set alerts at 14 days, 7 days, 3 days, and 1 day before each deadline
3. On alert trigger: notify responsible attorney with status
4. If document not yet ready at 3-day alert: escalate to Partner
5. On filing completion: record submission date and confirmation

Outputs:
- Updated case calendar
- Deadline alert log
- Filing confirmation record

### client_coordination

Purpose: Handle administrative client requests without attorney involvement.

Steps:
1. Receive client request (scheduling, document status, billing inquiry)
2. Assess: administrative → handle directly; legal or sensitive → route to attorney
3. For scheduling: coordinate with attorney calendar, confirm with client
4. For document status: check internal tracking, relay status without legal commentary
5. For billing: route to Practice Manager

Outputs:
- Client communication record
- Updated calendar (if scheduling)
- Routing note to attorney (if escalated)

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| Compliance Officer review | Document formatted and assembled |
| Practice Manager | Billing record handed off after case milestone |

### Receives From

| Workflow | Condition |
|----------|-----------|
| Associate Attorney | Draft document ready for formatting |
| Practice Manager | Calendar updates for new cases |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Formatted Filing Package | `docs/filings/<case>/<slug>-filing.pdf` | Court submission |
| Deadline Calendar | `docs/calendar/<case>-deadlines.md` | Deadline tracking |
| Routing Notes | `docs/routing/<slug>-routing.md` | Handoff documentation |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Associate Attorney | Receives drafts; escalates legal questions |
| Compliance Officer | Hands off formatted packages for compliance review |
| Practice Manager | Coordinates billing records and calendar |
| Senior Partner | Escalates deadline crises |

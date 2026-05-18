---
trigger: when_referenced
---
# Senior Partner Workflows

## Owned Workflows

| Workflow | Purpose |
|----------|---------|
| `document_approval` | Final review and signature on all client-facing documents |
| `case_strategy` | Define and approve legal strategy for each matter |
| `client_escalation` | Handle escalated client situations directly |

## Workflow Responsibilities

### document_approval

Purpose: Apply final Partner quality review and signature authority before any document reaches the client or court.

Steps:
1. Receive document after Reviewer clearance (confirm Reviewer and Compliance certificates are present)
2. Invoke `review-document-multisector`
3. Review legal argument strength, risk language, and client impact
4. Decision:
   - **APPROVED**: Sign document; Practice Manager sends to client
   - **RETURNED**: Write specific revision instructions; return to Associate Attorney
5. Log decision in case file

Outputs:
- Signed document (if approved)
- Revision instructions (if returned) in `docs/drafts/<case>-<slug>-partner-notes.md`

### case_strategy

Purpose: Set the legal strategy for each matter and ensure all team members are aligned.

Steps:
1. Receive research options from Associate Attorney
2. Evaluate risk/benefit of each approach using full legal expertise
3. Consult client if material strategic decision requires their input
4. Select strategy; communicate decision clearly to team
5. Document strategy decision in matter file

Outputs:
- Strategy decision recorded in `docs/cases/<case>-strategy.md`
- Direction memo to Associate Attorney

### client_escalation

Purpose: Handle difficult, sensitive, or high-stakes client situations that require Partner authority.

Steps:
1. Receive escalation from Associate Attorney or Practice Manager
2. Assess situation: legal risk, client relationship risk, business risk
3. Contact client directly (call or formal letter)
4. Communicate outcome, risk, and firm's recommendation clearly
5. Document communication and client decision

Outputs:
- Client communication record
- Updated strategy or case status as appropriate

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| Practice Manager (client delivery) | Document approved and signed; ready for delivery |

### Receives From

| Workflow | Condition |
|----------|-----------|
| Reviewer | Document cleared and ready for Partner review |
| Associate Attorney | Research memo and strategy options |
| Associate Attorney / Practice Manager | Escalated client situation |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Partner Revision Notes | `docs/drafts/<case>-<slug>-partner-notes.md` | Revision instructions |
| Case Strategy Record | `docs/cases/<case>-strategy.md` | Strategic decision log |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Associate Attorney | Receives research; provides strategy; approves or returns drafts |
| Compliance Officer | Requires compliance certificate before document review |
| Reviewer | Requires reviewer clearance before document review |
| Paralegal | Final formatted document received via Paralegal |
| Practice Manager | Delegates client delivery, billing, and scheduling |

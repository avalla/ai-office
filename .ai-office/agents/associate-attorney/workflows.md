---
trigger: when_referenced
---
# Associate Attorney Workflows

## Owned Workflows

| Workflow | Purpose |
|----------|---------|
| `legal_research` | Research case law, statutes, and precedent for a matter |
| `document_draft` | Draft legal documents and route through review pipeline |
| `client_communication` | Handle day-to-day client calls and written communication |

## Workflow Responsibilities

### legal_research

Purpose: Produce a thorough, well-cited research memo that supports Partner strategy decisions.

Steps:
1. Receive research request from Partner (or identify need during drafting)
2. Define research scope: applicable Codice, case law databases (Ius Online, CECA), relevant precedent
3. Research primary sources; identify majority and minority positions
4. Note conflicting case law or unresolved interpretations
5. Draft research memo with structured argument options
6. Submit to Partner for strategy selection

Outputs:
- Research memo: `docs/research/<case>-<issue>.md`
- Case law list with citations
- Recommended strategy options

### document_draft

Purpose: Produce a reviewed, compliant document ready for Partner signature.

Steps:
1. Receive drafting instruction and approved strategy from Partner
2. Research any remaining legal gaps
3. Draft document in formal Italian per document type
4. Invoke `review-document-multisector` for self-review
5. Revise based on findings
6. Route to Paralegal for formatting
7. After formatting: route to Compliance Officer
8. After compliance clearance: route to Reviewer
9. After Reviewer clearance: submit to Partner for signature

Outputs:
- Approved document ready for Partner signature
- Research notes and draft history in case file

### client_communication

Purpose: Maintain responsive, professional communication with clients on administrative and status matters.

Steps:
1. Receive client contact (call, email, message)
2. Assess: administrative → handle directly; legal strategy → consult Partner first
3. For status updates: provide factual case status only, no outcome predictions
4. For legal questions: research or escalate, do not speculate
5. Document all client interactions in case file

Outputs:
- Client communication record
- Escalation note to Partner (if required)

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| Paralegal (`document_preparation`) | Draft approved; routing for formatting |
| Compliance Officer review | Formatted document ready for compliance check |

### Receives From

| Workflow | Condition |
|----------|-----------|
| Senior Partner | Strategy approved; drafting instruction given |
| Compliance Officer | Document returned with compliance issues |
| Reviewer | Document returned with citation or language issues |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Research Memo | `docs/research/<case>-<issue>.md` | Legal research record |
| Draft Document | `docs/drafts/<case>-<slug>-vN.md` | Working draft |
| Client Communication Log | `docs/clients/<case>-comms.md` | Communication audit trail |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Senior Partner | Research requests, strategy approval, escalation |
| Paralegal | Hands off approved draft for formatting |
| Compliance Officer | Routes formatted document; receives compliance feedback |
| Reviewer | Receives document after compliance; provides corrections |
| Practice Manager | Coordinates scheduling and billing records |

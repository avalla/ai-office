---
trigger: when_referenced
---
# Compliance Officer Workflows

## Owned Workflows

| Workflow | Purpose |
|----------|---------|
| `compliance_review` | Full compliance check on any document before Partner review |
| `deadline_verify` | Calculate and verify all limitation and procedural deadlines |

## Workflow Responsibilities

### compliance_review

Purpose: Certify that a document is fully compliant with Italian law, GDPR, and professional ethics before it reaches the Partner.

Steps:
1. Receive formatted document from Paralegal
2. Identify applicable legal framework (Codice Civile, Procedura Civile, GDPR, etc.)
3. Verify code compliance: check each relevant provision
4. Verify GDPR compliance: data references, retention, lawful basis
5. Verify professional ethics: fee language, no prohibited clauses, no conflict
6. Invoke `review-document-multisector`
7. If compliant: issue compliance certificate, route to Reviewer
8. If non-compliant: return to Associate Attorney with itemised issues (code reference per issue)

Outputs:
- Compliance certificate: `docs/compliance/<case>-<slug>-compliance.md`
- Non-compliance report (if returned) with specific code references

### deadline_verify

Purpose: Ensure all limitation periods and procedural deadlines are accurately calculated and tracked.

Steps:
1. Identify triggering event for each limitation period (cause of action date, service date, etc.)
2. Apply applicable limitation period per Codice Civile or special statute
3. Check for any suspension or interruption events (riconoscimento, intimazione)
4. Map all procedural deadlines from case timeline (oppositions, replies, appeals)
5. Cross-check against Paralegal calendar entries
6. Alert Associate Attorney and Practice Manager of any discrepancy
7. Issue deadline verification note

Outputs:
- Deadline verification note: `docs/compliance/<case>-deadlines-verified.md`
- Alert to Practice Manager if calendar needs update

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| Reviewer review | Compliance certificate issued; document routed to Reviewer |

### Receives From

| Workflow | Condition |
|----------|-----------|
| Paralegal (`document_preparation`) | Formatted document package received |
| Associate Attorney | Revised document after compliance return |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Compliance Certificate | `docs/compliance/<case>-<slug>-compliance.md` | Compliance sign-off record |
| Deadline Verification Note | `docs/compliance/<case>-deadlines-verified.md` | Deadline audit |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Associate Attorney | Returns documents with itemised issues; receives revisions |
| Paralegal | Receives formatted document packages |
| Reviewer | Routes compliance-cleared documents for citation and language review |
| Senior Partner | Escalates unresolvable issues, GDPR risks, ethics violations |
| Practice Manager | Cross-checks deadline calendar |

# Italian Legal Studio — Quick Start Guide

## Setup

### 1. Install the Agency

```bash
# The agency is automatically discovered during setup
./setup.sh [project-path]

# When prompted:
# "Which agency? (1-6)"
# Select: italian-legal-studio
```

### 2. Configure for Your Firm

```yaml
---
agency: italian-legal-studio
project_name: studio-legale-[nome]

# Your preferred commands (adapt to your setup)
typecheck_cmd: "echo 'Using Italian legal standards'"
lint_cmd: "echo 'Format check: Italian legal style'"
test_cmd: "echo 'No automated tests for legal docs'"
test_runner: none

ui_framework: none
design_system: Italian Legal Standards (ISO/IEC 27001 + GDPR)

coverage_min: 100    # 100% compliance required
lighthouse_min: 0    # N/A for legal documents

advance_mode: manual  # Always review before advancing
---
```

### 3. Set Practice Parameters

In project config, add:

```yaml
# Italian Legal Practice Settings
firm_name: "Studio Legale [Your Name]"
managing_partner: "[Your Name]"
bar_registration: "n. [numero]"
court_jurisdiction: "Tribunale di [city]"

# Billing
hourly_rate: "€ [amount]"
default_deadline_days: 30

# Compliance
gdpr_dpo: "[name/email]"
professional_liability_insurance: "[policy number]"
```

---

## Example Workflow: Civil Dispute Document

### Step 1: Client Intake & Routing

```bash
/office-route Client requests defense memo for civil dispute

# AI Office: Analyzes context, creates intake notes
# Type: Legal document - defense memo
# Suggested pipeline: intake → research → compliance → draft → review → partner → delivery
```

### Step 2: Create Case File

```bash
/office-milestone create M1 "Civil Dispute - Case ABC-2026" target:2026-04-30

# AI Office: Suggests tasks
# - Legal research (precedent, statute review)
# - Compliance check (jurisdiction, deadlines)
# - First draft (memory defensiva)
# - Internal review (grammar, citations)
# - Partner approval (signature)
# - Client delivery (formatted, sent)
```

### Step 3: Research Phase

```bash
/office-task-move M1_T001 WIP "Started research on applicable case law"

# Developer (in this case, Associate Attorney) starts research:
# - Search Italian legal databases (Ius Online, CECA)
# - Document relevant precedent (Cassazione, Corte d'Appello)
# - Verify applicable Code sections
# - Check statute of limitations
```

### Step 4: Compliance Check

```bash
/office-task-move M1_T002 WIP "Verifying jurisdiction and deadlines"

# Compliance Officer reviews:
# - Court jurisdiction confirmed
# - Filing deadline: April 15 (SOL: May 1)
# - All applicable codes verified
# - GDPR compliance for client data
# - Professional ethics clearance
```

### Step 5: Document Drafting

```bash
/office-task-create "Draft memoria difensiva - ABC case" \
  ms:M1 priority:HIGH assignee:"Associate Attorney" \
  estimate:6h labels:litigation,civil,urgent \
  slug:civil-dispute-abc

# Associate Attorney drafts document using template:
# .ai-office/agencies/italian-legal-studio/templates.md → MEMORIA DIFENSIVA

# Document includes:
# - Client facts organized chronologically
# - Legal arguments with Code citations
# - Relevant case law (Cassazione, Corte d'Appello)
# - Counter-arguments to plaintiff's claims
# - Requested relief clearly stated
```

### Step 6: Internal Review

```bash
/office-task-move M1_T003 REVIEW "Draft complete, ready for review"

# Reviewer checks:
# - Italian grammar and legal terminology
# - All citations properly formatted
# - Code references verified
# - Signature lines properly placed
# - Compliance with Italian court standards
# - No confidential information exposed
```

### Step 7: Partner Approval

```bash
/office-verify M1_T003

# AI Office: Runs QA verification
# Partner (Senior Partner) reviews:
# - Legal argument is sound
# - All client goals addressed
# - Risks properly assessed
# - Authority to sign confirmed
```

### Step 8: Delivery

```bash
/office-task-move M1_T004 DONE "Approved by partner, ready for filing"

# Practice Manager:
# - Signs document if required
# - Formats with firm letterhead
# - Sends to client
# - Files with court (if applicable)
# - Logs filing date and confirmation
# - Generates invoice (billable hours)
```

### Step 9: Closure & Billing

```bash
/office-milestone status M1

# Shows:
# - 4/6 tasks done
# - Total billable hours: 18.5
# - Dates: Started March 20, Completed April 5
# - Client deadline: April 30 ✅ (met)

/office-milestone close M1

# Generates invoice and practice manager handles:
# - Bill client for 18.5 hours @ €300/hr = €5,550
# - Update time tracking
# - Archive case file
```

---

## Agent Roles in Legal Studio

### Senior Partner (Managing Partner)
**Decisions:** Final approval, signature authority, strategy
```
/office-role senior-partner

# Output shows:
# - Authority to sign all documents
# - Approves strategy and risk acceptance
# - Client relationship final sign-off
# - Billing authorization
```

### Associate Attorney (Lead Counsel)
**Work:** Document drafting, legal research
```
/office-role associate-attorney

# Responsibilities:
# - Conduct legal research in Italian databases
# - Draft documents per templates
# - Consult with clients
# - Coordinate with paralegal
```

### Paralegal
**Support:** Document assembly, formatting, filing
```
/office-role paralegal

# Responsibilities:
# - Assemble documents per Italian standards
# - Format with proper signature lines
# - Prepare court filings
# - Track deadlines
# - Manage client communications (non-legal)
```

### Compliance Officer (NEW)
**Verification:** Regulatory checks, code compliance
```
/office-role compliance-officer

# Responsibilities:
# - Verify Italian law compliance
# - Check court jurisdiction
# - Validate filing deadlines
# - GDPR/privacy review
# - Professional ethics sign-off
```

### Reviewer (QA)
**Quality:** Grammar, citations, formatting
```
/office-role reviewer

# Responsibilities:
# - Italian grammar and terminology
# - Citation format verification
# - Document formatting per Italian standards
# - Cross-reference checking
```

### Practice Manager (Operations)
**Admin:** Calendar, billing, deadlines
```
/office-role practice-manager

# Responsibilities:
# - Manage client calendar
# - Track court deadlines
# - Generate invoices
# - File management
# - Client status updates
```

---

## Key Differences from Software Development

### Compliance is Non-Negotiable

In software: "iterate and fix later"
In law: "get it right the first time or face malpractice"

**Loop Guard Behavior:**
```
Max revisions before Partner approval: 1
Max revision after Partner approval: 0 (escalate to practice meeting)
Filing errors: 0 tolerance
```

### Confidentiality is Critical

All case files MUST be:
- ✅ Stored in version control (local, not cloud)
- ✅ Never shared in external services
- ✅ GDPR compliant
- ✅ Encrypted if shared

### Document Versioning is Mandatory

Every draft tracked:
- `memoria-defensiva-v1.0.md` (initial draft)
- `memoria-defensiva-v1.1.md` (reviewer feedback)
- `memoria-defensiva-v2.0.md` (partner approved)
- `memoria-defensiva-final.md` (filed/sent)

### Deadlines are Hard Constraints

Italian law has strict deadlines:
- ✅ Court filing deadlines (typically 20-90 days)
- ✅ Statute of limitation (SOL) expiration
- ✅ Response deadlines to court orders
- ✅ Client contract deadlines

**Always track in milestone target date and task deadlines.**

---

## Billing Integration Example

### Time Log in Task File

```markdown
## Time Log

| Agent | Hours | Date | Notes |
|-------|-------|------|-------|
| Associate Attorney | 3.5 | 2026-03-20 | Initial research + statute review |
| Associate Attorney | 2.5 | 2026-03-21 | Case law analysis (Cassazione) |
| Compliance Officer | 1.0 | 2026-03-21 | Jurisdiction + deadline verification |
| Associate Attorney | 4.0 | 2026-03-22 | Document drafting (memoria) |
| Reviewer | 2.0 | 2026-03-23 | Grammar, citations, formatting |
| Senior Partner | 1.5 | 2026-03-24 | Final review + sign-off |
| Paralegal | 1.0 | 2026-03-25 | Filing preparation + client delivery |

**Total Time:** 15.5 hours
**Billable:** 15.5 hours @ €300/hr = €4,650
```

### Invoice Generation

```bash
/office-report investor

# Shows:
# Completed cases: 1
# Total billable hours: 15.5
# Total revenue: €4,650
# Client satisfaction: ✅
```

---

## Italian Legal Standards Checklist

Before partner approval, verify:

- ✅ **Codice Civile** — civil law statutes correctly cited
- ✅ **Codice di Procedura Civile** — procedural rules followed
- ✅ **Court Jurisdiction** — correct tribunal for case type
- ✅ **Deadline Compliance** — filing deadline noted and tracked
- ✅ **Signature Authority** — partner can legally sign
- ✅ **GDPR/Privacy** — no client data exposed
- ✅ **Professional Ethics** — Bar Association (Ordine degli Avvocati) rules followed
- ✅ **Confidentiality** — case file not shared externally
- ✅ **Language** — formal Italian legal register
- ✅ **Formatting** — proper headers, footers, signature lines

---

## Common Document Workflows

### Quick Contract Review (1 day)
```
Research (2h) → Compliance (1h) → Opinion Draft (2h)
→ Review (1h) → Partner (30m) = 6.5 hours
```

### Civil Summons (2-3 days)
```
Research (4h) → Compliance (2h) → Draft (4h)
→ Review (2h) → Partner (1h) = 13 hours
```

### Complex Litigation (4-5 days)
```
Research (6h) → Compliance (3h) → Multiple Drafts (8h)
→ Reviews (3h) → Partner (2h) = 22 hours
```

---

## Support & Resources

### Italian Legal Databases
- **Ius Online** — Italian jurisprudence and legislation
- **CECA** — Cassazione database
- **Ordine degli Avvocati** — Bar Association (ethics, CPD)

### Templates Included
- Atto di Citazione (summons)
- Memoria Difensiva (brief)
- Parere Legale (opinion)
- Contratto (contract)
- Delibera (corporate resolution)

### Agency Files
- `config.md` — Agency configuration
- `pipeline.md` — Document workflows
- `templates.md` — 5+ legal document templates

---

## Getting Help

```bash
# View agent guidance
/office-role associate-attorney
/office-role compliance-officer
/office-role senior-partner

# Check pipeline
/office-milestone status M1

# View templates
cat .ai-office/agencies/italian-legal-studio/templates.md

# Track deadlines
/office-task-list | grep "deadline"
```

---

**Created:** 2026-03-18
**Version:** 1.4.0
**Maintained by:** Andrea (Italian Legal Studio)
**Language:** Italian (it-IT)
**Legal Standard:** Italian Law (Diritto Italiano)

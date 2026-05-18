---
agency: italian-legal-studio
name: Italian Legal Studio
description: Full-service legal practice management with Italian law compliance, document tracking, and case management
custom: false
---

# Italian Legal Studio Agency

## Overview

Complete legal practice management system for Italian law firms. Handles case management, document drafting, client communication, compliance review, and partner approval—following Italian legal standards and terminology.

## Agent Roster

### Active Agents (8)

| Layer | Agents | Role |
|-------|--------|------|
| **Orchestration** | Router | Request classification |
| **Executive** | Senior Partner | Strategic decisions, partner approvals |
| **Legal** | Associate Attorney, Paralegal | Document drafting, research |
| **Compliance** | Compliance Officer | Regulatory checks, filing requirements |
| **Quality** | Reviewer, QA | Legal review, proofreading, citation checks |
| **Operations** | Practice Manager | Client scheduling, billing, deadlines |

### Custom Agent Profiles (Specialized for Legal)

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Managing Partner** | Senior Partner | Client approval, strategic decisions, final signatures |
| **Lead Counsel** | Associate Attorney | Document drafting, legal research, client calls |
| **Support** | Paralegal | Document assembly, formatting, filing prep |
| **Compliance** | Compliance Officer | Compliance reviews, regulatory alignment |
| **QA** | Reviewer | Legal proofreading, citation validation, formatting |
| **Admin** | Practice Manager | Calendar, deadlines, client communication |

## Workflow Pipeline

```
Router
  ↓
Client Brief (intake notes)
  ↓
Research & Analysis (legal research)
  ↓
Compliance Check (regulatory alignment)
  ↓
First Draft (document drafting)
  ↓
Internal Review (associate review)
  ↓
Partner Review (partner approval + signature)
  ↓
Delivery & Filing (send to client, file if needed)
  ↓
Follow-up & Billing
```

## Document Types Supported

### Civil Law
- ✅ Atti di citazione (summons)
- ✅ Memorie difensive (briefs)
- ✅ Ricorsi (petitions)
- ✅ Contratti (contracts)
- ✅ Pareri legali (legal opinions)

### Corporate
- ✅ Atti costitutivi (incorporation documents)
- ✅ Statuti (bylaws)
- ✅ Verbali assembleari (meeting minutes)
- ✅ Delibere (resolutions)

### Property & Real Estate
- ✅ Atti di compravendita (purchase agreements)
- ✅ Compromessi (preliminary contracts)
- ✅ Donazioni (donation deeds)

### Labor Law
- ✅ Contratti di lavoro (employment contracts)
- ✅ Reclami (labor complaints)
- ✅ Risoluzioni (termination agreements)

## Quality Gates

| Gate | Responsibility | Requirements |
|------|----------------|--------------|
| **Research Complete** | Associate | Legal bases cited, precedent research done |
| **Compliance Check** | Compliance Officer | All applicable Italian laws verified, requirements met |
| **First Draft Review** | Reviewer | Grammar, formatting, citation accuracy |
| **Partner Approval** | Senior Partner | Legal soundness, client fit, signature ready |
| **Filing Ready** | Practice Manager | All documents complete, deadlines noted, delivery confirmed |

## Regulatory Compliance

### Italian Legal Standards

- **Civil Procedure Code** (Codice di Procedura Civile) — for court documents
- **Criminal Procedure Code** (Codice di Procedura Penale) — for criminal matters
- **Civil Code** (Codice Civile) — for contracts, property, family law
- **Data Protection** (GDPR + Italian D.Lgs. 196/2003) — client confidentiality
- **Professional Ethics** — Bar Association (Ordine degli Avvocati) rules
- **Billing Standards** — Italian Law Firm Standards

### Document Requirements

- ✅ Correct legal terminology (Italian)
- ✅ Mandatory header/footer formatting
- ✅ Proper citation format (Italian sources)
- ✅ Signature lines with notary space (where applicable)
- ✅ Filing deadline tracking
- ✅ Client confidentiality compliance

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|----------------|------------|
| Draft ↔ Internal Review | 2 | Partner review |
| Partner Review ↔ Revision | 1 | Practice meeting |
| Filing Issues | 0 | Senior Partner + deadline review |

## Quality Thresholds

| Metric | Target | Standard |
|--------|--------|----------|
| Citation Accuracy | 100% | Italian legal databases verified |
| Compliance Check | 100% | All applicable laws reviewed |
| Format Compliance | 100% | Italian court/filing standards |
| Turnaround Time | Client SLA | (configurable per client) |
| Proofreading Pass Rate | ≥ 99% | No errors in final draft |

## MCP Adapters (Italian Legal Context)

### Core Adapters

| Adapter | Usage | Configuration |
|---------|-------|----------------|
| `fetch` | Italian legal databases (Ius Online, CECA) | Authentication token |
| `sequential-thinking` | Complex legal reasoning for cases | Long-context analysis |

### Optional Integrations

| Tool | Purpose | When to Use |
|------|---------|------------|
| Document signing service | eIDAS-compliant signatures | Before client delivery |
| Deadline tracker | Italian court deadlines | All civil/criminal matters |
| Billing system | Time tracking | Track billable hours per task |

## Practice Management

### Client Communication

- ✅ Italian language (formal, legal register)
- ✅ Confidentiality (client data never logged)
- ✅ Deadline-aware (court deadlines, SOL tracking)
- ✅ Status updates on document completion

### Document Versioning

Each document tracked with:
- Version number (1.0, 1.1, etc.)
- Date of last revision
- Reviewed by (initials)
- Status (DRAFT, INTERNAL REVIEW, APPROVED, FILED)

### Billing Integration

```
Task Time Log → Billable Hours → Client Invoice
[tracked in task files] → [aggregated] → [sent via Practice Manager]
```

## Example Document Structure

### Case File Organization

```
.ai-office/cases/
├── civil-dispute-123/
│   ├── 01-intake-notes.md
│   ├── 02-legal-research.md
│   ├── 03-compliance-check.md
│   ├── 04-first-draft.md
│   ├── 05-internal-review.md
│   ├── 06-partner-approved.md
│   └── 07-filed-confirmation.md
```

### Document Artifact Template Locations

```
.ai-office/docs/
├── civil/
│   ├── atto-citazione-template.md
│   ├── memoria-difensiva-template.md
│   └── ricorso-template.md
├── corporate/
│   ├── atto-costitutivo-template.md
│   └── delibera-template.md
└── property/
    ├── compromesso-template.md
    └── atto-compravendita-template.md
```

## Italian-Specific Agents

### Senior Partner (Managing Partner)
- Strategic decisions
- Client relationships
- Document signature authority
- Compliance oversight
- Risk assessment

### Associate Attorney (Lead Counsel)
- Document drafting
- Legal research (Italian databases)
- Client calls (legal advice)
- Deadline tracking
- Case analysis

### Paralegal
- Document assembly
- Formatting per Italian standards
- Filing preparation
- Client communication (administrative)
- Records management

### Compliance Officer (New Role)
- Regulatory verification
- Code compliance (Civil, Criminal, Corporate)
- eIDAS & GDPR compliance
- Professional ethics checks
- SOL & statute tracking

### Reviewer (QA)
- Citation validation
- Grammar & formatting
- Italian legal terminology review
- Cross-reference checking
- Final proofreading

### Practice Manager (Operations)
- Calendar & deadline management
- Client billing
- Status updates
- Filing tracking
- Document delivery

## Performance Metrics

| Metric | Target | Notes |
|--------|--------|-------|
| **Average Document Turnaround** | 5-7 business days | Configurable per case complexity |
| **Compliance Error Rate** | 0% | No regulatory non-compliance allowed |
| **Citation Accuracy** | 100% | All legal references verified |
| **Client SLA Compliance** | ≥ 98% | Deadline adherence |
| **Billable Hours Capture** | ≥ 95% | All work tracked for billing |
| **Partner Approval Time** | < 24 hours | Once submitted for review |

## Italian Law Firm Best Practices

1. **Confidentiality First** — Client data protected per GDPR + Italian privacy law
2. **Deadline Obsessive** — Track SOL (Statuto dei Limiti), court deadlines, filing windows
3. **Formal Italian** — Use proper legal Italian, not casual language
4. **Documentation Trail** — Every decision documented for compliance
5. **Partner Authority** — No document goes to client without partner sign-off
6. **Versioning Discipline** — All drafts tracked, no "lost" versions
7. **Billing Accuracy** — Every hour tracked, no unbilled work

---

**Updated:** 2026-03-18
**Version:** 1.4.0
**Maintainer:** Andrea (Italian Legal Studio)

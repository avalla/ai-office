---
agency: penetration-test-agency
name: Penetration Test Agency
description: Offensive security testing, vulnerability validation, and remediation assurance
---

# Penetration Test Agency Configuration

## Overview

Specialized security agency for penetration testing engagements across web, API, mobile, and infrastructure scopes. Prioritizes evidence-driven findings, remediation validation, and risk reduction.

## Agent Roster

### Active Agents (11)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Design | UX Researcher, Designer | ❌ |
| Creative | Audio Creator, Video Creator, Image Creator, Game Developer | ❌ |
| Technical | Architect, Developer, Security | ✅ |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Release Manager, Ops | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Engagement Lead** | PM | Scope management, rules of engagement, stakeholder coordination |
| **Security Lead** | Security | Offensive testing, vulnerability validation, risk rating |
| **Remediation Lead** | Developer | Fix implementation and hardening |
| **Architecture Advisor** | Architect | Threat model, attack surface, mitigation patterns |
| **Quality Control** | QA, Reviewer | Retest verification and final release readiness |
| **Operations** | Planner, Release Manager, Ops | Planning, signoff, final report archival |

## Workflow Pipeline

```
Router → PM (Scope/ROE) → Architect (Threat Model) → Planner (Test Plan/Tasks)
    → Security (Pentest) → Developer (Remediation) → Security (Retest)
    → QA (Verification) → Reviewer (Signoff) → Release Manager (Deliver) → Ops (Postmortem)
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| Engagement Scope + ROE | PM, CEO |
| Threat Model Baseline | Architect, Security |
| Initial Findings Triage | Security |
| Remediation Completion | Developer, Security |
| Retest Clearance | Security, QA |
| Executive Security Signoff | Reviewer, CEO |

## Proposed Software Stack

Reference baseline: `.ai-office/software-mcp-proposals.md` (Agency-Level Proposal Matrix).

| Software | Purpose |
|----------|---------|
| Snyk CLI + reporting workflow | SAST/SCA/container/IaC scanning and triage |
| Playwright test harness | Auth/session abuse and web attack-path validation |
| API testing suite (Postman/Bruno) | API security scenario execution and reproducibility |
| Evidence capture toolkit | Finding documentation, screenshots, and repro logs |
| Threat modeling documentation stack | Scope, risk analysis, and remediation tracking |

## MCP Adapters

### Core (All Engagements)

| Adapter | Usage |
|---------|-------|
| `snyk` | SAST, SCA, container and IaC vulnerability scanning |
| `playwright` | Auth/session abuse and UI attack-flow testing |
| `fetch` | CVE/advisory and standards research |
| `supabase` | Database policy and RLS validation (when applicable) |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `lighthouse` | Security/performance hardening for web surfaces |
| `ios-simulator` | Mobile pentest smoke validation |

## Project Templates

### Web/Application Pentest

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── prd/<engagement>-scope.md
│   │   ├── adr/<engagement>-threat-model.md
│   │   └── qa/<engagement>-pentest-report.md
│   └── tasks/
├── evidence/
│   ├── screenshots/
│   ├── request-logs/
│   └── repro/
└── deliverables/
```

### API/Infrastructure Assessment

```
your-project/
├── .ai-office/
│   ├── docs/
│   └── tasks/
├── evidence/
│   ├── scan-results/
│   └── exploit-notes/
└── deliverables/
    ├── executive-summary.md
    └── technical-findings.md
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| Security ↔ Developer (Fix/Retest) | 2 | Planner |
| QA ↔ Security (Verification) | 2 | Reviewer |

## Quality Thresholds

| Metric | Target |
|--------|--------|
| Open Critical Findings | 0 |
| Open High Findings | 0 before release |
| Retest Evidence Coverage | 100% |
| Reproducibility of Findings | 100% |

---

Updated: 2026-03-10

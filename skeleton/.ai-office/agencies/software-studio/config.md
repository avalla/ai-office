---
agency: software-studio
name: Software Studio
description: Full-stack web and mobile application development
---

# Software Studio Configuration

## Overview

Full-service software development agency for web applications, mobile apps, and APIs. Follows complete SDLC with all quality gates.

## Agent Roster

### Active Agents (13)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Design | UX Researcher, Designer | ✅ |
| Creative | Audio Creator, Video Creator, Image Creator, Game Developer | ❌ |
| Technical | Architect, Developer, Security | ✅ |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Release Manager, Ops | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Project Lead** | CEO | Strategic decisions, PRD approval |
| **Product Owner** | PM | Requirements, user stories |
| **Design Lead** | Designer | UI/UX, design system |
| **Tech Lead** | Architect | Architecture, ADRs |
| **Development** | Developer | Implementation |
| **Security** | Security Specialist | Security audits |
| **Quality** | QA, Reviewer | Testing, code review |
| **Operations** | Planner, Release Manager, Ops | Planning, releases, postmortems |

## Workflow Pipeline

```
Router → PM (PRD) → CEO (Approve) → Architect (ADR) → Planner (Tasks)
    → Designer (UI) → Developer (Implement) → QA (Test) → Reviewer (Review)
    → Security (Audit) → Release Manager (Deploy) → Ops (Postmortem)
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| PRD Approval | CEO |
| Architecture Approval | CEO (major), Architect (minor) |
| Design Review | Designer, PM |
| Code Review | Reviewer |
| QA Clearance | QA |
| Security Clearance | Security Specialist |
| Release Authorization | CEO, Release Manager |

## Proposed Software Stack

Reference baseline: `.ai-office/software-mcp-proposals.md` (Agency-Level Proposal Matrix).

| Software | Purpose |
|----------|---------|
| TypeScript + React (Vite/Next.js) | Frontend application development |
| Node.js/Bun | API and backend runtime |
| Supabase | Database, auth, storage, and analytics |
| Vitest/Jest + Playwright | Unit/integration and E2E testing |
| GitHub Actions | CI checks and release automation |

## MCP Adapters

### Core (All Projects)

| Adapter | Usage |
|---------|-------|
| `supabase` | Database, auth, storage |
| `snyk` | Security scanning |
| `playwright` | E2E testing |
| `lighthouse` | Performance auditing |
| `fetch` | Documentation lookup |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `ios-simulator` | iOS app development |
| `revenuecat` | Subscription features |
| `stitch` | UI generation |

## Project Templates

### Web Application

```
your-project/
├── .ai-office/          ← Framework engine
├── .ai-office/
│   ├── docs/
│   │   ├── prd/<slug>-prd.md
│   │   ├── adr/<slug>-adr.md
│   │   └── qa/<slug>-testplan.md
│   └── tasks/
├── src/
├── tests/
└── README.md
```

### Mobile App

```
your-project/
├── .ai-office/          ← Framework engine
├── .ai-office/
│   ├── docs/
│   └── tasks/
├── apps/
│   ├── ios/
│   └── android/
├── packages/
│   └── shared/
└── README.md
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| Dev ↔ QA | 2 | Planner |
| Review ↔ Dev | 2 | Architect |
| Planning Revisions | 3 | CEO |

## Quality Thresholds

| Metric | Target |
|--------|--------|
| Code Coverage | ≥ 80% |
| Lighthouse Score | ≥ 90 |
| Security Vulnerabilities | 0 high/critical |
| Test Pass Rate | 100% |

---

Updated: 2026-03-10

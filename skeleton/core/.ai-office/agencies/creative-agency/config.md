---
agency: creative-agency
name: Creative Agency
description: Media production, marketing campaigns, and content creation
---

# Creative Agency Configuration

## Overview

Full-service creative agency for marketing campaigns, video production, graphic design, and brand content. Focuses on visual storytelling and content quality.

## Agent Roster

### Active Agents (11)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Design | UX Researcher, Designer | ✅ |
| Creative | Audio Creator, Video Creator, Image Creator, Game Developer | ✅ |
| Technical | Architect, Developer, Security | ❌ |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Release Manager, Ops | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Creative Director** | CEO | Creative vision, final approval |
| **Project Manager** | PM | Briefs, timelines, client communication |
| **Art Director** | Designer | Visual direction, brand consistency |
| **Video Lead** | Video Creator | Video production, motion graphics |
| **Audio Lead** | Audio Creator | Sound design, music, voice |
| **Image Lead** | Image Creator | Photography, graphics, illustrations |
| **Quality Control** | QA | Asset review, accessibility |
| **Operations** | Planner, Release Manager, Ops | Delivery, distribution |

## Workflow Pipeline

```
Router → PM (Brief) → CEO (Approve) → Designer (Art Direction)
    → [Video Creator + Audio Creator + Image Creator] (Production)
    → QA (Review) → Release Manager (Deliver) → Ops (Archive)
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| Creative Brief | CEO |
| Art Direction | Designer, CEO |
| Asset Review | QA |
| Final Delivery | CEO, PM |

## Proposed Software Stack

Reference baseline: `.ai-office/software-mcp-proposals.md` (Agency-Level Proposal Matrix).

| Software | Purpose |
|----------|---------|
| Figma/Design Suite | Art direction, layouts, and brand consistency |
| DaVinci Resolve/Premiere | Video editing and finishing |
| Audition/DAW tooling | Sound design and audio mastering |
| Asset CMS + Export Pipeline | Asset versioning, approvals, and delivery tracking |
| Web delivery tooling | Campaign landing and media publishing |

## MCP Adapters

### Core (All Projects)

| Adapter | Usage |
|---------|-------|
| `runcomfy` | AI image/video generation |
| `stitch` | UI design generation |
| `lighthouse` | Asset performance |
| `fetch` | Research, references |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `playwright` | Web asset testing |
| `ios-simulator` | Mobile asset preview |

## Project Templates

### Video Campaign

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/<campaign>-brief.md
│   │   └── assets/<campaign>-assets.md
│   └── tasks/
├── assets/
│   ├── video/
│   ├── audio/
│   └── images/
└── deliverables/
```

### Brand Identity

```
your-project/
├── .ai-office/
│   └── docs/
├── assets/
│   ├── logo/
│   ├── colors/
│   ├── typography/
│   └── templates/
└── guidelines/
    └── brand-guidelines.md
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| Creative ↔ Feedback | 3 | CEO |
| Asset ↔ QA | 2 | Designer |

## Quality Thresholds

| Metric | Target |
|--------|--------|
| Brand Consistency | 100% |
| Accessibility (WCAG) | AA |
| Asset Optimization | Web-optimized |
| Client Satisfaction | Approved |

---

Updated: 2026-03-10

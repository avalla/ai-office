---
agency: media-agency
name: Media Agency
description: Video and movie production with structured pre-production to delivery workflows
---

# Media Agency Configuration

## Overview

Specialized media production agency for videos, short films, and movie-style projects. Focuses on story quality, production discipline, and delivery-readiness across multiple platforms.

## Agent Roster

### Active Agents (12)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Design | UX Researcher, Designer | ⚠️ (Designer active, UX optional) |
| Creative | Audio Creator, Video Creator, Image Creator, Game Developer | ✅ (Game Developer optional) |
| Technical | Architect, Developer, Security | ❌ |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Release Manager, Ops | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Creative Producer** | PM | Scheduling, budget, stakeholder updates |
| **Creative Director** | CEO | Creative vision and final cut approval |
| **Visual Director** | Designer | Storyboards, visual language, art direction |
| **Video Lead** | Video Creator | Cinematic editing, compositing, final outputs |
| **Audio Lead** | Audio Creator | Music, dialogue cleanup, mix/master |
| **Image Lead** | Image Creator | Posters, stills, thumbnails, artwork |
| **Quality Control** | QA, Reviewer | Technical QC, narrative consistency, final signoff |
| **Operations** | Planner, Release Manager, Ops | Delivery operations, archival, postmortem |

## Workflow Pipeline

```
Router → PM (Treatment/Plan) → CEO (Greenlight) → Designer (Storyboard)
    → [Video Creator + Audio Creator + Image Creator] (Production)
    → QA (Technical QC) → Reviewer (Editorial/Brand Review)
    → Release Manager (Distribution) → Ops (Archive/Learnings)
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| Treatment Approval | CEO, PM |
| Storyboard Lock | Designer, PM |
| Rough Cut Review | CEO, Reviewer |
| Final Cut Approval | CEO, QA |
| Distribution Signoff | Release Manager, PM |

## Proposed Software Stack

Reference baseline: `.ai-office/software-mcp-proposals.md` (Agency-Level Proposal Matrix).

| Software | Purpose |
|----------|---------|
| DaVinci Resolve/Premiere | Video editing, color, and final mastering |
| Audio DAW stack | Dialogue cleanup, music, and mix/master workflows |
| Image/graphics suite | Key art, stills, poster, and thumbnail production |
| Media asset management | Versioning, approvals, and delivery packaging |
| Publishing/distribution toolkit | Multi-platform release preparation and tracking |

## MCP Adapters

### Core (All Productions)

| Adapter | Usage |
|---------|-------|
| `runcomfy` | AI-assisted image/video generation and edits |
| `fetch` | Research, references, competitive benchmarks |
| `playwright` | Playback/landing page validation for published assets |
| `lighthouse` | Media page performance and delivery quality |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `stitch` | Fast visual concept and UI mock generation |
| `ios-simulator` | Mobile-first playback and UX previews |

## Project Templates

### Video Production Project

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/<production>-treatment.md
│   │   ├── runbooks/<production>-plan.md
│   │   └── qa/<production>-qc.md
│   └── tasks/
├── assets/
│   ├── footage/
│   ├── audio/
│   ├── graphics/
│   └── exports/
└── deliverables/
```

### Movie / Short Film Project

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/<movie>-treatment.md
│   │   ├── brief/<movie>-shot-list.md
│   │   └── qa/<movie>-post-qc.md
│   └── tasks/
├── preproduction/
├── production/
├── post/
└── distribution/
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| Rough Cut ↔ Feedback | 3 | CEO |
| Final Cut ↔ QA | 2 | Reviewer |

## Quality Thresholds

| Metric | Target |
|--------|--------|
| Caption Coverage | 100% for final exports |
| Technical Delivery Compliance | 100% |
| Brand/Story Consistency | Approved |
| Distribution Package Completeness | 100% |

---

Updated: 2026-03-10

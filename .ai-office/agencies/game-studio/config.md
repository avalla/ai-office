---
agency: game-studio
name: Game Studio
description: Game development and interactive experiences
---

# Game Studio Configuration

## Overview

Full-service game development studio for video games, interactive experiences, and game-like applications. Focuses on gameplay, performance, and player experience.

## Agent Roster

### Active Agents (12)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Design | UX Researcher, Designer | ✅ |
| Creative | Audio Creator, Video Creator, Image Creator, Game Developer | ✅ |
| Technical | Architect, Developer, Security | ✅ (limited) |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Release Manager, Ops | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Executive Producer** | CEO | Creative vision, go/no-go |
| **Producer** | PM | Game design document, features |
| **Game Director** | Game Developer | Gameplay, mechanics, systems |
| **Art Director** | Designer | Visual style, UI/UX |
| **Audio Director** | Audio Creator | Sound design, music |
| **Tech Lead** | Architect | Engine, performance |
| **QA Lead** | QA | Playtesting, bugs |
| **Operations** | Planner, Release Manager, Ops | Milestones, deployment |

## Workflow Pipeline

```
Router → PM (GDD) → CEO (Approve) → Architect (Engine) → Game Developer (Core)
    → [Designer + Audio Creator + Image Creator] (Assets)
    → Game Developer (Integration) → QA (Playtest) → Reviewer (Code)
    → Release Manager (Ship) → Ops (Postmortem)
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| GDD Approval | CEO |
| Technical Design | Architect |
| Art Direction | Designer, CEO |
| Playtest Pass | QA |
| Performance Check | Architect |
| Release Authorization | CEO, Release Manager |

## Proposed Software Stack

Reference baseline: `.ai-office/software-mcp-proposals.md` (Agency-Level Proposal Matrix).

| Software | Purpose |
|----------|---------|
| Unity/Unreal/Godot | Core game and interactive experience development |
| TypeScript/WebGL stack | Browser game development and integration |
| Asset pipeline tooling | Art/audio/import/export management |
| Profiling + telemetry tooling | Performance tuning and gameplay diagnostics |
| Build/release packaging tools | Multi-platform build and distribution |

## MCP Adapters

### Core (All Projects)

| Adapter | Usage |
|---------|-------|
| `runcomfy` | AI asset generation |
| `ios-simulator` | iOS game testing |
| `playwright` | Web game testing |
| `snyk` | Security scanning |
| `fetch` | Documentation lookup |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `supabase` | Backend features |
| `revenuecat` | In-app purchases |

## Project Templates

### Unity Game

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── gdd/<game>-gdd.md
│   │   ├── technical/<game>-tech.md
│   │   └── qa/<game>-playtest.md
│   └── tasks/
├── Assets/
│   ├── Scripts/
│   ├── Art/
│   ├── Audio/
│   └── Prefabs/
├── ProjectSettings/
└── Builds/
```

### Web Game

```
your-project/
├── .ai-office/
│   └── docs/
├── src/
│   ├── game/
│   ├── assets/
│   └── index.html
├── tests/
└── dist/
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| Gameplay ↔ Playtest | 3 | Game Developer |
| Asset ↔ Integration | 2 | Game Developer |
| Performance ↔ Optimization | 2 | Architect |

## Quality Thresholds

| Metric | Target |
|--------|--------|
| Frame Rate | ≥ 60 FPS |
| Load Time | < 3 seconds |
| Memory Usage | Platform-specific |
| Crash Rate | 0 in playtest |
| Playtest Pass Rate | 100% critical bugs fixed |

---

Updated: 2026-03-10

---
agency: game-studio
---

# Game Studio Pipeline

## Standard Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GAME STUDIO PIPELINE                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  00_router ──► 01_create_project ──► 10_ceo_prd (GDD)               │
│      │              │                      │                          │
│      │              ▼                      ▼                          │
│      │         PM creates            CEO approves                     │
│      │         Game Design Doc       game concept                    │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              20_arch_adr                       │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Architect designs engine         │
│      │                              and technical architecture       │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              05_planner                        │
│      │                              30_plan_tasks                      │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Planner creates milestones       │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              28_game_create                   │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Game Developer implements core    │
│      │              ┌───────────────────────┼───────────────────────┐│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ▼│
│      │        25_design_ui           26_audio_create         29_image_create│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ▼│
│      │         Designer              Audio Creator          Image Creator │
│      │         creates UI            creates audio          creates art   │
│      │              │                       │                       ││
│      │              └───────────────────────┼───────────────────────┘│
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              28_game_create (Integration)      │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Game Developer integrates assets  │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              50_qa_validate (Playtest)         │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              QA conducts playtesting          │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              60_review_merge                  │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Reviewer checks code             │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              70_release (Ship)                │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Release Manager deploys build    │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              90_postmortem_memory              │
│      │                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Milestone Pipeline

Game development follows milestone phases:

```
Pre-production → Prototype → Alpha → Beta → Gold → Ship
```

### Pre-production

```
GDD → Technical Design → Prototype Plan → Proof of Concept
```

### Alpha

```
Core Systems → Basic Gameplay → Internal Playtest
```

### Beta

```
Feature Complete → Content Complete → External Playtest
```

### Gold

```
Bug Fixing → Polish → Certification → Release Candidate
```

## Hotfix Pipeline

```
Bug Report → QA (Reproduce) → Game Developer (Fix) → QA (Verify) → Release (Patch)
```

## Parallel Production

Game development has extensive parallel workflows:

| Phase | Parallel Workflows |
|-------|-------------------|
| Pre-production | Designer (UI) + Architect (Tech) + PM (GDD) |
| Production | Game Dev (Code) + Audio + Image + Designer |
| Integration | Game Dev (Integrate) + QA (Smoke test) |

## Checkpoints

| Checkpoint | Trigger | Required Artifacts |
|------------|---------|-------------------|
| GDD Complete | PM completes | Game Design Document |
| Tech Design Complete | Architect completes | Technical Spec |
| Prototype Ready | Game Dev completes | Playable prototype |
| Alpha Milestone | All core features | Alpha build |
| Beta Milestone | Feature complete | Beta build |
| Gold Master | All bugs fixed | Release candidate |

---

Updated: 2026-03-09

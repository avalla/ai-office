---
agency: software-studio
---

# Software Studio Pipeline

## Standard Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SOFTWARE STUDIO PIPELINE                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  00_router ──► 01_create_project ──► 10_ceo_prd                     │
│      │              │                      │                          │
│      │              ▼                      ▼                          │
│      │         PM creates            CEO approves                     │
│      │         PRD draft             PRD                             │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              20_arch_adr                       │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Architect creates ADR             │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              05_planner                        │
│      │                              30_plan_tasks                      │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Planner breaks down tasks         │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              22_ux_research                    │
│      │                              25_design_ui                      │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Designer creates UI               │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              40_dev_implement                  │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Developer implements             │
│      │                                      │                         │
│      │              ┌───────────────────────┼───────────────────────┐│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ▼│
│      │        50_qa_validate         45_security_pentest      60_review_merge│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ▼│
│      │         QA tests            Security audits          Reviewer  │
│      │              │                       │                  reviews│
│      │              └───────────────────────┼───────────────────────┘│
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              70_release                        │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Release Manager deploys           │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              90_postmortem_memory              │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Ops captures learnings            │
│      │                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Fast-Track Pipeline (Simple Features)

For simple features that don't require full pipeline:

```
Router → PM (User Story) → Developer (Implement) → QA (Test) → Reviewer (Merge) → Release
```

**Conditions for Fast-Track:**
- Single component change
- No architectural impact
- No new dependencies
- Clear acceptance criteria

## Bug Fix Pipeline

```
Router → QA (Reproduce) → Developer (Fix) → QA (Verify) → Reviewer (Merge) → Release
```

## Hotfix Pipeline

```
Router → Developer (Fix) → Security (Quick Scan) → Release Manager (Deploy)
```

## Parallel Workflows

Some workflows can run in parallel:

| Phase | Parallel Workflows |
|-------|-------------------|
| Design Phase | UX Research + Designer |
| Implementation | Developer + Security (code review) |
| Validation | QA + Security (audit) + Reviewer |

## Checkpoints

| Checkpoint | Trigger | Required Artifacts |
|------------|---------|-------------------|
| PRD Complete | PM submits | PRD document |
| Architecture Defined | Architect completes | ADR document |
| Design Ready | Designer completes | UI specs, mockups |
| Implementation Ready | Developer starts | Task files |
| QA Ready | Developer completes | Code, tests |
| Release Ready | All gates pass | All clearances |

---

Updated: 2026-03-09

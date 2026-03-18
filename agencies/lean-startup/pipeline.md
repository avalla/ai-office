---
agency: lean-startup
---

# Lean Startup Pipeline

## Standard Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LEAN STARTUP PIPELINE                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  00_router ──► 01_create_project ──► 10_ceo_prd (Hypothesis)        │
│      │              │                      │                          │
│      │              ▼                      ▼                          │
│      │         PM defines            CEO validates                   │
│      │         hypothesis             business case                   │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              40_dev_implement                  │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              Developer builds MVP             │
│      │                              (with minimal tests)              │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              70_release (Deploy)              │
│      │                                      │                         │
│      │                                      ▼                         │
│      │                              CEO measures results             │
│      │                                      │                         │
│      │              ┌───────────────────────┼───────────────────────┐│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ││
│      │         VALIDATED              NEEDS PIVOT                   ││
│      │         Continue               Redefine                      ││
│      │         building               hypothesis                     ││
│      │              │                       │                       ││
│      │              ▼                       ▼                       ││
│      │         Next feature          Back to hypothesis             ││
│      │                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Build-Measure-Learn Cycle

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                        BUILD-MEASURE-LEARN                           │
│                                                                      │
│                     ┌─────────────────────┐                          │
│                     │       BUILD         │                          │
│                     │   (MVP Feature)     │                          │
│                     └──────────┬──────────┘                          │
│                                │                                     │
│                                ▼                                     │
│                     ┌─────────────────────┐                          │
│                     │      MEASURE        │                          │
│                     │   (Metrics/Usage)   │                          │
│                     └──────────┬──────────┘                          │
│                                │                                     │
│                                ▼                                     │
│                     ┌─────────────────────┐                          │
│                     │       LEARN         │                          │
│                     │   (Insights)        │                          │
│                     └──────────┬──────────┘                          │
│                                │                                     │
│                     ┌──────────┴──────────┐                          │
│                     │                     │                          │
│                     ▼                     ▼                          │
│               PERSEVERE               PIVOT                           │
│               (Continue)             (Change)                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Sprint Pipeline (1-2 Week Sprints)

```
Day 1:    Hypothesis → Design
Day 2-4:  Build MVP
Day 5:    Deploy → Measure
Day 6-7:  Analyze → Learn
Day 8:    Decision: Continue/Pivot
Day 9-10: Next iteration
```

## Feature Validation Pipeline

```
Hypothesis → Build Minimal → Deploy → Measure → Validate → Decision
```

**Decision Outcomes:**
- **Persevere:** Continue building
- **Pivot:** Change direction
- **Kill:** Stop feature

## Parallel Work

Minimal parallelization for focus:

| Phase | Work |
|-------|------|
| Build | Developer (implementation) |
| Measure | CEO (metrics analysis) |

## Checkpoints

| Checkpoint | Trigger | Required |
|------------|---------|----------|
| Hypothesis Defined | PM completes | Hypothesis doc |
| MVP Built | Developer completes | Working code |
| Data Collected | After 1 week | Metrics |
| Learning Captured | CEO analyzes | Insights |

---

Updated: 2026-03-09

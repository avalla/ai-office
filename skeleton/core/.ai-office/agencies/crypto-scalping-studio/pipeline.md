---
agency: crypto-scalping-studio
---

# Crypto Scalping Studio Pipeline

## Standard Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│            CRYPTO SCALPING STUDIO STANDARD PIPELINE              │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  00_router ──► 10_signal_brief ──► 15_risk_parameters            │
│      │               │                      │                    │
│      │               ▼                      ▼                    │
│      │          PM captures            Risk Manager sets         │
│      │          market brief           drawdown limits           │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              05_planner                   │
│      │                              20_plan_tasks                │
│      │                                      │                    │
│      │                    ┌─────────────────┤                    │
│      │                    │                 │                    │
│      │                    ▼                 ▼                    │
│      │             25_signal_design    30_implement              │
│      │                    │                 │                    │
│      │                    ▼                 ▼                    │
│      │             Signal Analyst      Developer codes           │
│      │             designs indicators  strategy + bot            │
│      │                    │                 │                    │
│      │                    └─────────────────┤                    │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              40_backtest                  │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              QA runs historical           │
│      │                              simulation + walk-forward    │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              50_strategy_review           │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              Reviewer checks logic,       │
│      │                              overfitting, sensitivity     │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              60_paper_trade               │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              QA runs paper trade          │
│      │                              ≥ 7 days, live feed          │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              70_deploy_live               │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              Release Manager deploys      │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              80_monitor                   │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              Ops monitors PnL,            │
│      │                              alerts, circuit breakers     │
│      │                                      │                    │
│      │                              90_postmortem                │
│      │                                      │                    │
│      │                                      ▼                    │
│      │                              Ops archives results,        │
│      │                              feeds back to Signal Analyst │
│      │                                      │                    │
└──────────────────────────────────────────────────────────────────┘
```

## Signal Exploration Pipeline (Pre-Commit Research)

When market conditions or a new asset class need investigation before committing to a strategy:

```
Router → PM (Brief) → Signal Analyst (Explore 2–3 Indicator Combos)
    → Risk Manager (Feasibility) → CEO (Select Direction)
    → [Standard Pipeline from risk_parameters onwards]
```

## Underperformance Recovery Pipeline

Triggered when a live strategy falls below quality thresholds:

```
Ops (Alert) → CEO (Halt Decision) → Signal Analyst (Diagnose)
    → Scalping Engineer (Parameter Revision) → QA (Re-backtest)
    → Reviewer (Re-review) → Release Manager (Re-deploy or Retire)
```

## Emergency Halt Pipeline

Triggered by circuit breaker (drawdown > limit, exchange outage, anomalous fills):

```
Ops (Detect) → [auto halt: cancel all orders, close positions]
    → CEO (Notify immediately) → PM (Incident report)
    → Architect (Root cause) → Release Manager (Safe restart or retire)
```

## Parallel Workflows

| Phase | Parallel Workflows |
|-------|-------------------|
| Build Phase | Developer (code) + Signal Analyst (indicator refinement) |
| Backtest Phase | QA (backtest) + Reviewer (logic review) |
| Live Phase | Ops (monitoring) + PM (performance reporting) |

## Checkpoints

| Checkpoint | Trigger | Required Artifacts |
|------------|---------|-------------------|
| Signal Brief Approved | PM submits, CEO approves | `<slug>-brief.md` |
| Risk Parameters Set | Risk Manager completes | `<slug>-risk.md` ADR |
| Backtest Accepted | QA completes, thresholds met | Backtest report + metrics |
| Strategy Reviewed | Reviewer signs off | Review notes in status file |
| Paper Trade Approved | QA completes ≥ 7 days | Paper trade report |
| Live Deploy Authorized | CEO + Release Manager approve | `<slug>-deploy.md` runbook |
| Performance Reviewed | Ops completes weekly | PnL report, drawdown log |

---

Updated: 2026-03-20

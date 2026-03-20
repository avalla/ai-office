---
agency: crypto-scalping-studio
name: Crypto Scalping Studio
description: Cryptocurrency scalping strategy development, signal generation, and live trading operations
custom: true
---

# Crypto Scalping Studio Configuration

## Overview

Full-service crypto trading studio for developing, backtesting, and deploying scalping strategies and signal services. Covers the complete signal-to-live pipeline: market research, indicator design, strategy codification, backtesting, paper trading, risk review, live deployment, and ongoing monitoring.

## Agent Roster

### Active Agents (9)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Technical | Scalper, Developer, Architect | ✅ |
| Analytics | Signal Analyst | ✅ |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Ops, Release Manager | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Trading Director** | CEO | Strategic vision, risk appetite, capital allocation approval |
| **Project Manager** | PM | Sprint planning, milestone tracking, client/investor liaison |
| **Signal Analyst** | Signal Analyst | Market research, indicator selection, signal logic design, backtest review |
| **Scalping Engineer** | Scalper | Execution rules, order flow logic, latency optimization, entry/exit tuning |
| **Quant Developer** | Developer | Strategy codification, backtesting engine, bot implementation, API integrations |
| **Risk Manager** | Architect | Risk parameters, position sizing, drawdown limits, circuit breakers |
| **Backtester / QA** | QA | Historical simulation, walk-forward testing, signal quality validation |
| **Strategy Reviewer** | Reviewer | Logic review, overfitting checks, parameter sensitivity analysis |
| **Ops Monitor** | Ops | Live monitoring, alert triage, incident response, PnL tracking |
| **Delivery Manager** | Release Manager | Packaging deployment runbooks, versioning live strategy, coordinating release |

## Workflow Pipeline

```
Router → PM (Brief) → Signal Analyst (Research) → Risk Manager (Parameters)
    → Planner (Task Breakdown) → Scalping Engineer (Strategy Design)
    → Developer (Implement) → QA (Backtest + Paper Trade)
    → Reviewer (Strategy Review) → Release Manager (Deploy Live)
    → Ops (Monitor) → [loop: Signal Analyst if underperforming]
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| Signal Brief Approval | CEO, PM |
| Risk Parameters Sign-off | Architect (Risk Manager), CEO |
| Backtest Results Acceptance | QA, Signal Analyst |
| Strategy Review Clearance | Reviewer |
| Paper Trade Approval | QA, CEO |
| Live Deploy Authorization | CEO, Release Manager |
| Performance Review | Ops, CEO |

## Proposed Software Stack

| Software | Purpose |
|----------|---------|
| Python / TypeScript | Strategy logic, bot implementation, backtesting |
| CCXT | Unified exchange API (Binance, Bybit, OKX, etc.) |
| Supabase | Signal logs, trade history, PnL tracking |
| TradingView Pine Script | Signal visualization and alert integration |
| GitHub Actions | Strategy versioning and deployment CI |
| Markdown + runbooks | Signal briefs, risk ADRs, deployment docs |

## MCP Adapters

### Core (All Projects)

| Adapter | Usage |
|---------|-------|
| `fetch` | Exchange API docs, market data feeds, news sentiment |
| `sequential-thinking` | Signal logic design, risk parameter trade-offs, drawdown analysis |
| `supabase` | Trade logs, signal history, performance metrics storage |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `mcp-playwright` | TradingView automation, exchange dashboard scraping |
| `postgresql` | Direct query on large tick-data history when Supabase is insufficient |

## Project Templates

### Single Strategy

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/<slug>-brief.md
│   │   ├── adr/<slug>-risk.md
│   │   ├── runbooks/<slug>-backtest.md
│   │   └── runbooks/<slug>-deploy.md
│   └── tasks/
├── strategies/
│   ├── <slug>/
│   │   ├── signal.py
│   │   ├── executor.py
│   │   └── config.json
│   └── shared/
│       ├── indicators.py
│       └── risk.py
├── backtests/
│   ├── results/<slug>-YYYY-MM-DD.json
│   └── reports/<slug>-YYYY-MM-DD.md
├── bots/
│   └── <slug>-bot/
└── README.md
```

### Signal Service (Multi-strategy + Subscribers)

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/
│   │   ├── adr/
│   │   └── runbooks/
│   └── tasks/
├── strategies/
│   ├── scalp-btc/
│   ├── scalp-eth/
│   └── shared/
├── signal-service/
│   ├── api/          (REST/WebSocket signal delivery)
│   ├── alerts/       (Telegram, Discord, webhook)
│   └── dashboard/    (subscriber-facing UI)
├── backtests/
├── bots/
└── README.md
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| Backtest ↔ Parameter Tuning | 3 | Risk Manager |
| Paper Trade ↔ Strategy Revision | 2 | CEO |
| Live Monitor ↔ Emergency Halt | 1 | CEO (immediate) |

## Quality Thresholds

| Metric | Minimum Target |
|--------|---------------|
| Backtest Sharpe Ratio | ≥ 1.5 |
| Max Drawdown (backtest) | ≤ 15% |
| Win Rate | ≥ 52% |
| Risk/Reward per Trade | ≥ 1.2 |
| Paper Trade Duration | ≥ 7 days before live |
| Signal Latency | ≤ 500 ms from trigger to order |

---

Updated: 2026-03-20

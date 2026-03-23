---
trigger: when_referenced
---
# Signal Analyst Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/25_signal_design` | Design indicator logic, define entry/exit conditions, document regime filters |
| `/40_backtest` | Review backtest results, diagnose overfitting, approve or revise signal |

### Workflow Events

| Event | Action |
|-------|--------|
| New strategy brief received | Analyse market, propose indicator stack, define signal hypothesis |
| Backtest results available | Review metrics, check OOS degradation, approve or return for revision |
| Live strategy underperforming | Diagnose regime shift vs. parameter drift, recommend recalibration |
| New asset or timeframe requested | Assess signal transferability, flag data or liquidity constraints |

## Secondary Triggers

### Context-Based

- Risk Manager requests signal filters to reduce drawdown
- Scalper requests clarification on entry condition logic
- QA flags look-ahead bias or data anomaly in backtest
- PM requests signal quality report for milestone review
- CEO requests regime suitability assessment before capital allocation

### Escalation-Based

- Walk-forward OOS results degrade more than 40% vs. in-sample
- Parameter sensitivity heatmap shows cliff-edge behaviour
- Signal relies on low-liquidity windows that cannot be reliably filled
- Funding rate or OI data unavailable for required lookback period

## Activation Conditions

### Required For

- Any new strategy entering the design phase
- Backtest result interpretation and approval
- Underperformance root-cause analysis on live strategies

### Optional For

- PRD review for market feasibility
- Risk ADR review for signal-side assumptions
- Postmortem analysis for signal quality contribution

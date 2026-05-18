---
agency: crypto-scalping-studio
---

# Crypto Scalping Studio Templates

## Signal Brief Template

```markdown
# Signal Brief: [Strategy Name]

## Overview
One-line description of the strategy.

## Target Market
- Exchange(s): (Binance, Bybit, OKX, etc.)
- Asset(s): (BTC/USDT, ETH/USDT, etc.)
- Timeframe(s): (1m, 3m, 5m, 15m)
- Market type: Spot | Perpetual Futures | Options

## Signal Logic
- Primary indicator(s):
- Secondary/confirmation indicator(s):
- Entry condition:
- Exit condition (take profit):
- Exit condition (stop loss):
- Trailing stop: Yes | No

## Execution Parameters
- Order type: Market | Limit | Post-only
- Position size: (% of capital per trade)
- Max open positions:
- Min signal interval: (seconds between consecutive entries)

## Risk Constraints
- Max drawdown per day: %
- Max drawdown total: %
- Circuit breaker trigger: (condition to halt all trading)

## Capital Allocation
- Initial allocation: USDT
- Leverage: (1× recommended for scalping unless explicitly approved)

## Backtesting Scope
- Historical period: YYYY-MM-DD to YYYY-MM-DD
- Walk-forward window: (e.g. 30-day in-sample / 7-day out-of-sample)

## Success Criteria
- Min Sharpe Ratio:
- Max Drawdown:
- Min Win Rate:
- Min Risk/Reward:

## Deadline
- Backtest complete: YYYY-MM-DD
- Paper trade start: YYYY-MM-DD
- Live deploy target: YYYY-MM-DD
```

## Risk ADR Template

```markdown
# ADR: Risk Parameters — [Strategy Name]

## Status
Proposed | Accepted | Rejected

## Context
What risks does this strategy present? (market, execution, liquidity, counterparty)

## Decision
What risk framework is being adopted for this strategy?

## Position Sizing

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Capital per trade | % | |
| Max concurrent positions | | |
| Max daily loss | % | |
| Max total drawdown | % | |
| Leverage | × | |

## Circuit Breakers

| Trigger | Action |
|---------|--------|
| Daily loss > X% | Halt all entries for the day |
| Consecutive losses > N | Pause strategy, notify Ops |
| Exchange latency > Xms | Switch to market orders / halt |
| Fill deviation > X% | Log and review, halt if persistent |

## Options Considered

### Option 1: [Name]
- Pros:
- Cons:

### Option 2: [Name]
- Pros:
- Cons:

## Consequences
Risk commitments and constraints this decision imposes on the implementation.

## References
- Exchange margin rules, funding rate schedule
- Applicable regulatory considerations
```

## Backtest Report Template

```markdown
# Backtest Report: [Strategy Name]

## Run Date
YYYY-MM-DD

## Configuration

| Parameter | Value |
|-----------|-------|
| Strategy | |
| Asset | |
| Timeframe | |
| Period | YYYY-MM-DD → YYYY-MM-DD |
| Initial Capital | USDT |
| Commission | % per trade |
| Slippage Model | (none / fixed / market impact) |

## Results Summary

| Metric | Value | Threshold | Pass/Fail |
|--------|-------|-----------|-----------|
| Total Return | % | | |
| Sharpe Ratio | | ≥ 1.5 | |
| Max Drawdown | % | ≤ 15% | |
| Win Rate | % | ≥ 52% | |
| Avg Risk/Reward | | ≥ 1.2 | |
| Total Trades | | | |
| Avg Trade Duration | | | |
| Profit Factor | | | |

## Equity Curve
[File path or embedded chart]

## Trade Distribution
[Histogram or summary table]

## Walk-Forward Results

| Window | In-Sample Return | Out-of-Sample Return | Degradation |
|--------|-----------------|---------------------|-------------|
| | | | |

## Notable Observations
[Regime-specific behavior, known weaknesses, sensitivity to parameters]

## Approval Status
- [ ] QA approved
- [ ] Signal Analyst approved
- [ ] Risk Manager approved
```

## Paper Trade Report Template

```markdown
# Paper Trade Report: [Strategy Name]

## Period
YYYY-MM-DD to YYYY-MM-DD (N days)

## Exchange / Asset
[Exchange, asset pair, timeframe]

## Results

| Metric | Value | Backtest Target | Delta |
|--------|-------|----------------|-------|
| Total Return | % | | |
| Sharpe Ratio | | | |
| Max Drawdown | % | | |
| Win Rate | % | | |
| Total Trades | | | |

## Slippage Analysis
Difference between expected and actual fill prices.

| Session | Avg Slippage | Max Slippage | Notes |
|---------|-------------|-------------|-------|
| | | | |

## Circuit Breaker Events
[Any events that triggered halts or alerts]

## Issues Encountered
[Latency spikes, exchange errors, unexpected behavior]

## Recommendation
- [ ] Proceed to live deployment
- [ ] Revise parameters (specify)
- [ ] Extend paper trade period
- [ ] Retire strategy

## Approval Status
- [ ] QA approved
- [ ] CEO approved
```

## Deployment Runbook Template

```markdown
# Deploy Runbook: [Strategy Name]

## Strategy Reference
`strategies/<slug>/`

## Target Environment
- Exchange:
- API key reference: (env var name, never the key itself)
- Asset:
- Timeframe:
- Bot process: (service name or screen session)

## Pre-Deploy Checklist
- [ ] Backtest report approved
- [ ] Paper trade report approved
- [ ] Risk ADR signed off
- [ ] API keys configured in secrets manager
- [ ] Circuit breakers configured
- [ ] Alert channels configured (Telegram/Discord webhook)
- [ ] Monitoring dashboard live

## Deploy Steps
1. Pull latest strategy code
2. Set env vars (see `.env.example`)
3. Run `npm run deploy:<slug>` or `python bots/<slug>-bot/main.py`
4. Confirm first order logged within 60 seconds of market open
5. Verify PnL tracking updates in Supabase

## Rollback Steps
1. `npm run halt:<slug>` or kill bot process
2. Cancel all open orders via exchange dashboard
3. Log incident in `.ai-office/docs/runbooks/<slug>-status.md`

## Monitoring Targets
| Metric | Alert Threshold |
|--------|----------------|
| Daily PnL | < -X% |
| Consecutive losses | > N |
| Fill latency | > Xms |
| Bot process uptime | < 99% |

## Version
[Git tag or commit SHA deployed]
```

## Performance Review Template

```markdown
# Performance Review: [Strategy Name]

## Review Period
YYYY-MM-DD to YYYY-MM-DD

## Summary

| Metric | This Period | Previous Period | Delta |
|--------|------------|----------------|-------|
| Total Return | % | % | |
| Sharpe Ratio | | | |
| Max Drawdown | % | % | |
| Win Rate | % | % | |
| Total Trades | | | |
| Avg Trade Duration | | | |

## Notable Events
[Significant wins, losses, market regime shifts, incidents]

## Circuit Breaker Activity
[Halts triggered, root causes, resolutions]

## Recommendation
- [ ] Continue as-is
- [ ] Parameter adjustment (specify)
- [ ] Retrain / re-backtest
- [ ] Retire strategy

## Owner
Ops

## Approved by
CEO
```

---

Updated: 2026-03-20

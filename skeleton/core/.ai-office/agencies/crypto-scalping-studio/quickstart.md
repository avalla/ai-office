---
agency: crypto-scalping-studio
---

# Crypto Scalping Studio — Quickstart

## Setup

```bash
./install.sh ~/my-trading-project
./setup.sh ~/my-trading-project
```

Select **Crypto Scalping Studio** during setup, or specify it directly:

```bash
/office-setup agency:crypto-scalping-studio
```

---

## Worked Example: BTC/USDT 5m Scalping Strategy

This walks through a complete strategy from brief to live deployment.

### Step 1 — Route the Request

```
/office-route Design a BTC/USDT 5-minute scalping strategy using EMA crossover and RSI confirmation
```

Router classifies the request, runs the discussion phase, and suggests the standard pipeline starting at `10_signal_brief`.

---

### Step 2 — Capture the Signal Brief (PM)

PM captures the brief. Example output at `docs/brief/btc-ema-rsi-brief.md`:

```markdown
# Brief: BTC/USDT EMA-RSI Scalp

## Asset: BTC/USDT Perpetual (Bybit)
## Timeframe: 5m
## Entry: EMA 9 crosses above EMA 21 + RSI(14) > 50
## Exit TP: +0.4% | SL: -0.2% | Trailing: none
## Risk: 1% capital per trade | Max drawdown: 10%
## Paper trade: ≥ 7 days
## Live target: 2026-04-01
```

```
/office-advance btc-ema-rsi brief "Brief captured and approved"
```

---

### Step 3 — Set Risk Parameters (Architect / Risk Manager)

```
/office-scaffold btc-ema-rsi adr
```

Architect produces `docs/adr/btc-ema-rsi-risk.md` with:
- Position size: 1% of capital
- Max daily loss: 3%
- Circuit breakers: halt after 5 consecutive losses or >5% drawdown in 24h
- Leverage: 1× (spot equivalent)

```
/office-advance btc-ema-rsi adr "Risk parameters approved"
```

---

### Step 4 — Design the Signal (Signal Analyst)

Signal Analyst takes the brief and produces a full signal spec:

```
/office-scaffold btc-ema-rsi signal_design
```

Output at `docs/brief/btc-ema-rsi-signal-spec.md`:
- **Regime filter**: ADX > 20 (only trade in trending regime)
- **Entry**: EMA(9) crosses EMA(21) on the 5m close + RSI(14) > 52 (long) or < 48 (short)
- **Session filter**: London open + NY session only (08:00–17:00 UTC)
- **Funding rate filter**: Skip entry if |funding rate| > 0.03% (avoid high-funding periods)
- **Parameter ranges for backtest**: EMA fast 7–11, EMA slow 18–25, RSI period 12–16

```
/office-advance btc-ema-rsi signal_design "Signal spec reviewed and approved"
```

---

### Step 5 — Implement & Backtest (Developer + QA)

Developer implements the strategy in Python using CCXT:

```
/office-scaffold btc-ema-rsi implementation
/office-advance btc-ema-rsi implementation "Strategy coded and unit-tested"
```

QA runs the backtest on 6-month OHLCV data with walk-forward validation:

```
/office-run-tests btc-ema-rsi
```

QA backtest report (`docs/runbooks/btc-ema-rsi-backtest.md`) must show:

| Metric | Result | Threshold | Pass? |
|--------|--------|-----------|-------|
| Sharpe Ratio | 1.82 | ≥ 1.5 | ✅ |
| Max Drawdown | 8.4% | ≤ 15% | ✅ |
| Win Rate | 54.1% | ≥ 52% | ✅ |
| OOS Sharpe (walk-forward) | 1.61 | ≥ 1.0 | ✅ |

```
/office-verify btc-ema-rsi backtest
/office-advance btc-ema-rsi backtest "Backtest accepted — all thresholds met"
```

---

### Step 6 — Strategy Review (Reviewer)

Reviewer checks for overfitting, parameter cliff-edges, and logic errors:

```
/office-review btc-ema-rsi
/office-advance btc-ema-rsi review "Strategy reviewed — no overfitting detected"
```

---

### Step 7 — Paper Trade (QA)

QA runs the bot in paper-trade mode for ≥ 7 days on live feed:

```
/office-scaffold btc-ema-rsi paper_trade
```

After 7+ days, QA produces `docs/runbooks/btc-ema-rsi-paper.md`. Acceptable degradation vs backtest: ≤ 20% Sharpe drop.

```
/office-verify btc-ema-rsi paper_trade
/office-advance btc-ema-rsi paper_trade "Paper trade approved — 7 days, within tolerance"
```

---

### Step 8 — Deploy Live (Release Manager)

Release Manager packages the deployment runbook and authorises go-live:

```
/office-scaffold btc-ema-rsi deploy
/office-advance btc-ema-rsi deploy "Live deployment authorised by CEO + Release Manager"
```

Deployment checklist in `docs/runbooks/btc-ema-rsi-deploy.md`:
- [ ] API keys in secrets manager (never committed)
- [ ] Circuit breakers configured
- [ ] Telegram/Discord alert webhook set
- [ ] Supabase PnL tracking live
- [ ] First order logged within 60s of market open

---

### Step 9 — Monitor (Ops)

Ops monitors live performance weekly and produces `docs/runbooks/btc-ema-rsi-status.md`:

```
/office-report btc-ema-rsi velocity
/office-status btc-ema-rsi
```

If Sharpe drops below 1.0 over a 2-week rolling window: Ops triggers the **Underperformance Recovery Pipeline** → Signal Analyst diagnoses regime shift → Scalping Engineer tunes parameters → backtest again.

If drawdown > circuit breaker threshold: Ops triggers **Emergency Halt Pipeline** → all orders cancelled → CEO notified immediately.

---

## Common Commands Reference

| Command | When to use |
|---------|-------------|
| `/office-route <request>` | Start any new strategy or feature |
| `/office-advance <slug> <stage> "<note>"` | Move to next pipeline stage |
| `/office-verify <slug> <stage>` | QA verification before advancing |
| `/office-scaffold <slug> <stage>` | Generate stage artifact template |
| `/office-run-tests <slug>` | Execute backtest and parse results |
| `/office-report <slug> velocity` | Weekly PnL and throughput metrics |
| `/office-task-list` | View current kanban across all strategies |
| `/office-status <slug>` | Get current pipeline state for a strategy |

---

Updated: 2026-03-20

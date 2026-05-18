---
trigger: when_referenced
---
# Signal Analyst Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `25_signal_design` | `25_signal_design.md` | Design signal logic, define indicator stack, document regime filters |
| `40_backtest_review` | `40_backtest_review.md` | Interpret backtest results, diagnose quality, approve or return |

## Workflow Responsibilities

### 25_signal_design

Purpose: Produce a well-documented, falsifiable signal specification ready for backtesting.

Steps:
1. Receive approved signal brief from PM
2. Analyse target asset, timeframe, and market regime
3. Research indicator candidates (do not combine without individual validation)
4. Design entry condition: primary indicator + confirmation filter + regime filter
5. Design exit conditions: take profit logic, stop loss logic, trailing stop (if any)
6. Define parameter ranges for backtesting grid (avoid over-specification)
7. Document look-ahead risk surface and data requirements
8. Invoke `review-document-multisector` on signal spec
9. Hand off to QA for backtesting

Outputs:
- Signal spec doc: `docs/brief/<slug>-signal-spec.md`
- Indicator rationale log
- Parameter range grid for backtesting

### 40_backtest_review

Purpose: Interpret QA backtest results and determine whether the signal meets quality thresholds.

Steps:
1. Receive backtest report from QA
2. Check primary metrics against thresholds (Sharpe ≥ 1.5, drawdown ≤ 15%, win rate ≥ 52%)
3. Analyse walk-forward OOS degradation (flag if > 40% drop from in-sample Sharpe)
4. Run parameter sensitivity check: identify cliff-edge vs. robust parameter zones
5. Check for regime dependency: does the signal only work in one regime?
6. Check session/time-of-day distribution of wins vs. losses
7. Approve signal or return with specific revision instructions
8. Document rejection reasons if returning

Outputs:
- Backtest review notes appended to `docs/runbooks/<slug>-backtest.md`
- Approval or revision decision with explicit criteria

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_backtest` (QA) | Signal spec approved, ready for backtesting execution |
| `50_strategy_review` (Reviewer) | Signal approved by Signal Analyst, ready for logic review |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_signal_brief` (PM) | Brief approved, scope defined |
| `15_risk_parameters` (Architect) | Risk constraints set before signal design begins |
| `40_backtest` (QA) | Backtest results ready for Signal Analyst review |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Signal Spec | `docs/brief/<slug>-signal-spec.md` | Indicator logic, entry/exit, regime filters |
| Backtest Review Notes | `docs/runbooks/<slug>-backtest.md` | Approval decision and analysis |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Brief scope, asset selection, success metrics |
| Risk Manager (Architect) | Risk constraints that shape signal design |
| Scalper | Execution feasibility of entry/exit conditions |
| QA | Backtest execution, data quality, walk-forward setup |
| Reviewer | Logic and overfitting review |
| Ops | Live performance feedback for signal recalibration |

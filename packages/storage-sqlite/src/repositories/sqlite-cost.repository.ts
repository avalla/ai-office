import type { Database } from "bun:sqlite";
import type {
  AuthorizeReservationInput,
  CostRepository,
  RecordUsageAndCostInput,
} from "@ai-office/application/ports/cost-repository.port.ts";
import {
  BudgetExceededError,
  BudgetNotFoundError,
  DuplicateProviderUsageError,
  MonetaryOverflowError,
  PricingOverlapError,
  ReservationExpiredError,
} from "@ai-office/application/cost-errors.ts";
import type {
  BudgetReservation,
  BudgetScopeType,
  BudgetSnapshot,
  CostAmount,
  Currency,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";

interface PricingRow {
  id: string;
  provider: string;
  model: string;
  currency: Currency;
  input_per_million_micros: number;
  cached_input_per_million_micros: number;
  output_per_million_micros: number;
  reasoning_per_million_micros: number;
  effective_from: string;
  effective_to: string | null;
}
interface BudgetRow {
  id: string;
  project_id: string;
  scope_type: BudgetScopeType;
  scope_id: string;
  currency: Currency;
  limit_micros: number;
}
interface ReservationRow {
  id: string;
  budget_id: string;
  amount_micros: number;
  status: "active" | "consumed" | "released";
  expires_at: string;
}
const safe = (value: bigint): number => {
  const number = Number(value);
  if (value < 0n || !Number.isSafeInteger(number))
    throw new MonetaryOverflowError();
  return number;
};
const restoredInteger = (value: number): bigint => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new MonetaryOverflowError();
  return BigInt(value);
};
const safeCount = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new MonetaryOverflowError();
  return value;
};
const restorePricing = (r: PricingRow): PricingVersion => ({
  id: r.id,
  provider: r.provider,
  model: r.model,
  currency: r.currency,
  inputPerMillionMicros: restoredInteger(r.input_per_million_micros),
  cachedInputPerMillionMicros: restoredInteger(
    r.cached_input_per_million_micros,
  ),
  outputPerMillionMicros: restoredInteger(r.output_per_million_micros),
  reasoningPerMillionMicros: restoredInteger(r.reasoning_per_million_micros),
  effectiveFrom: new Date(r.effective_from),
  ...(r.effective_to === null ? {} : { effectiveTo: new Date(r.effective_to) }),
});

export class SqliteCostRepository implements CostRepository {
  constructor(private readonly database: Database) {}
  private immediate<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  async savePricing(v: PricingVersion, createdAt: Date): Promise<void> {
    if (
      v.effectiveTo !== undefined &&
      v.effectiveTo.getTime() <= v.effectiveFrom.getTime()
    )
      throw new PricingOverlapError(v.provider, v.model);
    try {
      this.immediate(() => {
        if (
          this.database
            .query<{ id: string }, [string]>(
              "SELECT id FROM pricing_version WHERE id=?",
            )
            .get(v.id) !== null
        )
          return;
        this.database
          .prepare(
            "UPDATE pricing_version SET effective_to=? WHERE provider=? AND model=? AND currency=? AND effective_to IS NULL AND effective_from < ?",
          )
          .run(
            v.effectiveFrom.toISOString(),
            v.provider,
            v.model,
            v.currency,
            v.effectiveFrom.toISOString(),
          );
        this.database
          .prepare(
            `INSERT INTO pricing_version(id,provider,model,currency,input_per_million_micros,cached_input_per_million_micros,output_per_million_micros,reasoning_per_million_micros,effective_from,effective_to,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            v.id,
            v.provider,
            v.model,
            v.currency,
            safe(v.inputPerMillionMicros),
            safe(v.cachedInputPerMillionMicros),
            safe(v.outputPerMillionMicros),
            safe(v.reasoningPerMillionMicros),
            v.effectiveFrom.toISOString(),
            v.effectiveTo?.toISOString() ?? null,
            createdAt.toISOString(),
          );
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("pricing interval overlaps")
      )
        throw new PricingOverlapError(v.provider, v.model);
      throw error;
    }
  }
  async saveBudget(
    v: Omit<BudgetSnapshot, "spentMicros" | "reservedMicros">,
    now: Date,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO budget(id,project_id,scope_type,scope_id,currency,limit_micros,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id,scope_type,scope_id,currency) DO UPDATE SET limit_micros=excluded.limit_micros,updated_at=excluded.updated_at`,
      )
      .run(
        v.id,
        v.projectId,
        v.scopeType,
        v.scopeId,
        v.currency,
        safe(v.limitMicros),
        now.toISOString(),
        now.toISOString(),
      );
  }
  async findPricing(
    provider: string,
    model: string,
    at: Date,
  ): Promise<PricingVersion | null> {
    const row = this.database
      .query<PricingRow, [string, string, string, string]>(
        `SELECT id,provider,model,currency,input_per_million_micros,cached_input_per_million_micros,output_per_million_micros,reasoning_per_million_micros,effective_from,effective_to FROM pricing_version WHERE provider=? AND model=? AND effective_from<=? AND(effective_to IS NULL OR effective_to>?) ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(provider, model, at.toISOString(), at.toISOString());
    return row === null ? null : restorePricing(row);
  }
  private spentMicros(budget: BudgetRow): bigint {
    const column =
      budget.scope_type === "task"
        ? "u.task_id"
        : budget.scope_type === "agent"
          ? "u.agent_id"
          : budget.scope_type === "agent_run"
            ? "u.agent_run_id"
            : null;
    const sql =
      column === null
        ? `SELECT COALESCE(SUM(c.actual_micros),0) value FROM cost_event c WHERE c.project_id=? AND c.currency=?`
        : `SELECT COALESCE(SUM(c.actual_micros),0) value FROM cost_event c JOIN model_usage u ON u.id=c.usage_id WHERE c.project_id=? AND c.currency=? AND ${column}=?`;
    const row =
      column === null
        ? this.database
            .query<{ value: number }, [string, string]>(sql)
            .get(budget.project_id, budget.currency)
        : this.database
            .query<{ value: number }, [string, string, string]>(sql)
            .get(budget.project_id, budget.currency, budget.scope_id);
    return restoredInteger(row?.value ?? 0);
  }
  private reservedMicros(budgetId: string, now: Date): bigint {
    return restoredInteger(
      this.database
        .query<{ value: number }, [string, string]>(
          "SELECT COALESCE(SUM(amount_micros),0) value FROM budget_reservation WHERE budget_id=? AND status='active' AND expires_at>?",
        )
        .get(budgetId, now.toISOString())?.value ?? 0,
    );
  }
  async findBudget(
    projectId: string,
    scopeType: BudgetScopeType,
    scopeId: string,
    currency: Currency,
    now: Date,
  ): Promise<BudgetSnapshot | null> {
    const row = this.database
      .query<BudgetRow, [string, string, string, string]>(
        "SELECT id,project_id,scope_type,scope_id,currency,limit_micros FROM budget WHERE project_id=? AND scope_type=? AND scope_id=? AND currency=?",
      )
      .get(projectId, scopeType, scopeId, currency);
    return row === null
      ? null
      : {
          id: row.id,
          projectId: row.project_id,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          currency: row.currency,
          limitMicros: restoredInteger(row.limit_micros),
          spentMicros: this.spentMicros(row),
          reservedMicros: this.reservedMicros(row.id, now),
        };
  }
  async listBudgetCurrencies(
    projectId: string,
    scopeType: BudgetScopeType,
    scopeId: string,
  ): Promise<Currency[]> {
    return this.database
      .query<{ currency: Currency }, [string, string, string]>(
        `SELECT currency FROM budget
         WHERE project_id=? AND scope_type=? AND scope_id=?
         ORDER BY currency`,
      )
      .all(projectId, scopeType, scopeId)
      .map((row) => row.currency);
  }
  async authorizeAndReserve(
    v: AuthorizeReservationInput,
  ): Promise<BudgetReservation> {
    if (v.expiresAt.getTime() <= v.now.getTime())
      throw new ReservationExpiredError(v.id);
    return this.immediate(() => {
      const budget = this.database
        .query<BudgetRow, [string, string, string, string]>(
          "SELECT id,project_id,scope_type,scope_id,currency,limit_micros FROM budget WHERE project_id=? AND scope_type=? AND scope_id=? AND currency=?",
        )
        .get(v.projectId, v.scopeType, v.scopeId, v.currency);
      if (budget === null) throw new BudgetNotFoundError();
      const amount = safe(v.amountMicros);
      if (
        this.spentMicros(budget) +
          this.reservedMicros(budget.id, v.now) +
          v.amountMicros >
        restoredInteger(budget.limit_micros)
      )
        throw new BudgetExceededError();
      this.database
        .prepare(
          "INSERT INTO budget_reservation(id,budget_id,agent_run_id,amount_micros,status,created_at,expires_at) VALUES (?,?,?,?, 'active',?,?)",
        )
        .run(
          v.id,
          budget.id,
          v.agentRunId ?? null,
          amount,
          v.now.toISOString(),
          v.expiresAt.toISOString(),
        );
      return {
        id: v.id,
        budgetId: budget.id,
        reservedMicros: v.amountMicros,
        currency: v.currency,
        status: "active",
        expiresAt: v.expiresAt,
      };
    });
  }
  async releaseReservation(
    id: string,
    now: Date,
  ): Promise<"released" | "already_released" | "consumed"> {
    return this.immediate(() => {
      const row = this.database
        .query<{ status: "active" | "released" | "consumed" }, [string]>(
          "SELECT status FROM budget_reservation WHERE id=?",
        )
        .get(id);
      if (row === null) return "already_released";
      if (row.status === "consumed") return "consumed";
      if (row.status === "released") return "already_released";
      this.database
        .prepare(
          "UPDATE budget_reservation SET status='released',finalized_at=? WHERE id=? AND status='active'",
        )
        .run(now.toISOString(), id);
      return "released";
    });
  }
  async releaseExpiredReservations(now: Date): Promise<number> {
    return this.database
      .prepare(
        "UPDATE budget_reservation SET status='released',finalized_at=? WHERE status='active' AND expires_at<=?",
      )
      .run(now.toISOString(), now.toISOString()).changes;
  }
  async recordUsageAndCost(
    v: RecordUsageAndCostInput,
  ): Promise<"recorded" | "duplicate"> {
    try {
      return this.immediate(() => {
        if (
          this.database
            .query<{ id: string }, [string]>(
              "SELECT id FROM model_usage WHERE id=?",
            )
            .get(v.usageId) !== null
        )
          return "duplicate";
        if (
          v.providerRequestId !== undefined &&
          this.database
            .query<{ id: string }, [string, string]>(
              "SELECT id FROM model_usage WHERE provider=? AND provider_request_id=?",
            )
            .get(v.provider, v.providerRequestId) !== null
        )
          return "duplicate";
        let reserved = 0n;
        if (v.reservationId !== undefined) {
          const reservation = this.database
            .query<ReservationRow, [string]>(
              "SELECT id,budget_id,amount_micros,status,expires_at FROM budget_reservation WHERE id=?",
            )
            .get(v.reservationId);
          if (
            reservation === null ||
            reservation.status === "released" ||
            reservation.expires_at <= v.occurredAt.toISOString()
          )
            throw new ReservationExpiredError(v.reservationId);
          if (reservation.status === "consumed") return "duplicate";
          reserved = restoredInteger(reservation.amount_micros);
        }
        const overage =
          v.reservationId !== undefined && v.actual.micros > reserved
            ? v.actual.micros - reserved
            : 0n;
        this.database
          .prepare(
            `INSERT INTO model_usage(id,project_id,task_id,agent_id,agent_run_id,provider,model,purpose,provider_request_id,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            v.usageId,
            v.context.projectId,
            v.context.taskId ?? null,
            v.context.agentId ?? null,
            v.context.agentRunId ?? null,
            v.provider,
            v.model,
            v.context.purpose,
            v.providerRequestId ?? null,
            safeCount(v.usage.inputTokens),
            safeCount(v.usage.cachedInputTokens),
            safeCount(v.usage.outputTokens),
            safeCount(v.usage.reasoningTokens),
            v.occurredAt.toISOString(),
          );
        this.database
          .prepare(
            `INSERT INTO cost_event(id,project_id,usage_id,pricing_version_id,reservation_id,estimated_micros,reserved_micros,actual_micros,overage_micros,currency,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            v.costEventId,
            v.context.projectId,
            v.usageId,
            v.pricingVersionId,
            v.reservationId ?? null,
            safe(v.estimated.micros),
            safe(reserved),
            safe(v.actual.micros),
            safe(overage),
            v.actual.currency,
            v.occurredAt.toISOString(),
          );
        if (v.reservationId !== undefined) {
          const result = this.database
            .prepare(
              "UPDATE budget_reservation SET status='consumed',finalized_at=? WHERE id=? AND status='active'",
            )
            .run(v.occurredAt.toISOString(), v.reservationId);
          if (result.changes !== 1)
            throw new ReservationExpiredError(v.reservationId);
        }
        return "recorded";
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("duplicate provider usage")
      )
        throw new DuplicateProviderUsageError(
          v.provider,
          v.providerRequestId ?? "unknown",
        );
      throw error;
    }
  }
  async aggregate(
    projectId: string,
    groupBy: "project" | "task" | "agent" | "agent_run" = "project",
  ) {
    const expression =
      groupBy === "task"
        ? "COALESCE(u.task_id,'unassigned')"
        : groupBy === "agent"
          ? "COALESCE(u.agent_id,'unassigned')"
          : groupBy === "agent_run"
            ? "COALESCE(u.agent_run_id,'unassigned')"
            : "c.project_id";
    return this.database
      .query<
        { dimension: string; actual_micros: number; currency: Currency },
        [string]
      >(
        `SELECT ${expression} dimension,SUM(c.actual_micros) actual_micros,c.currency FROM cost_event c JOIN model_usage u ON u.id=c.usage_id WHERE c.project_id=? GROUP BY dimension,c.currency ORDER BY dimension,c.currency`,
      )
      .all(projectId)
      .map((row) => ({
        dimension: row.dimension,
        actualMicros: restoredInteger(row.actual_micros),
        currency: row.currency,
      }));
  }
}

import type { Database } from "bun:sqlite";
import type { CostRepository } from "@ai-office/application/ports/cost-repository.port.ts";
import type {
  BudgetSnapshot,
  CostAmount,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";

interface PricingRow {
  id: string;
  provider: string;
  model: string;
  currency: CostAmount["currency"];
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
  scope_type: BudgetSnapshot["scopeType"];
  scope_id: string;
  currency: CostAmount["currency"];
  limit_micros: number;
  spent_micros: number;
  reserved_micros: number;
}
const safe = (value: bigint): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError("SQLite cost values must fit in a safe integer");
  return n;
};

export class SqliteCostRepository implements CostRepository {
  constructor(private readonly database: Database) {}
  async savePricing(v: PricingVersion, createdAt: Date): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO pricing_version(id, provider, model, currency, input_per_million_micros, cached_input_per_million_micros, output_per_million_micros, reasoning_per_million_micros, effective_from, effective_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model, effective_from) DO UPDATE SET currency=excluded.currency, input_per_million_micros=excluded.input_per_million_micros, cached_input_per_million_micros=excluded.cached_input_per_million_micros, output_per_million_micros=excluded.output_per_million_micros, reasoning_per_million_micros=excluded.reasoning_per_million_micros, effective_to=excluded.effective_to`,
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
  }
  async saveBudget(
    v: Omit<BudgetSnapshot, "spentMicros" | "reservedMicros">,
    now: Date,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO budget(id, project_id, scope_type, scope_id, currency, limit_micros, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, scope_type, scope_id, currency) DO UPDATE SET limit_micros=excluded.limit_micros, updated_at=excluded.updated_at`,
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
    const r = this.database
      .query<PricingRow, [string, string, string, string]>(
        `SELECT id, provider, model, currency, input_per_million_micros, cached_input_per_million_micros, output_per_million_micros, reasoning_per_million_micros, effective_from, effective_to FROM pricing_version WHERE provider=? AND model=? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(provider, model, at.toISOString(), at.toISOString());
    return r === null
      ? null
      : {
          id: r.id,
          provider: r.provider,
          model: r.model,
          currency: r.currency,
          inputPerMillionMicros: BigInt(r.input_per_million_micros),
          cachedInputPerMillionMicros: BigInt(
            r.cached_input_per_million_micros,
          ),
          outputPerMillionMicros: BigInt(r.output_per_million_micros),
          reasoningPerMillionMicros: BigInt(r.reasoning_per_million_micros),
          effectiveFrom: new Date(r.effective_from),
          ...(r.effective_to === null
            ? {}
            : { effectiveTo: new Date(r.effective_to) }),
        };
  }
  async findBudget(
    projectId: string,
    scopeType: BudgetSnapshot["scopeType"],
    scopeId: string,
    currency: CostAmount["currency"],
  ): Promise<BudgetSnapshot | null> {
    const r = this.database
      .query<BudgetRow, [string, string, string, string]>(
        `SELECT b.id,b.project_id,b.scope_type,b.scope_id,b.currency,b.limit_micros,COALESCE((SELECT SUM(c.actual_micros) FROM cost_event c WHERE c.project_id=b.project_id AND c.currency=b.currency),0) spent_micros,COALESCE((SELECT SUM(br.amount_micros) FROM budget_reservation br WHERE br.budget_id=b.id AND br.status='active'),0) reserved_micros FROM budget b WHERE b.project_id=? AND b.scope_type=? AND b.scope_id=? AND b.currency=?`,
      )
      .get(projectId, scopeType, scopeId, currency);
    return r === null
      ? null
      : {
          id: r.id,
          projectId: r.project_id,
          scopeType: r.scope_type,
          scopeId: r.scope_id,
          currency: r.currency,
          limitMicros: BigInt(r.limit_micros),
          spentMicros: BigInt(r.spent_micros),
          reservedMicros: BigInt(r.reserved_micros),
        };
  }
  async reserve(v: {
    id: string;
    budgetId: string;
    agentRunId?: string;
    amountMicros: bigint;
    now: Date;
  }): Promise<void> {
    this.database
      .prepare(
        "INSERT INTO budget_reservation(id,budget_id,agent_run_id,amount_micros,status,created_at) VALUES (?,?,?,?, 'active',?)",
      )
      .run(
        v.id,
        v.budgetId,
        v.agentRunId ?? null,
        safe(v.amountMicros),
        v.now.toISOString(),
      );
  }
  async releaseReservation(id: string, now: Date): Promise<void> {
    this.database
      .prepare(
        "UPDATE budget_reservation SET status='released', finalized_at=? WHERE id=? AND status='active'",
      )
      .run(now.toISOString(), id);
  }
  async recordUsageAndCost(
    v: Parameters<CostRepository["recordUsageAndCost"]>[0],
  ): Promise<void> {
    this.database.transaction(() => {
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
          v.usage.inputTokens,
          v.usage.cachedInputTokens,
          v.usage.outputTokens,
          v.usage.reasoningTokens,
          v.occurredAt.toISOString(),
        );
      this.database
        .prepare(
          `INSERT INTO cost_event(id,project_id,usage_id,pricing_version_id,reservation_id,estimated_micros,actual_micros,currency,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          v.costEventId,
          v.context.projectId,
          v.usageId,
          v.pricingVersionId,
          v.reservationId ?? null,
          safe(v.estimated.micros),
          safe(v.actual.micros),
          v.actual.currency,
          v.occurredAt.toISOString(),
        );
      if (v.reservationId !== undefined)
        this.database
          .prepare(
            "UPDATE budget_reservation SET status='consumed', finalized_at=? WHERE id=? AND status='active'",
          )
          .run(v.occurredAt.toISOString(), v.reservationId);
    })();
  }
  async aggregate(
    projectId: string,
    groupBy: "project" | "task" | "agent" = "project",
  ): Promise<
    Array<{
      dimension: string;
      actualMicros: bigint;
      currency: CostAmount["currency"];
    }>
  > {
    const expression =
      groupBy === "task"
        ? "COALESCE(u.task_id, 'unassigned')"
        : groupBy === "agent"
          ? "COALESCE(u.agent_id, 'unassigned')"
          : "c.project_id";
    return this.database
      .query<
        {
          dimension: string;
          actual_micros: number;
          currency: CostAmount["currency"];
        },
        [string]
      >(
        `SELECT ${expression} dimension,SUM(c.actual_micros) actual_micros,c.currency FROM cost_event c JOIN model_usage u ON u.id=c.usage_id WHERE c.project_id=? GROUP BY dimension,c.currency ORDER BY dimension,c.currency`,
      )
      .all(projectId)
      .map((r) => ({
        dimension: r.dimension,
        actualMicros: BigInt(r.actual_micros),
        currency: r.currency,
      }));
  }
}

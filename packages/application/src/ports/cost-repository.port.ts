import type {
  BudgetReservation,
  BudgetScopeType,
  BudgetSnapshot,
  CostAmount,
  Currency,
  ModelUsage,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";

export interface UsageContext {
  projectId: string;
  taskId?: string;
  agentId?: string;
  agentRunId?: string;
  purpose: string;
}
export interface AuthorizeReservationInput {
  id: string;
  projectId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  currency: Currency;
  amountMicros: bigint;
  agentRunId?: string;
  now: Date;
  expiresAt: Date;
}
export interface RecordUsageAndCostInput {
  usageId: string;
  costEventId: string;
  context: UsageContext;
  provider: string;
  model: string;
  providerRequestId?: string;
  usage: ModelUsage;
  pricingVersionId: string;
  reservationId?: string;
  estimated: CostAmount;
  actual: CostAmount;
  occurredAt: Date;
}

export interface CostRepository {
  savePricing(pricing: PricingVersion, createdAt: Date): Promise<void>;
  saveBudget(
    budget: Omit<BudgetSnapshot, "spentMicros" | "reservedMicros">,
    now: Date,
  ): Promise<void>;
  findPricing(
    provider: string,
    model: string,
    at: Date,
  ): Promise<PricingVersion | null>;
  findBudget(
    projectId: string,
    scopeType: BudgetScopeType,
    scopeId: string,
    currency: Currency,
    now: Date,
  ): Promise<BudgetSnapshot | null>;
  authorizeAndReserve(
    input: AuthorizeReservationInput,
  ): Promise<BudgetReservation>;
  releaseReservation(
    id: string,
    now: Date,
  ): Promise<"released" | "already_released" | "consumed">;
  releaseExpiredReservations(now: Date): Promise<number>;
  recordUsageAndCost(
    input: RecordUsageAndCostInput,
  ): Promise<"recorded" | "duplicate">;
  aggregate(
    projectId: string,
    groupBy?: "project" | "task" | "agent" | "agent_run",
  ): Promise<
    Array<{ dimension: string; actualMicros: bigint; currency: Currency }>
  >;
}

import type {
  BudgetSnapshot,
  CostAmount,
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
    scopeType: BudgetSnapshot["scopeType"],
    scopeId: string,
    currency: CostAmount["currency"],
  ): Promise<BudgetSnapshot | null>;
  reserve(input: {
    id: string;
    budgetId: string;
    agentRunId?: string;
    amountMicros: bigint;
    now: Date;
  }): Promise<void>;
  releaseReservation(id: string, now: Date): Promise<void>;
  recordUsageAndCost(input: {
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
  }): Promise<void>;
  aggregate(
    projectId: string,
    groupBy?: "project" | "task" | "agent",
  ): Promise<
    Array<{
      dimension: string;
      actualMicros: bigint;
      currency: CostAmount["currency"];
    }>
  >;
}

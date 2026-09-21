import type {
  BudgetReservation,
  BudgetScopeType,
  BudgetSnapshot,
  CostAmount,
  CostChargeBasis,
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
  /** The primary reservation retained on cost_event for compatibility. */
  reservationId?: string;
  /** All co-reservations finalized with this usage record. */
  reservationIds?: readonly string[];
  estimated: CostAmount;
  actual: CostAmount;
  /** Defaults to `reported_usage`. */
  chargeBasis?: CostChargeBasis;
  occurredAt: Date;
}

export interface AuthorizeAndReserveManyInput {
  reservations: readonly AuthorizeReservationInput[];
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
  listBudgetCurrencies(
    projectId: string,
    scopeType: BudgetScopeType,
    scopeId: string,
  ): Promise<Currency[]>;
  authorizeAndReserve(
    input: AuthorizeReservationInput,
  ): Promise<BudgetReservation>;
  /** Atomic across all supplied budgets when implemented by the storage adapter. */
  authorizeAndReserveMany?: (
    input: AuthorizeAndReserveManyInput,
  ) => Promise<readonly BudgetReservation[]>;
  releaseReservation(
    id: string,
    now: Date,
  ): Promise<"released" | "already_released" | "consumed">;
  /** Releases all supplied reservations atomically when supported. */
  releaseReservations?: (ids: readonly string[], now: Date) => Promise<void>;
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

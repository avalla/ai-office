import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type {
  CostRepository,
  UsageContext,
} from "@ai-office/application/ports/cost-repository.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type {
  BudgetScopeType,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";
import {
  BudgetNotFoundError,
  PricingCurrencyMismatchError,
  PricingNotFoundError,
} from "@ai-office/application/cost-errors.ts";
import { calculateCost } from "./cost-calculator.ts";
import {
  validateModelResponse,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

const price = (pricing: PricingVersion) => ({
  currency: pricing.currency,
  inputPerMillionMicros: pricing.inputPerMillionMicros,
  cachedInputPerMillionMicros: pricing.cachedInputPerMillionMicros,
  outputPerMillionMicros: pricing.outputPerMillionMicros,
  reasoningPerMillionMicros: pricing.reasoningPerMillionMicros,
});
export interface MeteredRequestContext extends UsageContext {
  estimatedUsage: ModelResponse["usage"];
  budgetScopeType?: BudgetScopeType;
  budgetScopeId?: string;
  reservationTtlMs?: number;
}

export class MeteredLlmGateway {
  constructor(
    private readonly provider: LlmProvider,
    private readonly costs: CostRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}
  async complete(
    request: ModelRequest,
    context: MeteredRequestContext,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const now = this.clock.now();
    const candidates = this.provider
      .pricingCandidates(request)
      .filter(
        (value, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.providerId === value.providerId &&
              candidate.model === value.model,
          ) === index,
      );
    const pricingByCandidate = new Map<string, PricingVersion>();
    for (const candidate of candidates) {
      const pricing = await this.costs.findPricing(
        candidate.providerId,
        candidate.model,
        now,
      );
      if (pricing === null)
        throw new PricingNotFoundError(candidate.providerId, candidate.model);
      pricingByCandidate.set(
        `${candidate.providerId}\0${candidate.model}`,
        pricing,
      );
    }
    if (pricingByCandidate.size === 0)
      throw new PricingNotFoundError(this.provider.id, request.model);
    const prices = [...pricingByCandidate.values()];
    const currency = prices[0]!.currency;
    if (prices.some((value) => value.currency !== currency))
      throw new PricingCurrencyMismatchError();
    const estimates = prices.map(
      (value) => calculateCost(context.estimatedUsage, price(value)).micros,
    );
    const reservedMicros = estimates.reduce(
      (maximum, value) => (value > maximum ? value : maximum),
      0n,
    );
    const hasScope =
      context.budgetScopeType !== undefined ||
      context.budgetScopeId !== undefined;
    if (
      hasScope &&
      (context.budgetScopeType === undefined ||
        context.budgetScopeId === undefined)
    )
      throw new BudgetNotFoundError();
    let reservationId: string | undefined;
    if (
      context.budgetScopeType !== undefined &&
      context.budgetScopeId !== undefined
    ) {
      reservationId = this.ids.generate();
      const ttl = context.reservationTtlMs ?? 15 * 60_000;
      await this.costs.authorizeAndReserve({
        id: reservationId,
        projectId: context.projectId,
        scopeType: context.budgetScopeType,
        scopeId: context.budgetScopeId,
        currency,
        amountMicros: reservedMicros,
        ...(context.agentRunId === undefined
          ? {}
          : { agentRunId: context.agentRunId }),
        now,
        expiresAt: new Date(now.getTime() + ttl),
      });
    }
    try {
      const response = await this.provider.complete(request, signal);
      validateModelResponse(response, this.provider.id);
      const pricing = pricingByCandidate.get(
        `${response.providerId}\0${response.model}`,
      );
      if (pricing === undefined)
        throw new PricingNotFoundError(response.providerId, response.model);
      const actual = calculateCost(response.usage, price(pricing));
      const estimated = calculateCost(context.estimatedUsage, price(pricing));
      const recording = await this.costs.recordUsageAndCost({
        usageId: this.ids.generate(),
        costEventId: this.ids.generate(),
        context,
        provider: response.providerId,
        model: response.model,
        ...(response.providerRequestId === undefined
          ? {}
          : { providerRequestId: response.providerRequestId }),
        usage: response.usage,
        pricingVersionId: pricing.id,
        ...(reservationId === undefined ? {} : { reservationId }),
        estimated,
        actual,
        occurredAt: this.clock.now(),
      });
      if (recording === "duplicate" && reservationId !== undefined)
        await this.costs.releaseReservation(reservationId, this.clock.now());
      return response;
    } catch (error) {
      if (reservationId !== undefined)
        await this.costs.releaseReservation(reservationId, this.clock.now());
      throw error;
    }
  }
}

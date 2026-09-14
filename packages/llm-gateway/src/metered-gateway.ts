import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type {
  CostRepository,
  UsageContext,
} from "@ai-office/application/ports/cost-repository.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type {
  BudgetScopeType,
  Currency,
  ModelUsage,
  ModelUsageBound,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";
import {
  BudgetNotFoundError,
  PricingCurrencyMismatchError,
  PricingNotFoundError,
} from "@ai-office/application/cost-errors.ts";
import { calculateCost, calculateMaximumCost } from "./cost-calculator.ts";
import {
  rejectedProviderResponse,
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
  /**
   * Upper bounds on the request's input and output totals. The reservation is
   * the highest cost any valid usage within them can have.
   */
  usageBound: ModelUsageBound;
  budgetScopeType?: BudgetScopeType;
  budgetScopeId?: string;
  reservationTtlMs?: number;
  useProjectBudgetIfConfigured?: boolean;
}

/** The accounting the gateway itself recorded for one completed request. */
export interface GatewayMetering {
  currency: Currency;
  pricingVersionId: string;
  reservedMicros: bigint | null;
  estimatedMicros: bigint;
  actualMicros: bigint;
  budgetScopeType: BudgetScopeType | null;
  budgetScopeId: string | null;
  recording: "recorded" | "duplicate";
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
    return (await this.completeMetered(request, context, signal)).response;
  }

  /** `complete`, also returning the cost evidence recorded for the response. */
  async completeMetered(
    request: ModelRequest,
    context: MeteredRequestContext,
    signal?: AbortSignal,
  ): Promise<{ response: ModelResponse; metering: GatewayMetering }> {
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
    // The dearest candidate's worst case; also the charge when a response is
    // received but rejected before its usage can be priced.
    let envelope = {
      pricing: prices[0]!,
      micros: calculateMaximumCost(context.usageBound, price(prices[0]!))
        .micros,
    };
    for (const pricing of prices.slice(1)) {
      const micros = calculateMaximumCost(
        context.usageBound,
        price(pricing),
      ).micros;
      if (micros > envelope.micros) envelope = { pricing, micros };
    }
    const reservedMicros = envelope.micros;
    const hasScope =
      context.budgetScopeType !== undefined ||
      context.budgetScopeId !== undefined;
    if (
      hasScope &&
      (context.budgetScopeType === undefined ||
        context.budgetScopeId === undefined)
    )
      throw new BudgetNotFoundError();
    let budgetScopeType = context.budgetScopeType;
    let budgetScopeId = context.budgetScopeId;
    if (
      budgetScopeType === undefined &&
      budgetScopeId === undefined &&
      context.useProjectBudgetIfConfigured === true
    ) {
      const projectBudgetCurrencies = await this.costs.listBudgetCurrencies(
        context.projectId,
        "project",
        context.projectId,
      );
      if (
        projectBudgetCurrencies.length > 0 &&
        !projectBudgetCurrencies.some((value) => value === currency)
      ) {
        throw new PricingCurrencyMismatchError();
      }
      if (projectBudgetCurrencies.some((value) => value === currency)) {
        budgetScopeType = "project";
        budgetScopeId = context.projectId;
      }
    }
    let reservationId: string | undefined;
    if (budgetScopeType !== undefined && budgetScopeId !== undefined) {
      reservationId = this.ids.generate();
      const ttl = context.reservationTtlMs ?? 15 * 60_000;
      await this.costs.authorizeAndReserve({
        id: reservationId,
        projectId: context.projectId,
        scopeType: budgetScopeType,
        scopeId: budgetScopeId,
        currency,
        amountMicros: reservedMicros,
        ...(context.agentRunId === undefined
          ? {}
          : { agentRunId: context.agentRunId }),
        now,
        expiresAt: new Date(now.getTime() + ttl),
      });
    }
    let received: { response: ModelResponse | null } | undefined;
    try {
      let response: ModelResponse;
      try {
        response = await this.provider.complete(request, signal);
      } catch (error) {
        received = rejectedProviderResponse(error);
        throw error;
      }
      received = { response };
      validateModelResponse(response, this.provider.id);
      const pricing = pricingByCandidate.get(
        `${response.providerId}\0${response.model}`,
      );
      if (pricing === undefined)
        throw new PricingNotFoundError(response.providerId, response.model);
      const actual = calculateCost(response.usage, price(pricing));
      const estimated = calculateMaximumCost(
        context.usageBound,
        price(pricing),
      );
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
        chargeBasis: "reported_usage",
        occurredAt: this.clock.now(),
      });
      received = undefined;
      if (recording === "duplicate" && reservationId !== undefined)
        await this.costs.releaseReservation(reservationId, this.clock.now());
      return {
        response,
        metering: {
          currency: actual.currency,
          pricingVersionId: pricing.id,
          reservedMicros: reservationId === undefined ? null : reservedMicros,
          estimatedMicros: estimated.micros,
          actualMicros: actual.micros,
          budgetScopeType: budgetScopeType ?? null,
          budgetScopeId: budgetScopeId ?? null,
          recording,
        },
      };
    } catch (error) {
      if (received === undefined) {
        // No answer was received: nothing is known to have been billed.
        if (reservationId !== undefined)
          await this.costs.releaseReservation(reservationId, this.clock.now());
        throw error;
      }
      // The vendor answered but the answer was rejected. Its work may have
      // been billed, so the reserved worst case is charged instead of being
      // released. If even that cannot be recorded, the reservation stays
      // active until expiry rather than restoring capacity now.
      try {
        await this.chargeRejectedResponse(
          received.response,
          request,
          context,
          envelope,
          currency,
          reservationId,
        );
      } catch {
        // The original failure is what the caller must see.
      }
      throw error;
    }
  }

  private async chargeRejectedResponse(
    response: ModelResponse | null,
    request: ModelRequest,
    context: MeteredRequestContext,
    envelope: { pricing: PricingVersion; micros: bigint },
    currency: Currency,
    reservationId: string | undefined,
  ): Promise<void> {
    // Only well-formed reported values are kept; anything else is recorded as
    // unknown (the configured identity and zero usage), never guessed.
    const text = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() !== "" ? value : undefined;
    let usage: ModelUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    if (response !== null) {
      try {
        validateModelResponse(response, this.provider.id);
        usage = response.usage;
      } catch {
        // Usage that failed validation is not recorded as if it were reported.
      }
    }
    const providerRequestId = text(response?.providerRequestId);
    const charge = { micros: envelope.micros, currency };
    const recording = await this.costs.recordUsageAndCost({
      usageId: this.ids.generate(),
      costEventId: this.ids.generate(),
      context,
      // The usage row keeps what actually answered, such as a substituted model.
      provider: text(response?.providerId) ?? this.provider.id,
      model: text(response?.model) ?? request.model,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      usage,
      pricingVersionId: envelope.pricing.id,
      ...(reservationId === undefined ? {} : { reservationId }),
      estimated: charge,
      actual: charge,
      chargeBasis: "reserved_envelope",
      occurredAt: this.clock.now(),
    });
    if (recording === "duplicate" && reservationId !== undefined)
      await this.costs.releaseReservation(reservationId, this.clock.now());
  }
}

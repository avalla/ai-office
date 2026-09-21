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
export interface BudgetScope {
  scopeType: BudgetScopeType;
  scopeId: string;
}

export interface MeteredRequestContext extends UsageContext {
  /**
   * Upper bounds on the request's input and output totals. The reservation is
   * the highest cost any valid usage within them can have.
   */
  usageBound: ModelUsageBound;
  budgetScopeType?: BudgetScopeType;
  budgetScopeId?: string;
  /** Configured scopes are co-reserved with one atomic storage operation. */
  budgetScopes?: readonly BudgetScope[];
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
    const scopes: BudgetScope[] = context.budgetScopes
      ? [...context.budgetScopes]
      : budgetScopeType !== undefined && budgetScopeId !== undefined
        ? [{ scopeType: budgetScopeType, scopeId: budgetScopeId }]
        : [];
    if (scopes.length === 0 && context.useProjectBudgetIfConfigured === true) {
      const projectBudgetCurrencies = await this.costs.listBudgetCurrencies(
        context.projectId,
        "project",
        context.projectId,
      );
      if (
        projectBudgetCurrencies.length > 0 &&
        !projectBudgetCurrencies.some((value) => value === currency)
      )
        throw new PricingCurrencyMismatchError();
      if (projectBudgetCurrencies.some((value) => value === currency)) {
        scopes.push({ scopeType: "project", scopeId: context.projectId });
        budgetScopeType = "project";
        budgetScopeId = context.projectId;
      }
    }

    const reservationIds: string[] = [];
    const configuredScopeKeys = new Set<string>();
    if (context.budgetScopes !== undefined) {
      for (const scope of [...scopes]) {
        const currencies = await this.costs.listBudgetCurrencies(
          context.projectId,
          scope.scopeType,
          scope.scopeId,
        );
        if (
          currencies.length > 0 &&
          !currencies.some((value) => value === currency)
        )
          throw new PricingCurrencyMismatchError();
        if (currencies.some((value) => value === currency))
          configuredScopeKeys.add(`${scope.scopeType}\\0${scope.scopeId}`);
      }
    }
    const reservationInputs = scopes
      .filter(
        (scope) =>
          context.budgetScopes === undefined ||
          configuredScopeKeys.has(`${scope.scopeType}\\0${scope.scopeId}`) ||
          scope.scopeType === "agent_run",
      )
      .map((scope) => ({
        id: this.ids.generate(),
        projectId: context.projectId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        currency,
        amountMicros: reservedMicros,
        ...(context.agentRunId === undefined
          ? {}
          : { agentRunId: context.agentRunId }),
        now,
        expiresAt: new Date(
          now.getTime() + (context.reservationTtlMs ?? 15 * 60_000),
        ),
      }));
    if (reservationInputs.length > 0) {
      if (budgetScopeType === undefined) {
        budgetScopeType = reservationInputs[0]!.scopeType;
        budgetScopeId = reservationInputs[0]!.scopeId;
      }
      if (this.costs.authorizeAndReserveMany !== undefined)
        await this.costs.authorizeAndReserveMany({
          reservations: reservationInputs,
        });
      else {
        const created: string[] = [];
        try {
          for (const input of reservationInputs) {
            await this.costs.authorizeAndReserve(input);
            created.push(input.id);
          }
        } catch (error) {
          await Promise.all(
            created.map((id) =>
              this.costs.releaseReservation(id, this.clock.now()),
            ),
          );
          throw error;
        }
      }
      reservationIds.push(...reservationInputs.map((input) => input.id));
    }
    const releaseReservations = async () =>
      this.releaseReservations(reservationIds);
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
        ...(reservationIds.length === 0
          ? {}
          : { reservationId: reservationIds[0], reservationIds }),
        estimated,
        actual,
        chargeBasis: "reported_usage",
        occurredAt: this.clock.now(),
      });
      received = undefined;
      if (recording === "duplicate") await releaseReservations();
      return {
        response,
        metering: {
          currency: actual.currency,
          pricingVersionId: pricing.id,
          reservedMicros: reservationIds.length === 0 ? null : reservedMicros,
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
        await releaseReservations();
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
          reservationIds,
        );
      } catch {
        // The original failure is what the caller must see.
      }
      throw error;
    }
  }

  private async releaseReservations(
    reservationIds: readonly string[],
  ): Promise<void> {
    if (reservationIds.length === 0) return;
    if (this.costs.releaseReservations !== undefined)
      await this.costs.releaseReservations(reservationIds, this.clock.now());
    else
      await Promise.all(
        reservationIds.map((id) =>
          this.costs.releaseReservation(id, this.clock.now()),
        ),
      );
  }
  private async chargeRejectedResponse(
    response: ModelResponse | null,
    request: ModelRequest,
    context: MeteredRequestContext,
    envelope: { pricing: PricingVersion; micros: bigint },
    currency: Currency,
    reservationIds: readonly string[],
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
      ...(reservationIds.length === 0
        ? {}
        : { reservationId: reservationIds[0], reservationIds }),
      estimated: charge,
      actual: charge,
      chargeBasis: "reserved_envelope",
      occurredAt: this.clock.now(),
    });
    if (recording === "duplicate" && reservationIds.length > 0)
      await this.releaseReservations(reservationIds);
  }
}

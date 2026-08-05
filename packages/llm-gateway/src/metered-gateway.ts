import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type {
  CostRepository,
  UsageContext,
} from "@ai-office/application/ports/cost-repository.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { calculateCost } from "./cost-calculator.ts";
import type { LlmProvider, ModelRequest, ModelResponse } from "./provider.ts";

export class PricingNotFoundError extends Error {
  constructor(provider: string, model: string) {
    super(`No active pricing for ${provider}/${model}`);
    this.name = "PricingNotFoundError";
  }
}
export class BudgetExceededError extends Error {
  constructor() {
    super("The configured budget does not cover this request");
    this.name = "BudgetExceededError";
  }
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
    context: UsageContext & {
      estimatedUsage: ModelResponse["usage"];
      budgetScopeId?: string;
    },
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const now = this.clock.now();
    const pricing = await this.costs.findPricing(
      this.provider.id,
      request.model,
      now,
    );
    if (pricing === null)
      throw new PricingNotFoundError(this.provider.id, request.model);
    const price = {
      currency: pricing.currency,
      inputPerMillionMicros: pricing.inputPerMillionMicros,
      cachedInputPerMillionMicros: pricing.cachedInputPerMillionMicros,
      outputPerMillionMicros: pricing.outputPerMillionMicros,
      reasoningPerMillionMicros: pricing.reasoningPerMillionMicros,
    };
    const estimate = calculateCost(context.estimatedUsage, price);
    let reservationId: string | undefined;
    if (context.budgetScopeId !== undefined) {
      const budget = await this.costs.findBudget(
        context.projectId,
        "project",
        context.budgetScopeId,
        pricing.currency,
      );
      if (
        budget === null ||
        budget.spentMicros + budget.reservedMicros + estimate.micros >
          budget.limitMicros
      )
        throw new BudgetExceededError();
      reservationId = this.ids.generate();
      await this.costs.reserve({
        id: reservationId,
        budgetId: budget.id,
        ...(context.agentRunId === undefined
          ? {}
          : { agentRunId: context.agentRunId }),
        amountMicros: estimate.micros,
        now,
      });
    }
    try {
      const response = await this.provider.complete(request, signal);
      const actual = calculateCost(response.usage, price);
      await this.costs.recordUsageAndCost({
        usageId: this.ids.generate(),
        costEventId: this.ids.generate(),
        context,
        provider: this.provider.id,
        model: request.model,
        ...(response.providerRequestId === undefined
          ? {}
          : { providerRequestId: response.providerRequestId }),
        usage: response.usage,
        pricingVersionId: pricing.id,
        ...(reservationId === undefined ? {} : { reservationId }),
        estimated: estimate,
        actual,
        occurredAt: this.clock.now(),
      });
      return response;
    } catch (error) {
      if (reservationId !== undefined)
        await this.costs.releaseReservation(reservationId, this.clock.now());
      throw error;
    }
  }
}

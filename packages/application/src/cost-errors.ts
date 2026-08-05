export class PricingNotFoundError extends Error {
  constructor(provider: string, model: string) {
    super(`No active pricing for ${provider}/${model}`);
    this.name = "PricingNotFoundError";
  }
}
export class PricingOverlapError extends Error {
  constructor(provider: string, model: string) {
    super(`Pricing interval overlaps for ${provider}/${model}`);
    this.name = "PricingOverlapError";
  }
}
export class PricingCurrencyMismatchError extends Error {
  constructor() {
    super("Fallback pricing candidates must use the same currency");
    this.name = "PricingCurrencyMismatchError";
  }
}
export class BudgetNotFoundError extends Error {
  constructor() {
    super("No matching budget was found");
    this.name = "BudgetNotFoundError";
  }
}
export class BudgetExceededError extends Error {
  constructor() {
    super("The configured budget does not cover this reservation");
    this.name = "BudgetExceededError";
  }
}
export class ReservationExpiredError extends Error {
  constructor(id: string) {
    super(`Budget reservation ${id} has expired`);
    this.name = "ReservationExpiredError";
  }
}
export class DuplicateProviderUsageError extends Error {
  constructor(provider: string, id: string) {
    super(`Usage for ${provider} request ${id} was already recorded`);
    this.name = "DuplicateProviderUsageError";
  }
}
export class MonetaryOverflowError extends Error {
  constructor() {
    super("Monetary value exceeds SQLite safe integer range");
    this.name = "MonetaryOverflowError";
  }
}

import { DomainValidationError } from "../errors.ts";

export function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string")
    throw new DomainValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new DomainValidationError(`${field} cannot be empty`);
  return normalized;
}

export function stringList(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(values))
    throw new DomainValidationError(`${field} must be a list of strings`);
  const normalized = values.map((value) => nonEmpty(value, field));
  if (new Set(normalized).size !== normalized.length)
    throw new DomainValidationError(`${field} cannot contain duplicates`);
  return normalized;
}

export function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new DomainValidationError(`${field} must be a valid date`);
  return new Date(value);
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new DomainValidationError(`${field} must be a positive safe integer`);
  return value;
}

export function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainValidationError(
      `${field} must be a non-negative safe integer`,
    );
  return value;
}

export function memoryStatus(
  value: string,
  field: string,
): "active" | "deprecated" {
  if (value !== "active" && value !== "deprecated")
    throw new DomainValidationError(`${field} must be active or deprecated`);
  return value;
}

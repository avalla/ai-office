import { DomainValidationError } from "../errors.ts";

export function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new DomainValidationError(`${field} cannot be empty`);
  return normalized;
}

export function stringList(
  values: readonly string[],
  field: string,
): readonly string[] {
  const normalized = values.map((value) => nonEmpty(value, field));
  if (new Set(normalized).size !== normalized.length)
    throw new DomainValidationError(`${field} cannot contain duplicates`);
  return normalized;
}

export function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime()))
    throw new DomainValidationError(`${field} must be a valid date`);
  return new Date(value);
}

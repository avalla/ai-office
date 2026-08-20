import { CapabilityValidationError } from "./errors.ts";

const sensitiveFieldKeys = new Set([
  "apikey",
  "authorization",
  "credential",
  "credentialref",
  "credentials",
  "password",
  "secret",
  "token",
]);

export function assertNoSensitiveFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (sensitiveFieldKeys.has(normalizedKey))
      throw new CapabilityValidationError(
        `${path} cannot contain sensitive field ${key}`,
      );
    assertNoSensitiveFields(item, `${path}.${key}`);
  }
}
